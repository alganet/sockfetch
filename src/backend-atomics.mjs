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

import { createChannel, reader, writer, DEFAULT_CHUNK } from './channel.mjs';

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
    // Otherwise a process with nothing left to do still waits for a thread
    // that is parked in Atomics.wait for ever.
    worker.unref();
  } else {
    worker = new Worker(url, { type: 'module' });
    worker.postMessage(payload);
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
      out.write(ENC.encode(JSON.stringify({
        method: request.method,
        url: String(request.url),
        headers: request.headers,
        credentials: request.credentials || 'omit',
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

    /** Shut the fetcher down. */
    close() {
      back.cancel();
      return worker.terminate();
    },
  };
}
