<!--
SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>

SPDX-License-Identifier: ISC
-->

# sockfetch

A TCP socket for wasm guests, backed by `fetch()`. Real HTTP clients — busybox
`wget`, PHP's own `http://` wrapper, `fsockopen()` — work **unmodified**,
against any origin that allows CORS. No relay and no server.

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
backend    await fetch() on this thread     ← a guest that can suspend
           Atomics.wait + fetcher worker    ← a guest that cannot
```

**Only HTTP crosses the boundary**, because `fetch` is the only way out of a
browser. `https://` is included and is the ordinary case — the guest speaks
plaintext and the host does the TLS, which is what the section below is about.
What cannot exist here is anything that is not HTTP: no SSH, no MySQL, no raw
TCP, and no amount of work will add them.

## Two doors, and how a guest picks one

The hard part is that a guest calls `recv(2)` and expects bytes before the call
returns. Whether that is a problem depends entirely on whether its runtime can
suspend, so there are two ways through and the core is the same either way.

**A guest that can suspend** — one whose runtime has JSPI, reached through a
shim that uses it — awaits the fetch on its own thread. `createDirectBackend()`
is that door: no worker, no `SharedArrayBuffer`, no cross-origin isolation, and
no fixed window to copy a body in and out of. The event loop under the guest
keeps turning, so everything else that thread answers is still answered during a
download.

**A guest that cannot** — an Emscripten program, whose socket layer is
synchronous to its bones — parks in `Atomics.wait` while a worker does the
awaiting. `createAtomicsBackend()` is that door. Neither end may be a browser's
main thread; `Atomics.wait` throws there.

Measured against the same 3 MiB body over loopback: 709 MiB/s awaited against
456 MiB/s parked, and — the difference that actually matters — **2 event-loop
turns during the download against 0**. A parked thread answers nothing.

Both doors also lean on the same fact about HTTP: it is strictly
**write-then-read**, so nothing has to go out until the guest reads. A request
is queued by `send` and sent by the `recv` that wants its answer, which is the
only place either door could have waited.

`createAtomicsBackend()` offers both — `fetch` and `fetchAsync` — so a session
with one guest of each kind shares a single connection table and a single
policy, rather than running two nets that happen to agree.

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

Where the runtime has JSPI, that port also carries `recvAsync`, and a shim that
finds it suspends the guest instead of parking its thread. Its **absence** is
the signal — nothing has to be configured, and a shim written against it serves
a session with JSPI and a session without. A net with only the awaited door
needs no worker at all:

```js
import { createNet, createDirectBackend } from 'sockfetch';
import { wasiNet } from 'sockfetch/wasi';

const net = wasiNet(createNet({ backend: createDirectBackend() }));
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
- No UDP, and no chunked request bodies.

## Serving: the same thing, pointed the other way

A guest can be a **server** here too. The host has a request already — a
service worker's `fetch`, a fixture in a test — and hands it to a guest that
believes it accepted a connection; the guest writes a response, and the host
reads it back out.

```js
const net = createNet({ backend, park });

const listener = net.listen('0.0.0.0', 8000);   // the guest does this, via its shim
net.deliver(8000, { method: 'GET', target: '/' }, (answer) => {
  // { status, statusText, headers, body } — or { error }
});
```

**What `accept()` gives back is an ordinary handle.** `send`, `recv`, `poll` and
`close` already serve it, so nothing is added for reading or writing an accepted
connection and the two halves share one handle space. That is the contract, not
an implementation detail: a shim must not have to know which kind it holds.

**`park` is the whole of what an embedder supplies.** A guest holding the thread
cannot be reached by `postMessage`, so how a request arrives while a server is
blocked is the embedder's problem — shared memory in a browser, an ordinary call
under node. `park(ms)` blocks for up to that long, delivering whatever it finds;
`net.wait` exists only when it was given, and its absence is what tells a shim
to keep the old non-blocking behaviour. Without it an accept loop spins at full
CPU and never yields to the JS that would feed it.

**`onResponse` is synchronous and called exactly once.** A promise would settle
on a microtask queue that does not run until the guest yields, which for a
running server is never.

Three details a real server depends on:

- **The request always carries a `Content-Length`**, counted here rather than
  copied, and the read ends by that length rather than by an EOF. A server
  reading zero bytes takes it for a client that hung up — `php -S` closes the
  client on one — so a drained request answers `EAGAIN`, the way a real client
  that is waiting for its answer looks.
- **A response can end three ways** and all three are read: `Content-Length`,
  `Transfer-Encoding: chunked`, or the close, which is what `php -S` does for
  dynamic output.
- **A host is never left holding a request nothing answers.** A listener that
  goes away settles everything it owes, and a server that stops mid-response
  says so rather than handing back a truncated body.

`ports()` and `onPort(fn)` are what a UI watches; a subscriber is caught up with
an `open` for everything already listening, so it needs no `ports()` call beside
its subscribe and no rule for which won the race.

## Bundlers

Only `createAtomicsBackend()` has this problem, and a guest that can suspend
avoids it entirely by needing no worker.

The fetcher is loaded as `new URL('./fetcher.worker.mjs', import.meta.url)`,
which a bundler will not follow — it emits no worker file and the URL points at
nothing. Build it as its own entry point and say where it went:

```js
await createAtomicsBackend({ workerUrl: new URL('./fetcher.worker.js', import.meta.url) });
```

Getting it wrong is a rejected promise rather than a mystery: the fetcher
announces itself before it parks, and `createAtomicsBackend()` does not resolve
until it has. It used to be a guest that waited for ever on a thread that never
loaded.

## Tests

```sh
npm test
```

Serial on purpose (`--test-concurrency=1`): one suite blocks a thread in
`Atomics.wait` by design, which does not share a parallel runner well. The
end-to-end tests run a real fetcher worker against a local server on a thread of
its own — it has to be on its own thread, because the thread driving the guest
side is parked for the whole of every exchange.
