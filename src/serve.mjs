// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// The inbound half: what a guest's LISTENING socket actually is here.
//
// Everything in core.mjs serves a guest that is a client — it writes a request
// and the host turns it into a `fetch()`. This is the mirror. The host has a
// request in hand and hands it to a guest that believes it accepted a
// connection; the guest writes a response, and the host reads it back out.
//
// The two halves share one handle space on purpose, because that is the whole
// contract an accepted connection is supposed to honour: what `accept()` gives
// back is an ORDINARY handle, and `send`, `recv`, `poll` and `close` already
// serve it. Nothing here adds a verb for reading or writing a connection.
//
// ## What this file does not own
//
// **The transport.** A guest holding the thread cannot be reached by
// `postMessage`, so how a request arrives while a server is blocked is the
// embedder's problem and not this package's — in a browser it is shared memory,
// under node it is a call on the same thread. `park` is the whole of what is
// asked for: "block this thread for up to N ms, delivering whatever you find."
// Absent, `wait` is absent too, and a server that polls will spin.
//
// **The web platform.** A request arrives as the plain object the codec already
// speaks and a response leaves as one, so nothing here touches `Request` or
// `Response`. An embedder that has those converts at its own edge, which is
// where it also knows what a URL means.

import { createResponseParser, serializeRequestHead } from './codec.mjs';
import { AGAIN, SockError } from './core.mjs';

const EMPTY = new Uint8Array(0);

/**
 * The listening sockets of one session, and the connections accepted on them.
 *
 * @param {object} options
 * @param {() => number} options.alloc the shared handle allocator — see above
 * @param {(ms: number) => void} [options.park] block, delivering inbound work
 */
export function createPorts({ alloc, park }) {
  /** handle -> { address, port, pending: [handle], since } */
  const listeners = new Map();
  /** handle -> an accepted connection */
  const conns = new Map();
  /** 'address:port' -> listener handle, so a port is taken or free, once. */
  const taken = new Map();
  const watchers = new Set();

  const keyOf = (address, port) => `${address}:${port}`;

  /**
   * Which listener a host request belongs to.
   *
   * `0.0.0.0` is "anywhere", so a server bound to it answers a request for any
   * address on that port — which is the whole reason a server binds to it. An
   * exact match wins, because a server that asked for one address said so.
   */
  const listenerFor = (port, address) => {
    if (address) {
      const exact = taken.get(keyOf(address, port));
      if (exact !== undefined) return exact;
    }
    for (const [handle, l] of listeners) {
      if (l.port !== port) continue;
      if (l.address === '0.0.0.0' || l.address === '::' || !address) return handle;
    }
    return null;
  };

  const announce = (type, l) => {
    const event = { type, address: l.address, port: l.port };
    for (const fn of watchers) {
      try { fn(event); } catch { /* a watcher's failure is a watcher's */ }
    }
  };

  /**
   * Answer the host waiting on this connection.
   *
   * Every exit runs through here — the parser completing, the guest closing,
   * the listener going away — because the one thing that must never happen is
   * a host left holding a request nothing will settle. Calling it twice is a
   * no-op, and the paths do.
   *
   * It does NOT drop the connection, and that distinction cost a test. The
   * host is finished with it; the GUEST still holds a descriptor, and a server
   * that writes one more byte after a complete response — a trailing flush, a
   * log line to the wrong fd — would get EBADF on a socket it never closed.
   * The record dies with the descriptor, in close().
   */
  const settle = (handle, answer) => {
    const conn = conns.get(handle);
    if (!conn || conn.answered) return;
    conn.answered = true;
    conn.onResponse(answer);
  };

  const inbound = (handle) => conns.get(handle);

  return {
    /** Does this handle belong to the inbound half? */
    owns(handle) { return listeners.has(handle) || conns.has(handle); },

    listen(address, port) {
      const key = keyOf(address, port);
      if (taken.has(key)) {
        throw new SockError('EADDRINUSE', `something is already listening on ${key}`);
      }
      const handle = alloc();
      const l = { address, port, pending: [], since: Date.now() };
      listeners.set(handle, l);
      taken.set(key, handle);
      announce('open', l);
      return handle;
    },

    /**
     * The next connection, or null for "nobody yet".
     *
     * Never blocks. The waiting belongs in `wait`, which is where a guest can
     * also be interrupted and where the embedder's transport gets its turn.
     */
    accept(handle) {
      const l = listeners.get(handle);
      if (!l) throw new SockError('EINVAL', 'that is not a listening socket');
      return l.pending.length ? l.pending.shift() : null;
    },

    /**
     * Park this thread until something arrives, or `ms` elapses.
     *
     * Present only when the embedder supplied a way to block — its ABSENCE is
     * what tells a shim to keep the old behaviour, exactly as `readyAsync`'s
     * does one direction over.
     */
    wait: typeof park === 'function' ? function wait(ms) { park(ms); } : undefined,

    /** What is listening, right now. Copies, so a render cannot shift. */
    ports() {
      return [...listeners.values()].map((l) => ({ address: l.address, port: l.port, since: l.since }));
    },

    /**
     * Called when a port opens or closes.
     *
     * The listener is caught up first, with an `open` for everything already
     * listening — otherwise a caller needs a `ports()` beside its subscribe and
     * a rule for which won the race, and the two orders disagree exactly when a
     * server starts during boot.
     */
    onPort(fn) {
      watchers.add(fn);
      for (const p of this.ports()) { try { fn({ type: 'open', ...p }); } catch { /* theirs */ } }
      return () => watchers.delete(fn);
    },

    /**
     * Hand a request to whatever is listening on `port`.
     *
     * Returns false when nothing is — which is a real answer and not a failure:
     * the host asked for a port that has no server, and 502 is the embedder's
     * to write because only the embedder knows what it is talking to.
     *
     * `onResponse` is SYNCHRONOUS and called exactly once, with either
     * `{ status, statusText, headers, body }` or `{ error }`. Synchronous
     * because the guest may be holding the thread when it answers: a promise
     * would settle on a microtask queue that will not run until the guest
     * yields, which for a running server is never.
     */
    deliver(port, request, onResponse) {
      const listenHandle = listenerFor(port, request && request.address);
      if (listenHandle === null) return false;
      const l = listeners.get(listenHandle);

      const body = request.body || EMPTY;
      const head = serializeRequestHead({
        method: request.method,
        target: request.target,
        headers: request.headers || [],
        host: request.host || `${l.address === '0.0.0.0' ? '127.0.0.1' : l.address}:${l.port}`,
        contentLength: body.length,
      });

      const handle = alloc();
      conns.set(handle, {
        listener: listenHandle,
        // The request, as the two reads a server makes of it: the head, then
        // the body. Queued rather than concatenated so a large upload is not
        // copied a second time on the way in.
        outbox: body.length ? [head, body] : [head],
        offset: 0,
        parser: createResponseParser(),
        onResponse,
        answered: false,
      });
      l.pending.push(handle);
      return true;
    },

    /**
     * Bytes from the guest: the response it is writing.
     *
     * A complete response settles the exchange immediately rather than waiting
     * for the guest to close — a server that keeps the descriptor open for its
     * own reasons has still answered, and the host should not be made to wait
     * for bookkeeping it cannot see.
     */
    send(handle, bytes) {
      const conn = inbound(handle);
      if (!conn) throw new SockError('EBADF');
      if (conn.answered) return bytes.length;   // it already answered; this is noise
      const answer = conn.parser.push(bytes);
      if (answer) settle(handle, answer);
      return bytes.length;
    },

    /**
     * Bytes for the guest: the request, and then nothing.
     *
     * AGAIN rather than EOF once the request is delivered, and that is the one
     * decision in this file worth arguing about. A server reading an empty
     * result would take it for a client that hung up and abandon the exchange
     * before writing anything — `php -S` closes the client on a zero-length
     * read. A real client does not close its write side either; it waits for
     * the answer. So the request ends because `Content-Length` says it does,
     * which is what {@link serializeRequestHead} guarantees is always present.
     */
    recv(handle, max) {
      const conn = inbound(handle);
      if (!conn) throw new SockError('EBADF');
      if (!conn.outbox.length) return AGAIN;
      const head = conn.outbox[0];
      const take = Math.min(max, head.length - conn.offset);
      const out = head.subarray(conn.offset, conn.offset + take);
      conn.offset += take;
      if (conn.offset >= head.length) { conn.outbox.shift(); conn.offset = 0; }
      return out;
    },

    poll(handle) {
      const l = listeners.get(handle);
      // A listening socket is readable when accept would answer, and never
      // writable — there is nothing to write to a socket nobody dialled.
      if (l) return { readable: l.pending.length > 0, writable: false, hup: false };
      const conn = inbound(handle);
      if (!conn) return { readable: false, writable: false, hup: true };
      return { readable: conn.outbox.length > 0, writable: true, hup: false };
    },

    close(handle) {
      const l = listeners.get(handle);
      if (l) {
        listeners.delete(handle);
        taken.delete(keyOf(l.address, l.port));
        // Anything this listener owes an answer for dies with it. Left alone
        // it would be a host waiting on a server that has gone.
        for (const [h, conn] of [...conns]) {
          if (conn.listener !== handle) continue;
          settle(h, { error: 'the server stopped before answering' });
          // One that was never accepted has no descriptor to be closed by, so
          // nothing else would ever drop it. One that WAS accepted is the
          // guest's until the guest closes it.
          if (l.pending.includes(h)) conns.delete(h);
        }
        l.pending.length = 0;
        announce('close', l);
        return true;
      }
      const conn = conns.get(handle);
      if (!conn) return false;
      // A close is how a response with no length of its own ends, so ask the
      // parser what it made of the bytes rather than assuming a failure.
      const answer = conn.parser.finish();
      settle(handle, answer || { error: 'the server closed without answering' });
      conns.delete(handle);
      return true;
    },

    /** Listening sockets plus live connections, for a test or a teardown. */
    get open() { return listeners.size + conns.size; },
  };
}
