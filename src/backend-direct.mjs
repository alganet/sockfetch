// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// The other door: `await fetch(...)` on the guest's own thread.
//
// It exists because the guest can now yield. A runtime with JSPI suspends the
// whole wasm stack at an import that returns a promise — wasi-sh already does
// this for a shell waiting on a keystroke — so a read on a socket can await the
// network instead of parking the thread on somebody else's.
//
// What that removes is the entire apparatus the other door needs:
//
//   - no worker, and so no second entry point for a bundler to lose
//   - no SharedArrayBuffer, and so no cross-origin isolation for the network
//   - no fixed window, and so no copy in and out of one — two of the four
//     copies a body used to make between `fetch` and the guest's buffer
//   - no parked thread, and so the event loop under the guest keeps turning:
//     everything else that thread answers is answered DURING a download
//
// What it does not remove is the other door. An Emscripten guest's socket layer
// is synchronous to its bones and PHP is not built with JSPI, so a session with
// both guests wants both doors over one connection table — which is what
// `createAtomicsBackend` returning `fetchAsync` as well is for.
//
// ## One chunk ahead
//
// The core reads a body synchronously, so this holds the next chunk before the
// core asks for it: `pull()` is the await, `ready()` says whether a read can be
// answered without one, and `read()` hands over what `pull` put there. The core
// calls `readyAsync` before a read that is allowed to wait — and `ready()` is
// what stops a read that is NOT allowed to wait from mistaking "nothing
// buffered yet" for the end of the body.

import { beginExchange, DEFAULT_THRESHOLD } from './exchange.mjs';

/**
 * A backend with only the awaited door.
 *
 * @param {object} [options]
 * @param {number} [options.threshold] how much body to buffer before giving up
 *   on knowing its length (see exchange.mjs)
 */
export function createDirectBackend(options = {}) {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  return {
    fetchAsync: (request) => fetchDirect(request, threshold),
    /**
     * There is no synchronous door here, and saying so is the point.
     *
     * A guest that cannot yield needs `createAtomicsBackend()`. Falling back to
     * a blocking fetch is not something JavaScript offers, so the alternative
     * to this message is a core that returns EOF for every read.
     */
    fetch() {
      throw new Error(
        'sockfetch: createDirectBackend() can only be awaited. A guest that '
        + 'cannot suspend (no JSPI, or a shim that does not use it) needs '
        + 'createAtomicsBackend() instead.',
      );
    },
    close() { return Promise.resolve(); },
  };
}

/**
 * One exchange, awaited, as the response object the core reads.
 *
 * Exported because `createAtomicsBackend` hands its own `fetchAsync` straight
 * to it: a session with one synchronous guest and one suspending guest gets
 * both doors on one backend, over one connection table and one policy, rather
 * than two nets that happen to agree.
 */
export async function fetchDirect(request, threshold = DEFAULT_THRESHOLD) {
  const exchange = await beginExchange({ ...request, threshold });
  if (exchange.error || exchange.redirected) {
    exchange.disarm?.();
    return { ...exchange, ready: () => true, read: () => null, pull: async () => {}, cancel() {} };
  }

  const { head, held, stream, complete, arm, disarm } = exchange;
  const queue = held.slice();
  let done = complete;
  let stopped = false;

  const finish = () => { done = true; disarm(); };

  return {
    ...head,

    /** Can a read be answered right now, without awaiting? */
    ready: () => queue.length > 0 || done,

    /**
     * Put the next chunk where `read` will find it.
     *
     * The core awaits this before a read it is allowed to wait for. A no-op
     * once there is something to hand over, so the common case — a body that
     * arrived inside the threshold — never touches the network again.
     */
    async pull() {
      if (queue.length || done || stopped) return;
      try {
        const { value, done: end } = await stream.read();
        arm();
        if (end) { finish(); return; }
        queue.push(value);
      } catch {
        // A body that stops early. With the head long gone there is no second
        // one to send, and a close-delimited body that ends IS what a real
        // socket shows for a connection lost mid-response.
        finish();
      }
    },

    /** The next slice of the body, or null at its end. */
    read() {
      if (queue.length) return queue.shift();
      if (!done) finish();   // read without pull: nothing is coming on its own
      return null;
    },

    /** Stop early: the guest read what it wanted and walked away. */
    cancel() {
      if (stopped) return;
      stopped = true;
      finish();
      queue.length = 0;
      // Nothing to drain and nobody to tell — the whole point of this door is
      // that there is no second thread holding the other end of a window.
      try { stream?.cancel(); } catch { /* already done with it */ }
    },
  };
}
