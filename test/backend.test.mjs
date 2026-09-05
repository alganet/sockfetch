// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// The whole stack against a real HTTP server, with the real worker and real
// `Atomics.wait`: what this proves is that a SYNCHRONOUS caller gets bytes back
// from an asynchronous fetch, which is the one claim the package rests on.
//
// A local server rather than the internet, so the suite is hermetic and so the
// awkward cases — a body over the buffering threshold, a redirect, a 404 — are
// arranged rather than hoped for.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createNet, AGAIN, SockError } from '../src/core.mjs';
import { createAtomicsBackend } from '../src/backend-atomics.mjs';

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

const BIG = 3 << 20;   // over the 2 MiB default threshold, so it streams

let serverWorker, port, origin, backend, net;

before(async () => {
  serverWorker = new Worker(new URL('./server.worker.mjs', import.meta.url));
  port = await new Promise((resolve, reject) => {
    serverWorker.once('message', resolve);
    serverWorker.once('error', reject);
  });
  serverWorker.unref();
  origin = `127.0.0.1:${port}`;
  backend = await createAtomicsBackend();
  net = createNet({ backend });
});

after(async () => {
  await backend.close();
  await serverWorker.terminate();
});

/** Drive one request the way a guest would, and hand back what it read. */
function exchange(path, { method = 'GET', body = '', headers = '' } = {}) {
  const fd = net.connect(net.resolve('127.0.0.1'), port);
  const length = body ? `Content-Length: ${body.length}\r\n` : '';
  net.send(fd, enc(
    `${method} ${path} HTTP/1.1\r\nHost: ${origin}\r\n${headers}${length}\r\n${body}`,
  ));
  const parts = [];
  let total = 0;
  for (;;) {
    const got = net.recv(fd, 1 << 16);
    if (got === AGAIN) throw new Error('the request was not complete');
    if (got.length === 0) break;
    parts.push(Buffer.from(got));
    total += got.length;
  }
  net.close(fd);
  return { raw: Buffer.concat(parts), total };
}

const split = (raw) => {
  const at = raw.indexOf('\r\n\r\n');
  return { head: raw.subarray(0, at).toString(), body: raw.subarray(at + 4) };
};

test('a small GET comes back whole, with a length we counted ourselves', { timeout: 20000 }, () => {
  const { head, body } = split(exchange('/small').raw);
  assert.match(head, /^HTTP\/1\.1 200 OK\r\n/);
  assert.match(head, /content-type: text\/plain/);
  assert.match(head, /Content-Length: 11\r\n/);
  assert.equal(body.toString(), 'hello world');
});

test('a body past the threshold streams, close-delimited', { timeout: 30000 }, () => {
  const { head, body } = split(exchange('/big').raw);
  assert.match(head, /^HTTP\/1\.1 200 OK\r\n/);
  assert.doesNotMatch(head, /Content-Length/,
    'we did not buffer it all, so we do not claim to know how long it is');
  assert.match(head, /Connection: close/);
  assert.equal(body.length, BIG, 'every byte arrived through a 1 MiB window');
  assert.ok(body.every((b) => b === 0x61));
});

test('a redirect is handed over rather than followed for the guest', { timeout: 20000 }, () => {
  const { head, body } = split(exchange('/redirect').raw);
  assert.match(head, /^HTTP\/1\.1 302 Found\r\n/);
  assert.match(head, new RegExp(`Location: http://${origin.replace('.', '\\.')}/small`));
  assert.equal(body.length, 0);
});

test('a 404 is a 404, with its body', { timeout: 20000 }, () => {
  const { head, body } = split(exchange('/missing').raw);
  assert.match(head, /^HTTP\/1\.1 404 Not Found\r\n/);
  assert.equal(body.toString(), 'nope');
});

test('a POST body reaches the origin', { timeout: 20000 }, () => {
  const { body } = split(exchange('/echo', { method: 'POST', body: 'ping' }).raw);
  assert.equal(body.toString(), 'POST:ping');
});

test('two requests in a row reuse the fetcher', { timeout: 20000 }, () => {
  assert.match(split(exchange('/small').raw).body.toString(), /hello/);
  assert.match(split(exchange('/small').raw).body.toString(), /hello/);
});

test('a port with nothing on it is a connection failure, not a hang', { timeout: 20000 }, () => {
  const fd = net.connect(net.resolve('127.0.0.1'), 1);
  net.send(fd, enc('GET / HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n'));
  assert.throws(() => net.recv(fd, 4096), (e) => e instanceof SockError && e.code === 'ECONNREFUSED');
  net.close(fd);
});

test('walking away mid-body does not strand the fetcher', { timeout: 30000 }, () => {
  const fd = net.connect(net.resolve('127.0.0.1'), port);
  net.send(fd, enc(`GET /big HTTP/1.1\r\nHost: ${origin}\r\n\r\n`));
  net.recv(fd, 1 << 16);        // head
  net.recv(fd, 1 << 16);        // one slice, then lose interest
  net.close(fd);
  // The proof is that the next exchange still works: a stranded fetcher would
  // be parked in Atomics.wait for a reader that never came.
  assert.match(split(exchange('/small').raw).body.toString(), /hello world/);
});
