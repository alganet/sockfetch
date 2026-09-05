// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// sockfetch: a synchronous TCP socket for wasm guests, backed by fetch().
//
// The guest writes an HTTP/1.1 request into what it believes is a socket; this
// package parses those bytes, performs a real `fetch()`, and writes the
// response back as the bytes the guest expects to read. Real clients — busybox
// wget, PHP's own http:// wrapper — work unmodified, against any origin that
// allows CORS. No relay, no server, no Asyncify, no JSPI.
//
// Only HTTP can ever work here, because only HTTP can leave a browser.

export { createNet, AGAIN, SockError } from './core.mjs';
export { createPolicy } from './policy.mjs';
export { createAtomicsBackend } from './backend-atomics.mjs';
export { createRequestParser, serializeHead, redirectHead, reasonFor } from './codec.mjs';
export { createChannel, reader, writer, DEFAULT_CHUNK } from './channel.mjs';
