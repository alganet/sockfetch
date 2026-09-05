<!--
SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>

SPDX-License-Identifier: ISC
-->

# sockfetch

A synchronous TCP socket for wasm guests, backed by `fetch()`. Real HTTP
clients — busybox `wget`, PHP's own `http://` wrapper, `fsockopen()` — work
**unmodified**, against any origin that allows CORS. No relay, no server, no
Asyncify, no JSPI.

The guest writes an HTTP/1.1 request into what it believes is a socket. This
package parses those bytes, performs a real `fetch()`, and writes the response
back as the bytes that guest expects to read.

```
guest app  (busybox wget · PHP http:// wrapper · fsockopen)   unmodified
   │ socket/connect/send/recv/close/poll
   ▼
adapter    (sockfetch/websocket for Emscripten · sockfetch/wasi for WASI)
   ▼
core       connection table · HTTP/1.1 codec · policy
   ▼
backend    Atomics.wait + fetcher worker  →  fetch()
```

**Only HTTP crosses the boundary**, because `fetch` is the only way out of a
browser. `https://` is included and is the ordinary case — the guest speaks
plaintext and the host does the TLS, which is what the section below is about.
What cannot exist here is anything that is not HTTP: no SSH, no MySQL, no raw
TCP, and no amount of work will add them.

## Why it needs no stack switching

The guest cannot yield: it calls `recv(2)` and expects bytes before the call
returns, with no event loop turn available in between. That is the problem
Asyncify and JSPI exist to solve, and this package sidesteps it twice over.

HTTP is strictly **write-then-read**, so by the time a guest blocks on a
response its request is already complete — nothing has to be sent until the
guest reads, and the bytes can be handed over inside that read. Where a real
wait is needed, `Atomics.wait` parks the guest's thread while another thread
awaits the fetch. Neither end may be a browser's main thread; `Atomics.wait`
throws there.

## Using it

```js
import { createNet, createAtomicsBackend } from 'sockfetch';
import { createSocketClass } from 'sockfetch/websocket';

const backend = await createAtomicsBackend();
const net = createNet({ backend });

// Emscripten emulates POSIX TCP over WebSockets, so this is the whole hookup:
const php = await Phasm({ socket: createSocketClass(net) });

php.run({ code: `echo file_get_contents('https://pypi.org/simple/flask/');` });
```

For a WASI guest — one whose shim owns its own file descriptors — the adapter
is thinner still, because there is no WebSocket to imitate:

```js
import { wasiNet } from 'sockfetch/wasi';

await run({ net: wasiNet(net), args: ['wget', '-q', '-O', '-', url] });
```

`createNet({ backend, policy })` is the core. `createPolicy()` decides the
scheme, which headers survive, which origins are allowed, and what a hostname
resolves to — pass your own to front a CORS proxy or enforce an allowlist.

## TLS

There is none in the guest, deliberately. The guest is not on a wire — it is
calling a JavaScript function — and the only real wire is the host's `fetch`,
already encrypted and verified against the host's trust store. A TLS session on
top of that would encrypt a function call to itself, and satisfying one means
writing a TLS server in JavaScript.

So the guest speaks **plaintext** and the scheme comes from the port: 443
becomes `https` when the fetch is made, and the host does a real handshake
against a real trust store. Making a guest stop speaking TLS is the one part
that is per-guest work — phasm re-points PHP's `ssl://` transport at a plain
socket, busybox is built without `FEATURE_WGET_HTTPS`.

The port is all there is to go on, so a **non-standard HTTPS port** is the one
case this cannot read on its own: `https://example.org:8443/` arrives as 8443
and is indistinguishable from plain `http://example.org:8443/`. Pass
`createPolicy({ scheme })` when that matters.

The cost: the guest cannot verify certificates (the host does), and anything
promising otherwise — a pinned fingerprint, a private CA — is inert and should
say so out loud.

## Addresses

An address is unavoidable: `getaddrinfo` fills a `sockaddr_in`, `connect` takes
it back, `wget` prints it. The real one is unobtainable — the browser exposes no
resolver and `fetch` never reveals the peer.

So it is an **alias**, in `172.29.0.0/16` with a reverse map — the range
Emscripten's own DNS invents for the same problem, matched on purpose so that a
script prints the same kind of address whichever guest it runs in: an ordinary
machine behind a NAT, which is a fair description of one.

An Emscripten guest needs no allocator from here at all, and hands this end a
**hostname** rather than an address: its connect syscall reverses its own alias
before the socket is built. A WASI guest has no resolver to begin with, so
`resolve()` is where one is invented for it.

## What the guest sees, and does not

- **Redirects reach the guest.** `follow_location`, `max_redirects` and
  `--max-redirect` are its semantics, and following silently breaks them. Since
  `fetch` cannot show the real 3xx (`redirect: 'manual'` answers with an opaque
  response), a `302` carrying the final URL is synthesized from
  `Response.redirected` — for GET and HEAD only, where the reading is
  unambiguous.
- **The origin's `Content-Length` is never forwarded.** `fetch` has already
  decoded any `Content-Encoding`, and that header is not CORS-safelisted, so the
  origin's number may describe bytes nobody has. A length is sent only when this
  package counted them itself; otherwise the body is close-delimited.
- **Forbidden headers are dropped** because `fetch` refuses them, and
  `User-Agent` is dropped because it would cost a CORS preflight on every
  request for nothing. A header that *means* something is forwarded and takes
  its preflight — a request that cannot be made as asked should fail rather than
  quietly become a different request.
- **A failure is a connection failure.** A CORS refusal, a DNS miss and a port
  with nothing on it are indistinguishable to the browser, so they are
  indistinguishable here: `ECONNREFUSED`, never a hang.
- **A response has 30 seconds to begin** (`createPolicy({ timeout })`, 0 to
  disable). The thread that asked is parked for the whole exchange, so an
  origin that accepts a connection and then says nothing does not slow a guest
  down — it ends it. The clock covers the wait for headers only and stops when
  they arrive, so a large download over a slow link is never cut off for taking
  its time.
- **One exchange per connection**, which is what every response already says:
  a streamed body has no end marker but the close, so `Connection: close` is
  not a preference. A request written behind one that was already answered is
  dropped with the connection, and the write after it fails as `ECONNRESET` —
  the same answer a real closed socket gives. Nothing is saved up: a queued
  request that outlived its connection used to go out later, in place of
  whatever the guest asked for next.
- No cookies or credentials by default: the guest is not the browser's user.
- No `listen`/`accept`, no UDP, no chunked request bodies.

## Bundlers

The fetcher is loaded as `new URL('./fetcher.worker.mjs', import.meta.url)`,
which a bundler will not follow — it emits no worker file and the URL points at
nothing. Build it as its own entry point and say where it went:

```js
await createAtomicsBackend({ workerUrl: new URL('./fetcher.worker.js', import.meta.url) });
```

## Tests

```sh
npm test
```

Serial on purpose (`--test-concurrency=1`): one suite blocks a thread in
`Atomics.wait` by design, which does not share a parallel runner well. The
end-to-end tests run a real fetcher worker against a local server on a thread of
its own — it has to be on its own thread, because the thread driving the guest
side is parked for the whole of every exchange.
