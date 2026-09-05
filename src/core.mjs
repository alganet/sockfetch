// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// The connection table: what a guest's socket actually is here.
//
// A connection holds a request parser, a queue of bytes waiting to be read, and
// at most one response being pulled from the backend. `send` feeds the parser
// and, when a request completes, turns it into a fetch; `recv` drains the queue
// and then the response body. Nothing above this file knows about sockets and
// nothing below it knows about HTTP.

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
  if (!backend || typeof backend.fetch !== 'function') {
    throw new TypeError('sockfetch: createNet needs a backend with a fetch()');
  }

  const conns = new Map();
  let nextHandle = 1;

  const queue = (conn, bytes) => { if (bytes.length) conn.outbox.push(bytes); };

  /** Turn one parsed request into a fetch and queue what comes back. */
  function dispatch(conn, request) {
    const host = request.host || policy.nameOf(conn.addr);
    const url = policy.urlFor({ host, port: conn.port, target: request.target });
    if (!url) { conn.error = new SockError('ECONNRESET', 'no host to send this to'); return; }
    if (!policy.allow(url)) {
      conn.error = new SockError('ECONNREFUSED', `refused by policy: ${url.origin}`);
      return;
    }

    const { headers } = policy.headersFor(request.headers);
    let head;
    try {
      head = backend.fetch({
        method: request.method,
        url: policy.rewrite(url),
        headers,
        body: request.body,
        credentials: policy.credentials,
      });
    } catch (e) {
      conn.error = new SockError('ECONNRESET', (e && e.message) || String(e));
      return;
    }

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
        outbox: [],
        offset: 0,
        response: null,
        hup: false,
        error: null,
      });
      return handle;
    },

    /** Bytes from the guest. Returns how many were taken — always all of them. */
    send(handle, bytes) {
      const conn = conns.get(handle);
      if (!conn) throw new SockError('EBADF');
      if (conn.error) throw conn.error;
      let request = conn.parser.push(bytes);
      while (request) {
        if (request.error) {
          conn.error = new SockError('ECONNRESET', request.error);
          throw conn.error;
        }
        dispatch(conn, request);
        if (conn.error || conn.response || conn.hup) break;
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
        const chunk = conn.response.read();
        if (chunk === null) { conn.response = null; conn.hup = true; return EMPTY; }
        if (chunk.length <= max) return chunk;
        // The window is bigger than the guest's buffer; keep the rest.
        conn.outbox.push(chunk.subarray(max));
        return chunk.subarray(0, max);
      }
      if (conn.hup) return EMPTY;
      return AGAIN;
    },

    /** What select/poll wants to know. */
    poll(handle) {
      const conn = conns.get(handle);
      if (!conn) return { readable: false, writable: false, hup: true };
      return {
        readable: !!(conn.outbox.length || conn.response || conn.hup || conn.error),
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
