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

import { AGAIN } from './core.mjs';

/**
 * Wrap a net for a WASI shim's `net` option.
 *
 * @param {object} net a createNet() instance
 */
export function wasiNet(net) {
  return {
    /** A name's address, dotted quad. See the core: it is an alias. */
    resolve(hostname) { return net.resolve(hostname); },
    connect(addr, port) { return net.connect(addr, port); },
    send(handle, bytes) { return net.send(handle, bytes); },
    /** Bytes, empty for EOF, or null for "the guest is still writing". */
    recv(handle, max) {
      const got = net.recv(handle, max);
      return got === AGAIN ? null : got;
    },
    poll(handle) { return net.poll(handle); },
    close(handle) { return net.close(handle); },
  };
}
