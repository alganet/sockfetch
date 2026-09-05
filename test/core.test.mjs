// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// The core over a STUB backend: no worker, no network, no SharedArrayBuffer.
// Everything here is about what the guest sees on its socket.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createNet, AGAIN, SockError } from '../src/core.mjs';
import { createPolicy } from '../src/policy.mjs';

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

/** A backend that answers from a script, and records what it was asked. */
function stub(...answers) {
  const calls = [];
  return {
    calls,
    fetch(request) {
      calls.push(request);
      const answer = answers.shift() || { status: 500, headers: [] };
      if (answer.error || answer.redirected) return { ...answer };
      const chunks = (answer.body || []).map(enc);
      let cancelled = false;
      return {
        status: answer.status,
        statusText: answer.statusText,
        headers: answer.headers || [],
        contentLength: answer.contentLength ?? null,
        read: () => (chunks.length ? chunks.shift() : null),
        cancel: () => { cancelled = true; },
        get cancelled() { return cancelled; },
      };
    },
  };
}

/** Read everything readable, as a guest looping on recv(2) would. */
function drain(net, fd, max = 65536) {
  let out = '';
  for (;;) {
    const got = net.recv(fd, max);
    if (got === AGAIN) return { text: out, more: true };
    if (got.length === 0) return { text: out, more: false };
    out += dec(got);
  }
}

test('a GET becomes a fetch, and the response comes back as HTTP the guest can read', () => {
  const backend = stub({
    status: 200,
    headers: [['content-type', 'text/plain']],
    contentLength: 11,
    body: ['hello ', 'world'],
  });
  const net = createNet({ backend });
  const fd = net.connect(net.resolve('pypi.org'), 443);

  net.send(fd, enc('GET /simple/flask/ HTTP/1.1\r\nHost: pypi.org\r\nUser-Agent: Wget\r\n\r\n'));
  assert.equal(backend.calls.length, 0, 'a write queues the request; the read is what sends it');

  const { text, more } = drain(net, fd);
  assert.equal(backend.calls.length, 1);
  assert.equal(String(backend.calls[0].url), 'https://pypi.org/simple/flask/');
  assert.deepEqual(backend.calls[0].headers, [], 'Host and User-Agent are both dropped');
  assert.equal(more, false, 'the body ends in EOF, as Connection: close promises');
  assert.match(text, /^HTTP\/1\.1 200 OK\r\n/);
  assert.match(text, /content-type: text\/plain/);
  assert.match(text, /Content-Length: 11/);
  assert.match(text, /\r\n\r\nhello world$/);
});

test('nothing is readable until the request is whole', () => {
  const net = createNet({ backend: stub({ status: 200, headers: [], body: ['x'] }) });
  const fd = net.connect(net.resolve('h.test'), 80);
  net.send(fd, enc('GET / HTTP/1.1\r\nHost: h.test\r\n'));
  assert.equal(net.recv(fd, 100), AGAIN);
  assert.deepEqual(net.poll(fd), { readable: false, writable: true, hup: false });
  net.send(fd, enc('\r\n'));
  assert.equal(net.poll(fd).readable, true);
});

test('a redirect reaches the guest as a 302 it can act on', () => {
  const backend = stub({ redirected: true, location: 'https://files.test/packages/ab/x.whl' });
  const net = createNet({ backend });
  const fd = net.connect(net.resolve('files.test'), 443);
  net.send(fd, enc('GET /source/x HTTP/1.1\r\nHost: files.test\r\n\r\n'));

  const { text } = drain(net, fd);
  assert.match(text, /^HTTP\/1\.1 302 Found\r\n/);
  assert.match(text, /Location: https:\/\/files\.test\/packages\/ab\/x\.whl/);
  assert.doesNotMatch(text, /whl\r\n\r\n./, 'the body of the redirect target is not smuggled in');
});

test('a redirected POST is followed for the guest, not handed back', () => {
  // The other half of the redirect rule. A synthesized 302 tells the guest to
  // re-request somewhere, and every client re-requests a 302 as a GET — so on
  // a POST that would silently change the method when the real chain (a 307,
  // say) preserved it. The decision is the fetcher's, since that is where the
  // method is known; a POST therefore never arrives here marked `redirected`,
  // and what comes back is the followed response.
  const backend = stub({ status: 201, headers: [], body: ['made'] });
  const net = createNet({ backend });
  const fd = net.connect(net.resolve('h.test'), 80);
  net.send(fd, enc('POST /x HTTP/1.1\r\nHost: h.test\r\nContent-Length: 2\r\n\r\nhi'));
  const { text } = drain(net, fd);
  assert.match(text, /^HTTP\/1\.1 201 Created/);
  assert.doesNotMatch(text, /302/);
});

test('a fetch that could not happen is a connection reset, not a fake 502', () => {
  const net = createNet({ backend: stub({ error: 'ECONNREFUSED', message: 'CORS' }) });
  const fd = net.connect(net.resolve('packagist.test'), 443);
  net.send(fd, enc('GET /p2/x.json HTTP/1.1\r\nHost: packagist.test\r\n\r\n'));
  assert.throws(() => net.recv(fd, 100), (e) => e instanceof SockError && e.code === 'ECONNREFUSED');
});

test('an origin the policy refuses never reaches the backend', () => {
  const backend = stub({ status: 200, headers: [] });
  const net = createNet({
    backend,
    policy: createPolicy({ allow: (u) => u.hostname === 'allowed.test' }),
  });
  const fd = net.connect(net.resolve('blocked.test'), 443);
  net.send(fd, enc('GET / HTTP/1.1\r\nHost: blocked.test\r\n\r\n'));
  assert.throws(() => net.recv(fd, 100), (e) => e.code === 'ECONNREFUSED');
  assert.equal(backend.calls.length, 0, 'refused before anything was asked of the network');
});

test('HEAD is answered without pulling a body that was never sent', () => {
  const net = createNet({ backend: stub({ status: 200, headers: [], contentLength: 42 }) });
  const fd = net.connect(net.resolve('h.test'), 80);
  net.send(fd, enc('HEAD / HTTP/1.1\r\nHost: h.test\r\n\r\n'));
  const { text, more } = drain(net, fd);
  assert.equal(more, false);
  assert.match(text, /Content-Length: 42\r\nConnection: close\r\n\r\n$/);
});

test('a recv smaller than the chunk keeps the remainder for the next call', () => {
  const net = createNet({ backend: stub({ status: 200, headers: [], body: ['abcdefghij'] }) });
  const fd = net.connect(net.resolve('h.test'), 80);
  net.send(fd, enc('GET / HTTP/1.1\r\nHost: h.test\r\n\r\n'));
  // Drain the head four bytes at a time, then the body the same way.
  let seen = '';
  for (;;) {
    const got = net.recv(fd, 4);
    if (got.length === 0) break;
    assert.ok(got.length <= 4);
    seen += dec(got);
  }
  assert.match(seen, /\r\n\r\nabcdefghij$/);
});

test('a POST carries its body through, once Content-Length says it is all there', () => {
  const backend = stub({ status: 201, headers: [] });
  const net = createNet({ backend });
  const fd = net.connect(net.resolve('h.test'), 80);
  net.send(fd, enc('POST /x HTTP/1.1\r\nHost: h.test\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\n'));
  assert.equal(net.recv(fd, 100), AGAIN, 'the body has not arrived yet, so there is nothing to send');
  assert.equal(backend.calls.length, 0);
  net.send(fd, enc('hello'));
  drain(net, fd);
  assert.equal(backend.calls.length, 1);
  assert.equal(dec(backend.calls[0].body), 'hello');
  assert.deepEqual(backend.calls[0].headers, [['Content-Type', 'text/plain']]);
});

test('closing mid-body cancels the response rather than leaving it pending', () => {
  const backend = stub({ status: 200, headers: [], body: ['a', 'b', 'c'] });
  const net = createNet({ backend });
  const fd = net.connect(net.resolve('h.test'), 80);
  net.send(fd, enc('GET / HTTP/1.1\r\nHost: h.test\r\n\r\n'));
  net.recv(fd, 65536);          // the head
  net.recv(fd, 65536);          // one chunk of body
  assert.equal(net.open, 1);
  net.close(fd);
  assert.equal(net.open, 0);
});

test('a connect given a hostname needs no alias to reverse', () => {
  // What an Emscripten guest does: its connect syscall turns its own DNS alias
  // back into the name before the socket is constructed, so this end is handed
  // `example.test` and not 172.29.0.1.
  const backend = stub({ status: 200, headers: [] });
  const net = createNet({ backend });
  const fd = net.connect('example.test', 443);
  net.send(fd, enc('GET /x HTTP/1.0\r\n\r\n'));
  drain(net, fd);
  assert.equal(String(backend.calls[0].url), 'https://example.test/x');
});

test('an HTTP/1.0 request with no Host falls back to the name the address stood for', () => {
  const backend = stub({ status: 200, headers: [] });
  const net = createNet({ backend });
  const addr = net.resolve('old.test');
  const fd = net.connect(addr, 80);
  net.send(fd, enc('GET /x HTTP/1.0\r\n\r\n'));
  drain(net, fd);
  assert.equal(String(backend.calls[0].url), 'http://old.test/x');
});

// ---------------------------------------------------------------------------
// One connection, one exchange — and everything the guest wrote behind it.
// ---------------------------------------------------------------------------

test('a second request written with the first is never answered in place of a later one', () => {
  // The bug this is here for did not lose a request, it MISDELIVERED one. Both
  // requests were parsed and only the first was sent; the second sat in the
  // queue until the guest wrote again, and then went out instead of what the
  // guest had just asked for. Measured: a guest that asked for /one and then
  // /three was served /one and /two, with the wrong body handed to the wrong
  // read and nothing anywhere saying so.
  const backend = stub(
    { status: 200, headers: [], contentLength: 3, body: ['one'] },
    { status: 200, headers: [], contentLength: 3, body: ['two'] },
  );
  const net = createNet({ backend });
  const fd = net.connect(net.resolve('h.test'), 80);
  net.send(fd, enc('GET /one HTTP/1.1\r\nHost: h.test\r\n\r\nGET /two HTTP/1.1\r\nHost: h.test\r\n\r\n'));

  const { text, more } = drain(net, fd);
  assert.match(text, /\r\n\r\none$/);
  assert.equal(more, false, 'Connection: close means this connection is finished');

  // And it IS finished: writing to it is writing to a closed connection, which
  // is the answer the guest was promised rather than a stale reply.
  assert.throws(() => net.send(fd, enc('GET /three HTTP/1.1\r\nHost: h.test\r\n\r\n')),
    (e) => e instanceof SockError && e.code === 'ECONNRESET');
  assert.equal(backend.calls.length, 1, '/two was dropped with the connection, not saved up');
});

test('a queued request makes the socket readable, so a poll does not park on it', () => {
  // poll() is asked before the read that would send the request. If it said
  // "not readable" the guest would wait for bytes that only its own next read
  // can cause to exist — a wait nothing wakes.
  const net = createNet({ backend: stub({ status: 200, headers: [], body: ['x'] }) });
  const fd = net.connect(net.resolve('h.test'), 80);
  net.send(fd, enc('GET / HTTP/1.1\r\nHost: h.test\r\n\r\n'));
  assert.deepEqual(net.poll(fd), { readable: true, writable: true, hup: false });
});
