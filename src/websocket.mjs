// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// The Emscripten adapter: a class shaped like `WebSocket`, because that is the
// one seam Emscripten's socket layer already has.
//
// Emscripten emulates POSIX TCP over WebSockets by default (its SOCKFS), so a
// C program built with it — PHP included — already HAS socket(), connect(),
// send() and recv(). They compile, they run, and they dial a WebSocket that
// does not exist. Nothing needs patching; something needs to be on the other
// end of that constructor.
//
// ## Why everything here is synchronous
//
// The guest cannot yield. It calls recv(2) and expects bytes before the call
// returns, and there is no event loop turn available between the two — that is
// the whole problem Asyncify and JSPI exist to solve, and this package solves
// it by not needing one. HTTP is strictly write-then-read, so by the time the
// guest blocks on a response, the request is already complete: `send()` can do
// the exchange and hand the bytes over inline, before it returns.
//
// ## Two things the real WebSocket does that we must not
//
// `onopen` is NOT fired. SOCKFS attaches its handlers AFTER the constructor
// returns (`createPeer` builds the peer, then `handlePeerEvents` assigns
// `onopen`), so an open fired from the constructor is delivered to nobody, and
// there is no later moment we control. Instead `readyState` is OPEN from the
// start: SOCKFS's `poll()` reports POLLOUT off `readyState`, which is what
// completes the guest's connect(), and its `sendmsg` writes straight through
// instead of queueing. The only thing skipped is `handleOpen`, which flushes a
// queue that is empty for a stream socket.
//
// A zero-length message is never delivered: SOCKFS reads an empty ArrayBuffer
// as a pseudo-disconnect and drops it.
//
// ## What this adapter cannot do
//
// It buffers the whole response body. SOCKFS's `poll()` knows only about
// `sock.recv_queue`, and this class has no reference to that socket — only the
// handler closure — so anything not pushed during `send()` is invisible to the
// guest and it would block for ever waiting on it. The fetcher still streams
// through a fixed window, so nothing has to allocate the body twice; but the
// guest-side peak is one response. The WASI adapter owns its fd table and has
// no such limit.

import { AGAIN } from './core.mjs';

/**
 * Build the class for a given net.
 *
 * A factory rather than a class because the net is per-session and the
 * constructor signature belongs to Emscripten.
 *
 * @param {object} net a createNet() instance
 * @param {object} [options]
 * @param {(message: string) => void} [options.warn] where a protocol
 *   complaint goes; defaults to nothing
 */
export function createSocketClass(net, options = {}) {
  const warn = options.warn || (() => {});

  return withConstants(class SockfetchSocket {
    constructor(url) {
      // SOCKFS builds `ws://<address>:<port>` from the sockaddr the guest
      // connected to, and parses it back out again on the other side; we are
      // the only thing in between, so this is simply where the address is.
      const match = /^wss?:\/\/([^:/]+):(\d+)/.exec(String(url));
      if (!match) throw new Error(`sockfetch: cannot read an address out of ${url}`);

      this.url = String(url);
      this.binaryType = 'arraybuffer';
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      this._listeners = new Map();
      this._closed = false;

      // Open on arrival — see the note above. `connect()` here cannot fail:
      // there is nothing to reach until the guest writes a request.
      this.readyState = SockfetchSocket.OPEN;
      this._fd = net.connect(match[1], Number(match[2]));
    }

    /** The guest wrote to its socket. Everything happens here. */
    send(data) {
      if (this._closed) return;
      const bytes = data instanceof Uint8Array ? data
        : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);

      try {
        net.send(this._fd, bytes);
      } catch (e) {
        this._fail(e);
        return;
      }
      this._drain();
    }

    /**
     * Hand the guest everything there is, then the end of the connection.
     *
     * Loops to exhaustion rather than delivering one chunk: see the buffering
     * note at the top — what is not delivered now can never be asked for.
     */
    _drain() {
      for (;;) {
        let got;
        try {
          got = net.recv(this._fd, 1 << 20);
        } catch (e) {
          this._fail(e);
          return;
        }
        // The request is not finished; the guest is still writing it.
        if (got === AGAIN) return;
        if (got.length === 0) { this._hangup(); return; }
        this._deliver(got);
      }
    }

    _deliver(bytes) {
      // Copied, because `recv` hands back a view over a buffer we go on using
      // and SOCKFS keeps what it is given.
      const buffer = new Uint8Array(bytes).buffer;
      this._emit('message', buffer, true);
    }

    _fail(error) {
      warn(`sockfetch: ${error.code || 'EIO'}: ${error.message}`);
      this.readyState = SockfetchSocket.CLOSED;
      this._closed = true;
      // SOCKFS reads any error as ECONNREFUSED and stores it for the guest's
      // getsockopt(SO_ERROR) — which is as much as the browser told us, too.
      this._emit('error', error);
      this._emit('close');
    }

    _hangup() {
      this.readyState = SockfetchSocket.CLOSED;
      this._closed = true;
      this._emit('close');
    }

    /** Both event shapes at once: `on*` for the browser, `on()` for Node's ws. */
    _emit(type, payload, isBinary) {
      const handler = this[`on${type}`];
      if (typeof handler === 'function') {
        handler.call(this, type === 'message' ? { data: payload } : payload);
      }
      const listeners = this._listeners.get(type);
      if (listeners) {
        for (const fn of listeners) {
          fn.call(this, type === 'message' ? payload : payload, isBinary);
        }
      }
    }

    close() {
      if (!this._closed) {
        this._closed = true;
        this.readyState = SockfetchSocket.CLOSED;
        net.close(this._fd);
        this._emit('close');
      }
    }

    // Node's `ws` is an EventEmitter and SOCKFS uses that branch under Node.
    on(type, fn) {
      const list = this._listeners.get(type) || [];
      list.push(fn);
      this._listeners.set(type, list);
      return this;
    }

    addEventListener(type, fn) { return this.on(type, fn); }

    removeEventListener(type, fn) {
      const list = this._listeners.get(type);
      if (list) this._listeners.set(type, list.filter((f) => f !== fn));
    }

    /**
     * Hand the guest whatever is waiting, now.
     *
     * `send()` calls this for a connection the guest DIALLED, because there the
     * bytes only ever exist as an answer to something written. A connection the
     * guest ACCEPTED receives first — the request is there before it writes a
     * word — and there is no send() to hang the delivery off, so whoever built
     * the peer calls this once SOCKFS has attached its handlers.
     *
     * Not the constructor's job, and it cannot be: `createPeer` assigns
     * `onmessage` after the peer object exists, so anything delivered before
     * that is delivered to nobody.
     */
    pump() { this._drain(); }

    /**
     * The next connection on a listening handle, already wrapped — or null.
     *
     * A static on the class rather than a free function because it needs the
     * net, and the class is the thing that already has it. An adapter driving
     * SOCKFS then needs no second import and no view about how a duck is
     * built: it asks for the next peer and pushes it where SOCKFS looks.
     */
    static accepted(listenHandle, peer) {
      const handle = net.accept(listenHandle);
      if (handle === null || handle === undefined) return null;
      return acceptedSocket(this, handle, peer);
    }
  });
}

/**
 * A connection somebody dialled US, wrapped for SOCKFS — the mirror of the
 * constructor above.
 *
 * It does not dial, because there is nothing to dial: `net.accept()` already
 * handed back a live handle. Everything else about the object is identical,
 * which is what lets SOCKFS's own `accept` and `recvmsg` serve it unchanged.
 *
 * `_socket` is the one field a dialled socket never has. SOCKFS's `createPeer`
 * branches on it to name the remote end of a peer it did not construct
 * (`ws._socket.remoteAddress`), and without it the peer is built from `ws.url`
 * instead — a path that throws on anything that is not `ws://host:port`. There
 * is no wire and so no real remote address; loopback is the honest answer, and
 * it is what the guest would see from a client on the same machine anyway.
 *
 * @param {Function} SocketClass what createSocketClass() returned
 * @param {unknown} handle from net.accept()
 * @param {{address?: string, port?: number}} [peer]
 */
export function acceptedSocket(SocketClass, handle, peer = {}) {
  const address = peer.address || '127.0.0.1';
  const port = peer.port || 0;
  const sock = Object.create(SocketClass.prototype);
  sock.url = `ws://${address}:${port}`;
  sock.binaryType = 'arraybuffer';
  sock.onopen = null;
  sock.onmessage = null;
  sock.onerror = null;
  sock.onclose = null;
  sock._listeners = new Map();
  sock._closed = false;
  // OPEN from the start, for the reason the constructor gives: SOCKFS reports
  // writability off readyState, and there is no later moment we control.
  sock.readyState = SocketClass.OPEN;
  sock._fd = handle;
  sock._socket = { remoteAddress: address, remotePort: port };
  return sock;
}

// The readyState constants. SOCKFS reads them off the INSTANCE
// (`dest.socket.OPEN`), so they must be on the prototype and not statics alone.
const READY_STATES = [['CONNECTING', 0], ['OPEN', 1], ['CLOSING', 2], ['CLOSED', 3]];

function withConstants(Class) {
  for (const [name, value] of READY_STATES) {
    Object.defineProperty(Class, name, { value });
    Object.defineProperty(Class.prototype, name, { value });
  }
  return Class;
}
