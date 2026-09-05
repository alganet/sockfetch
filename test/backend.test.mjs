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
import { createPolicy } from '../src/policy.mjs';
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

test('a redirect on a POST is followed, not handed back', { timeout: 20000 }, () => {
  // The fetcher only synthesizes a 302 for GET and HEAD. On anything else it
  // follows, because a made-up 302 would turn the retry into a GET whatever
  // the real chain did.
  const { head, body } = split(exchange('/redirect', { method: 'POST', body: 'x' }).raw);
  assert.match(head, /^HTTP\/1\.1 200 OK/);
  assert.doesNotMatch(head, /Location:/);
  assert.equal(body.toString(), 'hello world');
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

test('an exchange nobody finished reading leaves nothing behind', { timeout: 30000 }, () => {
  // The interaction that was actually broken, and it broke a request LATER
  // than the one at fault. Every response is a head and a body; a caller with
  // no use for the body — an error, a redirect, a download it walked away from
  // — still has to take it, or the next exchange reads a terminator where its
  // head belongs and fails as "Unexpected end of JSON input", pointing at a
  // request that did nothing wrong.
  //
  // So: three exchanges whose bodies go unread, of all three kinds, and then
  // an ordinary one that has to be perfect.
  const fd = net.connect(net.resolve('127.0.0.1'), 1);
  net.send(fd, enc('GET / HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n'));
  assert.throws(() => net.recv(fd, 4096), (e) => e.code === 'ECONNREFUSED');
  net.close(fd);

  split(exchange('/redirect').raw);            // a redirect: body discarded

  const abandoned = net.connect(net.resolve('127.0.0.1'), port);
  net.send(abandoned, enc(`GET /big HTTP/1.1\r\nHost: ${origin}\r\n\r\n`));
  net.recv(abandoned, 1 << 16);
  net.close(abandoned);                        // a body given up on

  const { head, body } = split(exchange('/small').raw);
  assert.match(head, /^HTTP\/1\.1 200 OK\r\n/);
  assert.equal(body.toString(), 'hello world');
});

test('a server that answers nothing eventually gives up', { timeout: 20000 }, () => {
  // Without a deadline this test never returns: the thread is in Atomics.wait
  // for the whole exchange, so a silent origin is not slowness, it is the end
  // of the session — a hung tab, in a page.
  const slow = createNet({ backend, policy: createPolicy({ timeout: 250 }) });
  const fd = slow.connect(slow.resolve('127.0.0.1'), port);
  slow.send(fd, enc(`GET /silent HTTP/1.1\r\nHost: ${origin}\r\n\r\n`));
  assert.throws(() => slow.recv(fd, 4096), (e) => e.code === 'ECONNREFUSED');
  slow.close(fd);

  // And the fetcher is still usable afterwards.
  assert.match(split(exchange('/small').raw).body.toString(), /hello world/);
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

// ---------------------------------------------------------------------------
// The fetcher's own survival.
//
// Every deadline in this package runs on the fetcher's thread, and the guest is
// parked in `Atomics.wait` on a message that thread owes it. So a fetcher that
// ends is not an error the guest hears about — it is an indefinite wait with
// nothing left anywhere that could end it. These are the ways it used to end.
// ---------------------------------------------------------------------------

test('a body cut short before the head went out is a reset, not a dead thread', { timeout: 30000 }, () => {
  // Under the threshold, so the failure is still reportable as one. `fetch`
  // resolves on the headers and rejects the body read with `TypeError:
  // terminated`; that exception escaped the loop and took the thread with it.
  const fd = net.connect(net.resolve('127.0.0.1'), port);
  net.send(fd, enc(`GET /truncated HTTP/1.1\r\nHost: ${origin}\r\n\r\n`));
  assert.throws(() => net.recv(fd, 1 << 16), (e) => e instanceof SockError && e.code === 'ECONNRESET');
  net.close(fd);

  // The proof, and the only one that matters: the thread is still there.
  assert.match(split(exchange('/small').raw).body.toString(), /hello world/);
});

test('a body cut short after the head went out ends, and the fetcher lives', { timeout: 40000 }, () => {
  // Past the threshold the head is already at the guest, so there is no second
  // head to send — only the end of a body that stopped early, which is exactly
  // what a close-delimited body looks like when a real connection drops.
  const { head, body } = split(exchange('/truncated-big').raw);
  assert.match(head, /^HTTP\/1\.1 200 OK\r\n/);
  assert.doesNotMatch(head, /Content-Length/, 'it streamed, so no length was claimed');
  assert.ok(body.length >= BIG, 'everything that did arrive was handed over');

  assert.match(split(exchange('/small').raw).body.toString(), /hello world/);
});

test('a body that stops mid-stream is ended by the deadline, not waited on', { timeout: 40000 }, () => {
  // The download gets going, the head is delivered, and then the origin simply
  // stops — no reset, connection held open. The old clock covered the wait for
  // headers and was cleared the moment they arrived, so from there on nothing
  // anywhere was running that could end this; the guest parked for good.
  //
  // Re-armed per chunk, silence is what ends it, and a link that is merely slow
  // — which keeps producing chunks — is still never cut off. What the guest
  // gets is a short close-delimited body, the same thing a real socket shows.
  const stalling = createNet({ backend, policy: createPolicy({ timeout: 500 }) });
  const fd = stalling.connect(stalling.resolve('127.0.0.1'), port);
  stalling.send(fd, enc(`GET /stall HTTP/1.1\r\nHost: ${origin}\r\n\r\n`));
  let total = 0;
  for (;;) {
    const got = stalling.recv(fd, 1 << 16);
    if (got.length === 0) break;
    total += got.length;
  }
  stalling.close(fd);
  assert.ok(total > BIG, 'the head and everything that did arrive were handed over');

  assert.match(split(exchange('/small').raw).body.toString(), /hello world/);
});

test('a fetcher that never started is a rejection, not a guest parked for ever', { timeout: 20000 }, async () => {
  // The mistake this package's own README warns about: a bundler that did not
  // emit the worker leaves `workerUrl` pointing at nothing. The Worker
  // constructor succeeds anyway, and the first request used to park a guest on
  // a thread that never loaded. Setup is the only place that can wait, so it is
  // where the difference is resolved.
  await assert.rejects(
    () => createAtomicsBackend({ workerUrl: new URL('./no-such-fetcher.mjs', import.meta.url) }),
    (e) => /the fetcher did not start/.test(e.message) && /workerUrl/.test(e.message),
  );
});

test('a backend whose fetcher is gone refuses instead of parking', { timeout: 20000 }, async () => {
  // Writing into a channel whose reader has gone SUCCEEDS — the write lands in
  // shared memory and nobody ever takes it — so it is the read that follows
  // which never returns. Measured before this: four seconds with no answer and
  // no error, which is the whole session.
  const doomed = await createAtomicsBackend();
  await doomed.close();
  const head = doomed.fetch({ method: 'GET', url: 'http://127.0.0.1:1/', headers: [], timeout: 1000 });
  assert.equal(head.error, 'ECONNREFUSED');
  assert.equal(head.read(), null, 'and it is a whole response: a head AND a body');
});
