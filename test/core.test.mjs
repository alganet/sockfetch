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

  assert.equal(backend.calls.length, 1);
  assert.equal(String(backend.calls[0].url), 'https://pypi.org/simple/flask/');
  assert.deepEqual(backend.calls[0].headers, [], 'Host and User-Agent are both dropped');

  const { text, more } = drain(net, fd);
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
  assert.equal(backend.calls.length, 0);
  assert.throws(() => net.recv(fd, 100), (e) => e.code === 'ECONNREFUSED');
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
  assert.equal(backend.calls.length, 0, 'the body has not arrived yet');
  net.send(fd, enc('hello'));
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
  assert.equal(String(backend.calls[0].url), 'https://example.test/x');
});

test('an HTTP/1.0 request with no Host falls back to the name the address stood for', () => {
  const backend = stub({ status: 200, headers: [] });
  const net = createNet({ backend });
  const addr = net.resolve('old.test');
  const fd = net.connect(addr, 80);
  net.send(fd, enc('GET /x HTTP/1.0\r\n\r\n'));
  assert.equal(String(backend.calls[0].url), 'http://old.test/x');
});
