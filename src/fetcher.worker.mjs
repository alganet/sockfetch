// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// The thread that is allowed to await.
//
// It parks in `Atomics.wait` when idle, wakes on a request, and does an
// ordinary `await fetch(...)` — which works precisely because nothing else is
// in flight while it is parked. The guest's thread is parked at the same time,
// on the other channel, which is what makes a synchronous recv(2) possible at
// all.

import { reader, writer } from './channel.mjs';

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/**
 * How much body to hold before giving up on knowing its length.
 *
 * Under it, the whole body is in hand when the head is written, so an accurate
 * `Content-Length` can go out and wget draws a progress bar. Over it, the head
 * goes out without one and the body is close-delimited — correct either way,
 * and this is the only thing the threshold decides.
 */
const DEFAULT_THRESHOLD = 2 << 20;

async function serve({ up, down, threshold = DEFAULT_THRESHOLD }) {
  const requests = reader(up);
  const responses = writer(down);

  for (;;) {
    const head = JSON.parse(DEC.decode(requests.readAll()));
    const body = requests.readAll();
    await handle(head, body, responses, threshold);
  }
}

async function handle(request, body, out, threshold) {
  const { method, url, headers, credentials } = request;

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      // A body is only legal on some methods, and passing an empty one to GET
      // makes fetch throw rather than ignore it.
      body: body.length ? body : undefined,
      credentials,
      // `manual` would hand back an opaque response with no status and no
      // headers, which is worse than useless here — see codec.redirectHead for
      // what we do with `redirected` instead.
      redirect: 'follow',
      // The guest has its own ideas about caching and no way to express them
      // through here; a shared HTTP cache under it would make them wrong.
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  } catch (e) {
    // Everything arrives here identically: a CORS refusal, a DNS failure, a
    // port nothing HTTP is listening on. The browser deliberately does not say
    // which, so neither can we — and a connection that could not be made is
    // the honest reading of all three.
    out.write(ENC.encode(JSON.stringify({
      error: 'ECONNREFUSED',
      message: (e && e.message) || String(e),
    })));
    out.end();
    return;
  }

  // A redirect the guest asked to hear about. The body is discarded on purpose:
  // it belongs to the URL the guest has not agreed to fetch yet.
  if (res.redirected && (method === 'GET' || method === 'HEAD')) {
    out.write(ENC.encode(JSON.stringify({ redirected: true, location: res.url })));
    out.end();
    try { await res.body?.cancel(); } catch { /* already done with it */ }
    return;
  }

  const entries = [];
  res.headers.forEach((value, name) => entries.push([name, value]));

  const stream = res.body?.getReader();
  const held = [];
  let total = 0;
  let complete = false;

  while (stream && total <= threshold) {
    const { value, done } = await stream.read();
    if (done) { complete = true; break; }
    held.push(value);
    total += value.length;
  }
  if (!stream) complete = true;

  out.write(ENC.encode(JSON.stringify({
    status: res.status,
    statusText: res.statusText,
    headers: entries,
    url: res.url,
    contentLength: complete ? total : null,
  })));

  // Every path below ends the message, the cut-short ones included: the guest
  // drains to the terminator, so one that never arrives is a guest that waits
  // for ever.
  for (const part of held) {
    if (!out.chunk(part, false)) { await cancel(stream); out.end(); return; }
  }
  if (!complete) {
    for (;;) {
      const { value, done } = await stream.read();
      if (done) break;
      if (!out.chunk(value, false)) { await cancel(stream); out.end(); return; }
    }
  }
  out.end();
}

async function cancel(stream) {
  try { await stream?.cancel(); } catch { /* the guest left; nothing to salvage */ }
}

// Node hands the channels over before the thread starts; a browser has to post
// them, and the handshake must finish BEFORE the loop parks — a thread inside
// Atomics.wait will never run a message handler.
if (typeof process !== 'undefined' && process.versions && process.versions.node) {
  const { workerData } = await import('node:worker_threads');
  serve(workerData);
} else {
  globalThis.addEventListener('message', (event) => serve(event.data), { once: true });
}
