// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// The inbound half: a guest that is a SERVER, and the host that hands it work.
//
// Against createNet directly, with a backend that is never asked for anything —
// the outbound door is not what these are about, but it has to be there, and
// having it there is also how the shared handle space gets exercised.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createNet } from '../src/core.mjs';
import { serializeRequestHead, createResponseParser } from '../src/codec.mjs';

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

/** A net whose outbound door exists and is never used. */
const makeNet = (park) => createNet({ backend: { fetch: () => { throw new Error('not this half'); } }, park });

/** Read everything the guest can currently see on a connection. */
function drain(net, handle) {
  let out = '';
  for (;;) {
    const got = net.recv(handle, 4096);
    if (typeof got === 'symbol' || got.length === 0) return out;
    out += dec(got);
  }
}

/** listen, deliver one request, accept it. Returns the pieces. */
function exchange(net, request = { method: 'GET', target: '/' }) {
  const listener = net.listen('0.0.0.0', 8000);
  const answers = [];
  const took = net.deliver(8000, request, (a) => answers.push(a));
  const conn = net.accept(listener);
  return { listener, conn, answers, took };
}

test('a port can be taken, and only once', () => {
  const net = makeNet();
  net.listen('0.0.0.0', 8000);
  assert.throws(() => net.listen('0.0.0.0', 8000), (e) => e.code === 'EADDRINUSE');
  // A different address is a different port in the only sense that matters.
  assert.ok(net.listen('127.0.0.1', 8000));
});

test('closing a listener gives the port back', () => {
  const net = makeNet();
  const h = net.listen('0.0.0.0', 8000);
  net.close(h);
  assert.ok(net.listen('0.0.0.0', 8000), 'it binds again');
});

test('a request for a port nobody has is refused, not queued', () => {
  const net = makeNet();
  assert.equal(net.deliver(8000, { method: 'GET', target: '/' }, () => {}), false);
});

test('a server bound to 0.0.0.0 answers for any address', () => {
  const net = makeNet();
  net.listen('0.0.0.0', 8000);
  assert.equal(net.deliver(8000, { method: 'GET', target: '/', address: '127.0.0.1' }, () => {}), true);
});

test('an exact bind wins over the wildcard', () => {
  const net = makeNet();
  const wild = net.listen('0.0.0.0', 8000);
  const exact = net.listen('127.0.0.1', 8000);
  net.deliver(8000, { method: 'GET', target: '/', address: '127.0.0.1' }, () => {});
  assert.equal(net.accept(wild), null, 'the wildcard did not take it');
  assert.ok(net.accept(exact) !== null);
});

test('accept hands back nothing until somebody arrives', () => {
  const net = makeNet();
  const listener = net.listen('0.0.0.0', 8000);
  assert.equal(net.accept(listener), null);
  net.deliver(8000, { method: 'GET', target: '/' }, () => {});
  assert.ok(net.accept(listener) !== null);
  assert.equal(net.accept(listener), null, 'and only the one');
});

test('accept on something that is not listening refuses', () => {
  const net = makeNet();
  assert.throws(() => net.accept(999), (e) => e.code === 'EINVAL');
});

test('the guest reads a well-formed request', () => {
  const net = makeNet();
  const { conn } = exchange(net, {
    method: 'POST', target: '/submit', headers: [['X-Thing', 'yes']], body: enc('name=x'),
  });
  const text = drain(net, conn);
  assert.match(text, /^POST \/submit HTTP\/1\.1\r\n/);
  assert.match(text, /\r\nHost: 127\.0\.0\.1:8000\r\n/);
  assert.match(text, /\r\nX-Thing: yes\r\n/);
  assert.match(text, /\r\nContent-Length: 6\r\n/);
  assert.match(text, /\r\nConnection: close\r\n\r\nname=x$/);
});

test('the request ends by its length, never by an EOF', () => {
  // A server reading zero bytes takes it for a client that hung up: php -S
  // closes the client on one. So a drained request is AGAIN, and Content-Length
  // is what says the request is over.
  const net = makeNet();
  const { conn } = exchange(net);
  drain(net, conn);
  assert.equal(typeof net.recv(conn, 4096), 'symbol', 'AGAIN, not an empty read');
});

test('a response the guest writes comes back whole', () => {
  const net = makeNet();
  const { conn, answers } = exchange(net);
  drain(net, conn);
  net.send(conn, enc('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5\r\n\r\nhello'));
  assert.equal(answers.length, 1);
  assert.equal(answers[0].status, 200);
  assert.equal(answers[0].statusText, 'OK');
  assert.deepEqual(answers[0].headers, [['Content-Type', 'text/html'], ['Content-Length', '5']]);
  assert.equal(dec(answers[0].body), 'hello');
});

test('a response written in pieces is still one response', () => {
  const net = makeNet();
  const { conn, answers } = exchange(net);
  drain(net, conn);
  net.send(conn, enc('HTTP/1.1 404 Not Fo'));
  net.send(conn, enc('und\r\nContent-Length: 3\r\n'));
  assert.equal(answers.length, 0, 'not yet');
  net.send(conn, enc('\r\nnah'));
  assert.equal(answers[0].status, 404);
  assert.equal(dec(answers[0].body), 'nah');
});

test('a response with no length ends when the guest closes', () => {
  // What php -S does for dynamic output: Connection: close and nothing else.
  const net = makeNet();
  const { conn, answers } = exchange(net);
  drain(net, conn);
  net.send(conn, enc('HTTP/1.1 200 OK\r\n\r\n<h1>dynamic</h1>'));
  assert.equal(answers.length, 0, 'nothing says it is over yet');
  net.close(conn);
  assert.equal(dec(answers[0].body), '<h1>dynamic</h1>');
});

test('a chunked response is decoded', () => {
  const net = makeNet();
  const { conn, answers } = exchange(net);
  drain(net, conn);
  net.send(conn, enc('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n'
    + '5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n'));
  assert.equal(dec(answers[0].body), 'hello world');
});

test('a 204 carries no body and does not wait for one', () => {
  const net = makeNet();
  const { conn, answers } = exchange(net);
  drain(net, conn);
  net.send(conn, enc('HTTP/1.1 204 No Content\r\n\r\n'));
  assert.equal(answers[0].status, 204);
  assert.equal(answers[0].body.length, 0);
});

test('a server that stops mid-response says so rather than lying', () => {
  const net = makeNet();
  const { conn, answers } = exchange(net);
  drain(net, conn);
  net.send(conn, enc('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort'));
  net.close(conn);
  assert.match(answers[0].error, /closed before the response was complete/);
});

test('garbage from the guest is an error, not a response', () => {
  const net = makeNet();
  const { conn, answers } = exchange(net);
  drain(net, conn);
  net.send(conn, enc('this is not HTTP at all\r\n\r\n'));
  assert.ok(answers[0].error);
});

test('a host is never left holding a request nothing answers', () => {
  // The listener going away has to settle everything it accepted, or the
  // embedder waits for a server that has gone.
  const net = makeNet();
  const { listener, answers } = exchange(net);
  net.close(listener);
  assert.equal(answers.length, 1);
  assert.match(answers[0].error, /stopped before answering/);
});

test('a request accepted but never taken is settled too', () => {
  const net = makeNet();
  const listener = net.listen('0.0.0.0', 8000);
  const answers = [];
  net.deliver(8000, { method: 'GET', target: '/' }, (a) => answers.push(a));
  net.close(listener);                       // never accepted
  assert.match(answers[0].error, /stopped before answering/);
});

test('an answer is delivered exactly once', () => {
  const net = makeNet();
  const { conn, answers } = exchange(net);
  drain(net, conn);
  net.send(conn, enc('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi'));
  net.send(conn, enc('leftovers nobody asked for'));
  net.close(conn);
  assert.equal(answers.length, 1);
});

test('poll tells a listener from a connection', () => {
  const net = makeNet();
  const listener = net.listen('0.0.0.0', 8000);
  assert.deepEqual(net.poll(listener), { readable: false, writable: false, hup: false });
  net.deliver(8000, { method: 'GET', target: '/' }, () => {});
  assert.equal(net.poll(listener).readable, true, 'accept would answer');

  const conn = net.accept(listener);
  assert.equal(net.poll(conn).readable, true, 'the request is there to read');
  assert.equal(net.poll(conn).writable, true);
  drain(net, conn);
  assert.equal(net.poll(conn).readable, false);
});

test('wait is there only when the embedder can block', () => {
  // Its ABSENCE is the signal, exactly as readyAsync's is one direction over.
  assert.equal(makeNet().wait, undefined);
  const waited = [];
  const net = makeNet((ms) => waited.push(ms));
  net.wait(50);
  assert.deepEqual(waited, [50]);
});

test('ports() is what is listening, and onPort catches a watcher up', () => {
  const net = makeNet();
  net.listen('0.0.0.0', 8000);
  const seen = [];
  net.onPort((e) => seen.push(`${e.type} ${e.address}:${e.port}`));
  assert.deepEqual(seen, ['open 0.0.0.0:8000']);

  const second = net.listen('127.0.0.1', 5173);
  assert.deepEqual(net.ports().map((p) => p.port).sort(), [5173, 8000]);
  net.close(second);
  assert.deepEqual(seen, ['open 0.0.0.0:8000', 'open 127.0.0.1:5173', 'close 127.0.0.1:5173']);
  assert.deepEqual(net.ports().map((p) => p.port), [8000]);
});

test('both halves share one handle space', () => {
  // What accept() gives back has to be something the ordinary verbs serve, so
  // an outbound handle and an inbound one can never collide.
  const net = makeNet();
  const outbound = net.connect('172.29.0.1', 80);
  const listener = net.listen('0.0.0.0', 8000);
  net.deliver(8000, { method: 'GET', target: '/' }, () => {});
  const conn = net.accept(listener);
  assert.equal(new Set([outbound, listener, conn]).size, 3);
  assert.equal(net.open, 3);
});

// ─── the codec, on its own ───────────────────────────────────────────────────

test('a serialized request recomputes the length it was given wrongly', () => {
  const head = dec(serializeRequestHead({
    method: 'POST', target: '/x', host: 'h:1',
    headers: [['Content-Length', '999'], ['Transfer-Encoding', 'chunked']],
    contentLength: 4,
  }));
  assert.match(head, /\r\nContent-Length: 4\r\n/);
  assert.doesNotMatch(head, /999/);
  assert.doesNotMatch(head, /chunked/);
});

test('a caller that has a Host keeps it', () => {
  const head = dec(serializeRequestHead({ target: '/', host: 'fallback:1', headers: [['Host', 'real.test']] }));
  assert.match(head, /\r\nHost: real\.test\r\n/);
  assert.doesNotMatch(head, /fallback/);
});

test('a response parser reports a close with nothing at all as nothing', () => {
  assert.equal(createResponseParser().finish(), null);
});

// ─── the Emscripten adapter, serving ─────────────────────────────────────────

test('an accepted socket looks to SOCKFS like a peer it did not construct', async () => {
  const { createSocketClass, acceptedSocket } = await import('../src/websocket.mjs');
  const net = makeNet();
  const Socket = createSocketClass(net);
  const listener = net.listen('0.0.0.0', 8000);

  const answers = [];
  net.deliver(8000, { method: 'GET', target: '/hi' }, (a) => answers.push(a));
  const handle = net.accept(listener);

  const sock = acceptedSocket(Socket, handle, { address: '127.0.0.1', port: 51234 });
  // The field createPeer reads to name a remote end it did not dial.
  assert.deepEqual(sock._socket, { remoteAddress: '127.0.0.1', remotePort: 51234 });
  assert.equal(sock.readyState, Socket.OPEN, 'writable from the start');
  assert.equal(sock.binaryType, 'arraybuffer');

  // SOCKFS attaches its handler AFTER the peer exists, which is why delivery is
  // pumped rather than done in a constructor.
  const seen = [];
  sock.onmessage = (e) => seen.push(dec(new Uint8Array(e.data)));
  sock.pump();
  assert.match(seen.join(''), /^GET \/hi HTTP\/1\.1\r\n/);

  sock.send(enc('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'));
  assert.equal(answers[0].status, 200);
  assert.equal(dec(answers[0].body), 'ok');
});

test('an accepted socket closing ends the exchange', async () => {
  const { createSocketClass, acceptedSocket } = await import('../src/websocket.mjs');
  const net = makeNet();
  const Socket = createSocketClass(net);
  const listener = net.listen('0.0.0.0', 8000);
  const answers = [];
  net.deliver(8000, { method: 'GET', target: '/' }, (a) => answers.push(a));
  const sock = acceptedSocket(Socket, net.accept(listener));
  sock.onmessage = () => {};
  sock.pump();
  sock.send(enc('HTTP/1.1 200 OK\r\n\r\nno length here'));
  assert.equal(answers.length, 0);
  sock.close();
  assert.equal(dec(answers[0].body), 'no length here');
});
