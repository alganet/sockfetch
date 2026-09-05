// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// The WASI adapter: a `net` port for a shim that owns its own file descriptors.
//
// It is nearly nothing, and that is the useful part. Where the Emscripten
// adapter has to be shaped like a WebSocket — the only seam that socket layer
// offers — a WASI shim has an fd table of its own, so it can be handed the
// connection functions directly and do the descriptor work itself. What is
// left here is one difference of vocabulary.
//
// `recv` answers `null` for "nothing yet" rather than the core's AGAIN symbol,
// so a shim can implement the contract without importing anything from this
// package to compare against. A sentinel that has to be imported is a contract
// two codebases have to agree on twice.
//
// ## recvAsync, and why it is optional
//
// A shim whose runtime has JSPI can suspend the guest's whole wasm stack at an
// import that returns a promise, instead of parking the thread it is running
// on. `recvAsync` is that import: await the network, then answer exactly as
// `recv` would.
//
// It is present only when the backend has an awaited door, and its ABSENCE is
// the signal — a shim tests for the method rather than being told, and a net
// without one behaves as it always did. So the same shim serves a session with
// JSPI and a session without, and neither has to be configured for it.
//
// What it buys is not speed. The thread a guest was parking is the thread that
// answers everything else in its worker — an editor's file reads, a preview
// frame's requests, the page's own messages — and those stop for the length of
// a download. Suspended, they do not.

import { AGAIN } from './core.mjs';

/**
 * Wrap a net for a WASI shim's `net` option.
 *
 * @param {object} net a createNet() instance
 */
export function wasiNet(net) {
  const port = {
    /** A name's address, dotted quad. See the core: it is an alias. */
    resolve(hostname) { return net.resolve(hostname); },
    connect(addr, port_) { return net.connect(addr, port_); },
    send(handle, bytes) { return net.send(handle, bytes); },
    /** Bytes, empty for EOF, or null for "the guest is still writing". */
    recv(handle, max) {
      const got = net.recv(handle, max);
      return got === AGAIN ? null : got;
    },
    poll(handle) { return net.poll(handle); },
    close(handle) { return net.close(handle); },
  };

  // Only where there is something to await. A shim reads the method's presence
  // as "this guest may suspend on a socket", so offering one that cannot
  // actually wait would be worse than offering none.
  if (typeof net.readyAsync === 'function') {
    /**
     * Bytes, awaited: the same answer `recv` gives, once it can give one.
     *
     * The wait and the answer are separate on purpose. Everything about what a
     * read MEANS — a head, then a body, then EOF; AGAIN while the guest is
     * still writing — stays in the synchronous path, which is the only copy of
     * it there is.
     */
    port.recvAsync = async (handle, max) => {
      await net.readyAsync(handle);
      return port.recv(handle, max);
    };
  }

  return port;
}
