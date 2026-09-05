// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// The Emscripten adapter, against a stand-in for SOCKFS.
//
// The stand-in mirrors what Emscripten's `libsockfs.js` actually does, because
// that is the contract this class has to satisfy and nothing else here checks
// it: `createPeer` constructs the socket and only THEN attaches handlers, the
// browser branch assigns `on*` properties and reads `event.data`, `poll()`
// tests `readyState` against constants taken off the INSTANCE, and received
// messages are pushed onto `sock.recv_queue`.
//
// Verified against the real thing too — php.wasm fetching over it — but that
// needs a built runtime and a network, and this does not.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createNet } from '../src/core.mjs';
import { createSocketClass } from '../src/websocket.mjs';

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

function stubBackend(answer) {
  return {
    fetch() {
      if (answer.error) return { ...answer };
      const chunks = (answer.body || []).map(enc);
      return {
        status: answer.status,
        headers: answer.headers || [],
        contentLength: answer.contentLength ?? null,
        read: () => (chunks.length ? chunks.shift() : null),
        cancel() {},
      };
    },
  };
}

/** What SOCKFS does around the constructor, in the same order. */
function sockfs(Socket, addr, port) {
  const sock = { recv_queue: [], connecting: true, error: null, closed: false };
  const ws = new Socket(`ws://${addr}:${port}`);
  ws.binaryType = 'arraybuffer';
  // handlePeerEvents, AFTER the constructor returned — the ordering that makes
  // an onopen fired from the constructor land nowhere.
  ws.onopen = () => { sock.connecting = false; };
  ws.onmessage = (event) => sock.recv_queue.push(new Uint8Array(event.data));
  ws.onerror = () => { sock.error = 'ECONNREFUSED'; };
  ws.onclose = () => { sock.closed = true; };
  sock.ws = ws;
  return sock;
}

/** SOCKFS's poll(), reduced to the parts that decide whether a guest proceeds. */
const pollable = (sock) => ({
  readable: sock.recv_queue.length > 0
    || sock.ws.readyState === sock.ws.CLOSING || sock.ws.readyState === sock.ws.CLOSED,
  writable: sock.ws.readyState === sock.ws.OPEN,
});

const drainQueue = (sock) => sock.recv_queue.splice(0).map(dec).join('');

test('the socket is writable immediately, so the guest\'s connect() completes', () => {
  const net = createNet({ backend: stubBackend({ status: 200, headers: [] }) });
  const sock = sockfs(createSocketClass(net), '172.29.0.1', 80);
  assert.equal(sock.ws.readyState, sock.ws.OPEN);
  assert.equal(pollable(sock).writable, true, 'POLLOUT is what ends a connect');
});

test('the readyState constants are on the instance, where SOCKFS reads them', () => {
  const net = createNet({ backend: stubBackend({ status: 200, headers: [] }) });
  const sock = sockfs(createSocketClass(net), '172.29.0.1', 80);
  assert.deepEqual(
    [sock.ws.CONNECTING, sock.ws.OPEN, sock.ws.CLOSING, sock.ws.CLOSED],
    [0, 1, 2, 3],
  );
});

test('send() delivers the whole response synchronously, before it returns', () => {
  const net = createNet({
    backend: stubBackend({
      status: 200, headers: [['content-type', 'text/plain']],
      contentLength: 5, body: ['hel', 'lo'],
    }),
  });
  const sock = sockfs(createSocketClass(net), '172.29.0.1', 80);

  assert.equal(pollable(sock).readable, false);
  sock.ws.send(enc('GET /x HTTP/1.1\r\nHost: h.test\r\n\r\n'));

  // No await, no event loop turn: the guest could not have yielded for one.
  const text = drainQueue(sock);
  assert.match(text, /^HTTP\/1\.1 200 OK\r\n/);
  assert.match(text, /\r\n\r\nhello$/);
  assert.equal(sock.closed, true, 'the end of the body closes it, as Connection: close says');
});

test('a half-written request delivers nothing and keeps the socket open', () => {
  const net = createNet({ backend: stubBackend({ status: 200, headers: [], body: ['x'] }) });
  const sock = sockfs(createSocketClass(net), '172.29.0.1', 80);
  sock.ws.send(enc('GET /x HTTP/1.1\r\nHost: h.test\r\n'));
  assert.equal(sock.recv_queue.length, 0);
  assert.equal(sock.closed, false);
  sock.ws.send(enc('\r\n'));
  assert.match(drainQueue(sock), /^HTTP\/1\.1 200 OK/);
});

test('a fetch that failed becomes an error and a closed socket', () => {
  const net = createNet({ backend: stubBackend({ error: 'ECONNREFUSED', message: 'CORS' }) });
  const warnings = [];
  const sock = sockfs(createSocketClass(net, { warn: (m) => warnings.push(m) }), '172.29.0.1', 443);
  sock.ws.send(enc('GET / HTTP/1.1\r\nHost: blocked.test\r\n\r\n'));
  assert.equal(sock.error, 'ECONNREFUSED');
  assert.equal(sock.ws.readyState, sock.ws.CLOSED);
  assert.equal(pollable(sock).readable, true, 'a closed peer is readable, so recv can report it');
  assert.match(warnings[0], /ECONNREFUSED/);
});

test('an empty message is never delivered — SOCKFS reads one as a disconnect', () => {
  const net = createNet({ backend: stubBackend({ status: 204, headers: [], contentLength: 0 }) });
  const sock = sockfs(createSocketClass(net), '172.29.0.1', 80);
  sock.ws.send(enc('GET / HTTP/1.1\r\nHost: h.test\r\n\r\n'));
  assert.ok(sock.recv_queue.every((m) => m.length > 0));
});

test("Node's ws shape works too: on('message', (data, isBinary))", () => {
  const net = createNet({ backend: stubBackend({ status: 200, headers: [], body: ['hi'] }) });
  const Socket = createSocketClass(net);
  const ws = new Socket('ws://172.29.0.1:80');
  const seen = [];
  ws.on('message', (data, isBinary) => seen.push([dec(data), isBinary]));
  ws.send(enc('GET / HTTP/1.1\r\nHost: h.test\r\n\r\n'));
  assert.ok(seen.length >= 1);
  assert.equal(seen[0][1], true, 'SOCKFS ignores a message that is not flagged binary');
  assert.match(seen.map(([t]) => t).join(''), /^HTTP\/1\.1 200 OK/);
});
