// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// The guest's end of the pair: `fetch(request)` returns a response HEAD
// synchronously, and its body a chunk at a time, also synchronously.
//
// One implementation for the browser and for Node, deliberately: phasm's own
// test suite runs under Node, where no synchronous HTTP exists at all, so a
// browser-only backend would leave the thing untestable where it is developed.
// Both get there the same way — a worker that awaits, and `Atomics.wait` on
// this side.

import { createChannel, reader, writer, DEFAULT_CHUNK, READY } from './channel.mjs';
import { fetchDirect } from './backend-direct.mjs';

const ENC = new TextEncoder();
const DEC = new TextDecoder();
const EMPTY = new Uint8Array(0);

const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);

/**
 * Start the fetcher and return the backend the core talks to.
 *
 * Async because spawning a worker is, and because it must be finished before a
 * guest is allowed to run: from then on every call into here is synchronous and
 * there is nowhere left to await.
 *
 * @param {object} [options]
 * @param {number} [options.chunk] the shared window, in bytes
 * @param {number} [options.threshold] how much body to buffer before giving up
 *   on knowing its length (see the fetcher)
 * @param {URL|string} [options.workerUrl] override where the fetcher lives —
 *   for a bundler that rewrote it
 */
export async function createAtomicsBackend(options = {}) {
  if (typeof SharedArrayBuffer === 'undefined') {
    throw new Error(
      'sockfetch: no SharedArrayBuffer. In a page this means the document is '
      + 'not cross-origin isolated (COOP + COEP); there is no fallback here.',
    );
  }

  const chunk = options.chunk || DEFAULT_CHUNK;
  const up = createChannel(chunk);
  const down = createChannel(chunk);
  const url = options.workerUrl || new URL('./fetcher.worker.mjs', import.meta.url);
  const payload = { up, down, threshold: options.threshold };

  let worker;
  if (isNode) {
    const { Worker } = await import('node:worker_threads');
    worker = new Worker(url, { workerData: payload });
  } else {
    worker = new Worker(url, { type: 'module' });
    worker.postMessage(payload);
  }

  // Nothing may park on this fetcher until it says it exists.
  //
  // The failure this closes is the one the README warns about and could not
  // detect: a `workerUrl` a bundler rewrote points at nothing, the Worker
  // constructor succeeds anyway, and the FIRST request parks a guest on a
  // thread that never loaded — with no deadline on that side, because every
  // deadline in this package runs on the thread that is missing.
  //
  // Setup is the only place that can wait, and it is already async. So this is
  // where the difference between "parked and ready" and "never started" is
  // resolved, once, into a promise a caller can catch — which is exactly the
  // shape an embedder needs to say "no network this session" instead of hanging.
  await started(worker);

  // After the handshake, never before it: an unref'd worker does not hold the
  // event loop open, so unreffing first is a process that exits while it is
  // still waiting to hear that its fetcher came up. The reason it is wanted at
  // all is the other end of the same fact — a process with nothing left to do
  // should not wait on a thread parked in Atomics.wait for ever.
  if (isNode) worker.unref();

  // A fetcher that ends after that is a fetcher nothing can wait on either.
  // It should be impossible — the loop answers its own exceptions now — so
  // this is here for the ways a thread can end that no `catch` covers:
  // terminate(), an out-of-memory, an engine that gave up.
  //
  // It cannot wake a guest that is ALREADY parked: this handler runs on the
  // event loop of the thread that would have to run it, and that thread is the
  // one in Atomics.wait. What it can do is refuse the next call instead of
  // swallowing it, so a session that lost its fetcher reports connection
  // failures rather than freezing one command at a time.
  let dead = null;
  const died = (why) => { dead = dead || why; };
  if (isNode) {
    worker.on('error', (e) => died((e && e.message) || String(e)));
    worker.on('exit', (code) => died(`the fetcher thread exited (${code})`));
  } else {
    worker.addEventListener('error', (e) => died((e && e.message) || 'the fetcher thread failed'));
  }

  const out = writer(up);
  const back = reader(down);

  return {
    /**
     * Ask for one request. Returns the head; `read()` pulls the body.
     *
     * @param {{method: string, url: string, headers: [string,string][],
     *          body?: Uint8Array, credentials?: string}} request
     */
    fetch(request) {
      // Answered rather than attempted: writing into a channel whose reader is
      // gone succeeds, and the read that follows it never returns.
      if (dead) return { error: 'ECONNREFUSED', message: `sockfetch: ${dead}`, read: () => null, cancel() {} };
      out.write(ENC.encode(JSON.stringify({
        method: request.method,
        url: String(request.url),
        headers: request.headers,
        credentials: request.credentials || 'omit',
        timeout: request.timeout,
      })));
      out.write(request.body && request.body.length ? request.body : EMPTY);

      const head = JSON.parse(DEC.decode(back.readAll()));
      // Every response is a head AND a body, always, so a caller that has no
      // use for the body still has to take it. An error and a redirect both
      // carry an empty one, and leaving either in the channel means the NEXT
      // exchange reads a terminator where its head should be — which arrives
      // as "Unexpected end of JSON input" one request later, nowhere near the
      // request that caused it.
      let done = !!(head.error || head.redirected);
      if (done) back.readAll();

      return {
        ...head,
        /** The next slice of the body, or null at its end. */
        read() {
          if (done) return null;
          const { bytes, last } = back.read();
          if (last) done = true;
          return bytes.length ? bytes : null;
        },
        /**
         * Stop early.
         *
         * The rest of the body is drained rather than abandoned. The fetcher
         * stops producing as soon as it sees the cancel and then terminates
         * the message, so this reads a little and returns — and the channel is
         * left as clean as if the body had been wanted.
         */
        cancel() {
          if (done) return;
          done = true;
          back.cancelAndDrain();
        },
      };
    },

    /**
     * The same network, for a caller that can await it.
     *
     * Both doors on one backend, so a session with a suspending guest and a
     * synchronous one shares a connection table and a policy rather than
     * running two nets that happen to agree. Nothing here goes near the worker:
     * a caller that can await has no use for a second thread to await on, and
     * the fetch happens where it was asked for.
     */
    fetchAsync(request) { return fetchDirect(request, options.threshold); },

    /** Shut the fetcher down. */
    close() {
      dead = dead || 'the fetcher was closed';
      back.cancel();
      return worker.terminate();
    },
  };
}

/**
 * Resolve when the fetcher is serving, reject if it failed to get there.
 *
 * The fetcher posts {@link READY} synchronously, immediately before its first
 * `Atomics.wait` — so receiving it means the module loaded, took its channels
 * and is parked on them. There is no timeout here on purpose: a worker that
 * cannot start ends in `error` or `exit`, both of which are listened for, and
 * inventing a deadline would only turn a slow first load into a false negative.
 */
function started(worker) {
  return new Promise((resolve, reject) => {
    const fail = (e) => reject(new Error(
      `sockfetch: the fetcher did not start (${(e && e.message) || e}). `
      + 'A bundler that did not emit the worker is the usual cause — see '
      + 'createAtomicsBackend({ workerUrl }).',
    ));
    if (typeof worker.on === 'function') {
      worker.on('message', (m) => { if (m === READY) resolve(); });
      worker.on('error', fail);
      worker.on('exit', (code) => fail(`the fetcher thread exited (${code}) before it was ready`));
    } else {
      worker.addEventListener('message', (e) => { if (e.data === READY) resolve(); });
      worker.addEventListener('error', fail);
    }
  });
}
