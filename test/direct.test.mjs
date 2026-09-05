// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// The awaited door, against the same server the parked one is tested against.
//
// What it has to prove is that the two doors are the same network: same bytes,
// same redirect rule, same failures, same policy — differing only in who waits.
// The suite deliberately re-reads the assertions of backend.test.mjs rather
// than inventing gentler ones, because a second door that quietly behaved
// differently would be worse than no second door.
//
// Nothing here needs a worker, a SharedArrayBuffer or a thread of its own, and
// the absence is the point: this door runs on the caller's own event loop.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createNet, SockError } from '../src/core.mjs';
import { createPolicy } from '../src/policy.mjs';
import { createDirectBackend } from '../src/backend-direct.mjs';
import { wasiNet } from '../src/wasi.mjs';

const enc = (s) => new TextEncoder().encode(s);

const BIG = 3 << 20;

let serverWorker, port, origin, net;

before(async () => {
  serverWorker = new Worker(new URL('./server.worker.mjs', import.meta.url));
  port = await new Promise((resolve, reject) => {
    serverWorker.once('message', resolve);
    serverWorker.once('error', reject);
  });
  serverWorker.unref();
  origin = `127.0.0.1:${port}`;
  net = createNet({ backend: createDirectBackend() });
});

after(async () => { await serverWorker.terminate(); });

/** Drive one request the way a SUSPENDING guest would: await, then read. */
async function exchange(path, { method = 'GET', body = '', net: use = net } = {}) {
  const fd = use.connect(use.resolve('127.0.0.1'), port);
  const length = body ? `Content-Length: ${body.length}\r\n` : '';
  use.send(fd, enc(`${method} ${path} HTTP/1.1\r\nHost: ${origin}\r\n${length}\r\n${body}`));
  const parts = [];
  for (;;) {
    await use.readyAsync(fd);
    const got = use.recv(fd, 1 << 16);
    if (got.length === 0) break;
    parts.push(Buffer.from(got));
  }
  use.close(fd);
  return Buffer.concat(parts);
}

const split = (raw) => {
  const at = raw.indexOf('\r\n\r\n');
  return { head: raw.subarray(0, at).toString(), body: raw.subarray(at + 4) };
};

test('a small GET comes back whole, with a length we counted ourselves', async () => {
  const { head, body } = split(await exchange('/small'));
  assert.match(head, /^HTTP\/1\.1 200 OK\r\n/);
  assert.match(head, /Content-Length: 11\r\n/);
  assert.equal(body.toString(), 'hello world');
});

test('a body past the threshold streams, one awaited chunk at a time', async () => {
  const { head, body } = split(await exchange('/big'));
  assert.doesNotMatch(head, /Content-Length/, 'we did not buffer it all, so we claim no length');
  assert.match(head, /Connection: close/);
  assert.equal(body.length, BIG, 'every byte arrived — through no window at all');
  assert.ok(body.every((b) => b === 0x61));
});

test('a redirect is handed over rather than followed, exactly as the other door does', async () => {
  const { head, body } = split(await exchange('/redirect'));
  assert.match(head, /^HTTP\/1\.1 302 Found\r\n/);
  assert.match(head, new RegExp(`Location: http://${origin.replace('.', '\\.')}/small`));
  assert.equal(body.length, 0);
});

test('a POST body reaches the origin', async () => {
  const { body } = split(await exchange('/echo', { method: 'POST', body: 'ping' }));
  assert.equal(body.toString(), 'POST:ping');
});

test('a port with nothing on it is a connection failure, not a hang', async () => {
  const fd = net.connect(net.resolve('127.0.0.1'), 1);
  net.send(fd, enc('GET / HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n'));
  await net.readyAsync(fd);
  assert.throws(() => net.recv(fd, 4096), (e) => e instanceof SockError && e.code === 'ECONNREFUSED');
  net.close(fd);
});

test('a server that answers nothing gives up on the deadline', async () => {
  const slow = createNet({ backend: createDirectBackend(), policy: createPolicy({ timeout: 250 }) });
  const fd = slow.connect(slow.resolve('127.0.0.1'), port);
  slow.send(fd, enc(`GET /silent HTTP/1.1\r\nHost: ${origin}\r\n\r\n`));
  await slow.readyAsync(fd);
  assert.throws(() => slow.recv(fd, 4096), (e) => e.code === 'ECONNREFUSED');
  slow.close(fd);
});

test('a body cut short before the head is a reset here too', async () => {
  const fd = net.connect(net.resolve('127.0.0.1'), port);
  net.send(fd, enc(`GET /truncated HTTP/1.1\r\nHost: ${origin}\r\n\r\n`));
  await net.readyAsync(fd);
  assert.throws(() => net.recv(fd, 1 << 16), (e) => e.code === 'ECONNRESET');
  net.close(fd);
  // Nothing was left broken: there is no shared thread here to break.
  assert.match(split(await exchange('/small')).body.toString(), /hello world/);
});

test('a body that stops mid-stream ends, rather than being waited on', async () => {
  const stalling = createNet({ backend: createDirectBackend(), policy: createPolicy({ timeout: 400 }) });
  const raw = await exchange('/stall', { net: stalling });
  const { head, body } = split(raw);
  assert.match(head, /^HTTP\/1\.1 200 OK/);
  assert.ok(body.length >= BIG, 'everything that arrived was handed over');
});

test('walking away mid-body cancels the stream instead of draining it', async () => {
  // The other door has to READ to the end of a message it no longer wants,
  // because a chunk left in the window desynchronizes the next exchange. There
  // is no window here, so there is nothing to drain and nothing to get wrong.
  const fd = net.connect(net.resolve('127.0.0.1'), port);
  net.send(fd, enc(`GET /big HTTP/1.1\r\nHost: ${origin}\r\n\r\n`));
  await net.readyAsync(fd);
  net.recv(fd, 1 << 16);
  net.close(fd);
  assert.match(split(await exchange('/small')).body.toString(), /hello world/);
});

test('a read that did not await gets AGAIN, never a false end of body', async () => {
  // The trap this door could set. `read()` can only hand over what `pull()` put
  // there, so a core that read without awaiting would see an empty queue — and
  // an empty answer is EOF to every guest there is. It would truncate a body
  // silently, at whatever byte the last chunk happened to end on.
  const fd = net.connect(net.resolve('127.0.0.1'), port);
  net.send(fd, enc(`GET /big HTTP/1.1\r\nHost: ${origin}\r\n\r\n`));
  await net.readyAsync(fd);

  let sawAgain = false;
  const parts = [];
  for (;;) {
    const got = net.recv(fd, 1 << 16);
    if (typeof got === 'symbol') {      // AGAIN: this read needed an await
      sawAgain = true;
      await net.readyAsync(fd);
      continue;
    }
    if (got.length === 0) break;
    parts.push(Buffer.from(got));
  }
  net.close(fd);
  assert.ok(sawAgain, 'a read outrunning the stream has to say so');
  assert.equal(split(Buffer.concat(parts)).body.length, BIG, 'and nothing was lost by it');
});

test('the WASI port offers recvAsync only where there is something to await', () => {
  assert.equal(typeof wasiNet(net).recvAsync, 'function');
  // A net built on a synchronous-only backend has no async door, and its
  // absence is what a shim reads as "this guest must park".
  const parked = createNet({ backend: { fetch: () => ({ status: 204, headers: [], read: () => null, cancel() {} }) } });
  assert.equal(wasiNet(parked).recvAsync, undefined);
});

test('recvAsync answers exactly what recv would', async () => {
  const port_ = wasiNet(net);
  const fd = port_.connect(port_.resolve('127.0.0.1'), port);
  port_.send(fd, enc(`GET /small HTTP/1.1\r\nHost: ${origin}\r\n\r\n`));
  const parts = [];
  for (;;) {
    const got = await port_.recvAsync(fd, 1 << 16);
    if (got.length === 0) break;
    parts.push(Buffer.from(got));
  }
  port_.close(fd);
  assert.match(split(Buffer.concat(parts)).body.toString(), /^hello world$/);
});

test('the direct backend refuses a caller that cannot await, in words', () => {
  assert.throws(() => createDirectBackend().fetch({}), /can only be awaited/);
});
