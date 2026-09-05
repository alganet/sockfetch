// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// The connection table: what a guest's socket actually is here.
//
// A connection holds a request parser, a queue of requests waiting to go out, a
// queue of bytes waiting to be read, and at most one response being pulled from
// the backend. `send` feeds the parser; `recv` drains what is ready and, when
// there is nothing left, turns the next parsed request into a fetch. Nothing
// above this file knows about sockets and nothing below it knows about HTTP.
//
// ## Why the fetch happens in `recv` and not in `send`
//
// It used to happen inline in `send`, which HTTP allows — the exchange is
// strictly write-then-read, so the request is complete before the guest blocks
// — and which cost nothing while the only backend was a synchronous one.
//
// Two things wanted it moved. A guest that writes two requests in one `write(2)`
// had the second one PARSED and then stranded: `send` stopped at the first
// response, nothing else ever called `take()`, and a later write on the same
// connection dispatched the stale request instead of the new one. Measured: a
// guest that asked for `/one` and then `/three` was served `/one` and `/two`,
// silently, with the wrong body handed to the wrong read.
//
// And a fetch that wants to be AWAITED has to happen where a caller can wait —
// which is a read, never a write. See `readyAsync`.

import { createRequestParser, serializeHead, redirectHead, reasonFor } from './codec.mjs';
import { createPolicy } from './policy.mjs';

/** `recv` has nothing yet, and the guest asked not to block. */
export const AGAIN = Symbol('EAGAIN');

/** A failure with a POSIX name on it, for an adapter to turn into an errno. */
export class SockError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

const EMPTY = new Uint8Array(0);

/**
 * @param {object} options
 * @param {{fetch: Function}} options.backend usually createAtomicsBackend()'s
 * @param {object} [options.policy] createPolicy()'s, or one of your own
 */
export function createNet({ backend, policy = createPolicy() }) {
  const canBlock = typeof backend?.fetch === 'function';
  const canAwait = typeof backend?.fetchAsync === 'function';
  if (!canBlock && !canAwait) {
    throw new TypeError('sockfetch: createNet needs a backend with a fetch() or a fetchAsync()');
  }

  const conns = new Map();
  let nextHandle = 1;

  const queue = (conn, bytes) => { if (bytes.length) conn.outbox.push(bytes); };

  /**
   * What this request would be, as something the backend can be asked for.
   *
   * Split out from the asking so that both a synchronous backend and an
   * awaited one decide the same things in the same order — the policy sees
   * every request exactly once either way, and neither path can grow a rule
   * the other does not have.
   *
   * Returns null having set `conn.error` when the request cannot go out at all.
   */
  function plan(conn, request) {
    // The Host header, then the name an alias stood for, then whatever
    // connect() was handed. That last step is not a fallback for its own sake:
    // an Emscripten guest arrives here with a HOSTNAME rather than an address
    // — its connect syscall reverses its own DNS alias before the socket is
    // built — so there is nothing for `nameOf` to look up and the right answer
    // is already in hand. A raw IP lands here too, and connecting to one is a
    // thing people do.
    const host = request.host || policy.nameOf(conn.addr) || conn.addr;
    const url = policy.urlFor({ host, port: conn.port, target: request.target });
    if (!url) { conn.error = new SockError('ECONNRESET', 'no host to send this to'); return null; }
    if (!policy.allow(url)) {
      conn.error = new SockError('ECONNREFUSED', `refused by policy: ${url.origin}`);
      return null;
    }

    const { headers } = policy.headersFor(request.headers);
    return {
      method: request.method,
      url: policy.rewrite(url),
      headers,
      body: request.body,
      credentials: policy.credentials,
      timeout: policy.timeout,
    };
  }

  /** What the backend answered, as bytes the guest can read. */
  function deliver(conn, request, head) {
    if (head.error) {
      conn.error = new SockError(head.error, head.message);
      return;
    }

    // A redirect the guest gets to decide about — see codec.redirectHead. The
    // GET/HEAD test lives in the fetcher, which is where the method is known;
    // anything else arrives here already followed.
    if (head.redirected) {
      queue(conn, redirectHead(head.location));
      conn.hup = true;
      return;
    }

    queue(conn, serializeHead({
      status: head.status,
      statusText: head.statusText || reasonFor(head.status),
      headers: head.headers,
      contentLength: head.contentLength,
    }));
    // HEAD has no body to pull, and asking for one would block on a frame the
    // fetcher already terminated.
    conn.response = request.method === 'HEAD' ? null : head;
    if (!conn.response) conn.hup = true;
  }

  /** Is there a request waiting, and room to send it? */
  const idle = (conn) =>
    conn.pending.length && !conn.response && !conn.outbox.length && !conn.error && !conn.hup;

  /** Send the next queued request, synchronously. */
  function pump(conn) {
    if (!idle(conn)) return;
    const request = conn.pending.shift();
    const asked = plan(conn, request);
    if (!asked) return;
    let head;
    try { head = backend.fetch(asked); }
    catch (e) { conn.error = new SockError('ECONNRESET', (e && e.message) || String(e)); return; }
    deliver(conn, request, head);
  }

  /** The same, awaited. See `readyAsync` for who calls it and why. */
  async function pumpAsync(conn) {
    if (!idle(conn)) return;
    const request = conn.pending.shift();
    const asked = plan(conn, request);
    if (!asked) return;
    let head;
    try { head = await backend.fetchAsync(asked); }
    catch (e) { conn.error = new SockError('ECONNRESET', (e && e.message) || String(e)); return; }
    deliver(conn, request, head);
  }

  /**
   * The connection is over, and everything still queued on it goes with it.
   *
   * Every response carries `Connection: close` (see the codec — a streamed body
   * has no other end marker), so one exchange is all a connection gets and the
   * guest has been told so. What must not happen is the leftovers being ANSWERED
   * later: a request parsed but never sent used to sit in the queue until the
   * guest wrote again, and then went out in place of what the guest had just
   * asked for.
   *
   * So they are dropped here, and a write after this fails as `ECONNRESET` —
   * which is what writing to a closed connection does, and what the guest was
   * promised.
   */
  function spend(conn) {
    conn.hup = true;
    conn.pending.length = 0;
    conn.parser = null;
  }

  return {
    /** A name's address. See policy.resolve — it is an alias, not a lookup. */
    resolve(hostname) { return policy.resolve(hostname); },
    /** The name an address stood for. */
    nameOf(addr) { return policy.nameOf(addr); },

    /**
     * Open a connection.
     *
     * It succeeds immediately and unconditionally, which is not optimism: there
     * is nothing to connect to yet. The destination is not known until the
     * guest writes a `Host:` header, so the first thing that can fail is the
     * request — and it fails as a reset, which is what an unreachable host
     * looks like from inside a guest anyway.
     */
    connect(addr, port) {
      const handle = nextHandle++;
      conns.set(handle, {
        addr, port,
        parser: createRequestParser(),
        pending: [],
        outbox: [],
        offset: 0,
        response: null,
        hup: false,
        error: null,
      });
      return handle;
    },

    /**
     * Bytes from the guest. Returns how many were taken — always all of them.
     *
     * Everything complete is parsed and QUEUED; nothing is sent from here. A
     * guest that writes two requests at once therefore has both of them, in
     * order, rather than one and a trap.
     */
    send(handle, bytes) {
      const conn = conns.get(handle);
      if (!conn) throw new SockError('EBADF');
      if (conn.error) throw conn.error;
      // The exchange is finished and the guest was told the connection closes.
      // Writing anyway is writing to a closed connection.
      if (conn.hup) throw new SockError('ECONNRESET', 'this connection is closed; it said so');
      let request = conn.parser.push(bytes);
      while (request) {
        if (request.error) {
          conn.error = new SockError('ECONNRESET', request.error);
          throw conn.error;
        }
        conn.pending.push(request);
        request = conn.parser.take();
      }
      return bytes.length;
    },

    /**
     * Bytes for the guest: the response head, then its body, then EOF.
     *
     * An empty result is EOF, exactly as read(2) says. AGAIN is "nothing yet",
     * which here means the guest has not finished writing its request.
     */
    recv(handle, max) {
      const conn = conns.get(handle);
      if (!conn) throw new SockError('EBADF');
      // Nothing in hand and something queued: this is where a request goes out.
      if (idle(conn)) pump(conn);
      if (conn.outbox.length) {
        const head = conn.outbox[0];
        const take = Math.min(max, head.length - conn.offset);
        const out = head.subarray(conn.offset, conn.offset + take);
        conn.offset += take;
        if (conn.offset >= head.length) { conn.outbox.shift(); conn.offset = 0; }
        return out;
      }
      // The error is raised only once the head has been delivered, so a guest
      // that got a 4xx reads it before hearing the connection went away.
      if (conn.error) throw conn.error;
      if (conn.response) {
        // A response that can only be advanced by awaiting says so. Without
        // this, a read that did NOT await would take "nothing buffered yet" for
        // the end of the body and truncate it silently — see readyAsync, which
        // is what a caller that may wait calls first. A backend with no `ready`
        // blocks inside `read` instead, which is that door's whole job.
        if (conn.response.ready && !conn.response.ready()) return AGAIN;
        const chunk = conn.response.read();
        if (chunk === null) { conn.response = null; spend(conn); return EMPTY; }
        if (chunk.length <= max) return chunk;
        // The window is bigger than the guest's buffer; keep the rest.
        conn.outbox.push(chunk.subarray(max));
        return chunk.subarray(0, max);
      }
      if (conn.hup) return EMPTY;
      return AGAIN;
    },

    /**
     * Wait until the next `recv` on this handle can answer without blocking.
     *
     * The suspending door, and the whole of it. A guest whose runtime has JSPI
     * reaches a socket read through an import that may return a promise, so the
     * awaiting happens HERE — one place, before a `recv` that is then purely
     * synchronous and unchanged.
     *
     * That is deliberately the same shape wasi-sh already uses for a shell
     * waiting on a keystroke: await the thing that can be awaited, then hand the
     * work to the synchronous implementation, which now finds it ready and
     * parks on nothing. There is no second copy of `recv` anywhere.
     *
     * Answers when there is something to read, an error to raise, or an end of
     * file — never on its own timetable. A net whose backend has no async door
     * has no `readyAsync` at all, which is how a shim tells the two apart.
     */
    readyAsync: canAwait ? async function readyAsync(handle) {
      const conn = conns.get(handle);
      if (!conn) throw new SockError('EBADF');
      // Nothing in hand and something queued: this is where the request goes
      // out, awaited rather than parked on.
      if (idle(conn)) await pumpAsync(conn);
      // A body in flight with nothing buffered: fetch the next slice of it.
      if (conn.response && conn.response.pull && !conn.response.ready()) {
        await conn.response.pull();
      }
    } : undefined,

    /** What select/poll wants to know. */
    poll(handle) {
      const conn = conns.get(handle);
      if (!conn) return { readable: false, writable: false, hup: true };
      return {
        // A queued request counts: the bytes are not here yet, but asking for
        // them is this side's work and the read that follows will do it. Saying
        // "not readable" would send the guest to a wait that nothing wakes.
        readable: !!(conn.outbox.length || conn.response || conn.pending.length
          || conn.hup || conn.error),
        // Always: a write is buffered into the parser and never blocks.
        writable: true,
        hup: conn.hup && !conn.outbox.length && !conn.response,
      };
    },

    close(handle) {
      const conn = conns.get(handle);
      if (!conn) return false;
      if (conn.response) conn.response.cancel();
      conns.delete(handle);
      return true;
    },

    /** Open connections, for a test or a teardown. */
    get open() { return conns.size; },
  };
}
