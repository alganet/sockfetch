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
//
// ## Why nothing in here may throw
//
// The guest is in `Atomics.wait` on a message this thread owes it, and every
// deadline in the package runs HERE. So an exception that escapes this loop is
// not an error the guest hears about — it is a thread that stops existing while
// something waits on it for ever, with no timer left anywhere that could end
// the wait. Measured, before the guard below: a dead fetcher is a guest parked
// with no answer and no error, indefinitely.
//
// Hence: every failure becomes a REPLY. The shape of the reply is the only
// question, and `answered` is what decides it — before the head has gone out
// there is still an error to send, and after it there is only the end of a body
// that was cut short, which is what a close-delimited body IS on a real socket.

import { reader, writer, READY } from './channel.mjs';

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
    let request, body;
    try {
      request = JSON.parse(DEC.decode(requests.readAll()));
      body = requests.readAll();
    } catch (e) {
      // The two ends have lost each other and there is no frame boundary left
      // to resynchronize on. Answer anyway — somebody is waiting on a reply —
      // and let the next read try again rather than ending the thread.
      refuse(responses, 'ECONNRESET', e);
      continue;
    }
    await handle(request, body, responses, threshold);
  }
}

/** One request, and no way for it to end without a reply. */
async function handle(request, body, out, threshold) {
  const { method, url, headers, credentials, timeout } = request;

  // A deadline on SILENCE, not on the exchange.
  //
  // It starts on the wait for headers, and from then on it is re-armed by every
  // chunk that arrives — so a large download over a slow link is never cut off
  // for taking its time, and a stream that simply stops does not park the guest
  // for ever. Before it was re-armed, the clock was cleared once headers landed
  // and a body that died mid-flight had nothing left to end it.
  const clock = timeout > 0 ? new AbortController() : null;
  let alarm = null;
  const arm = () => {
    if (!clock) return;
    if (alarm !== null) clearTimeout(alarm);
    alarm = setTimeout(() => clock.abort(), timeout);
  };
  const disarm = () => { if (alarm !== null) clearTimeout(alarm); alarm = null; };

  let answered = false;
  try {
    arm();
    let res;
    try {
      res = await fetch(url, {
        signal: clock ? clock.signal : undefined,
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
      refuse(out, 'ECONNREFUSED', e);
      return;
    }

    // A redirect the guest asked to hear about. The body is discarded on purpose:
    // it belongs to the URL the guest has not agreed to fetch yet.
    if (res.redirected && (method === 'GET' || method === 'HEAD')) {
      out.write(ENC.encode(JSON.stringify({ redirected: true, location: res.url })));
      answered = true;
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
      arm();
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
    answered = true;

    // Every path below ends the message, the cut-short ones included: the guest
    // drains to the terminator, so one that never arrives is a guest that waits
    // for ever.
    for (const part of held) {
      if (!out.chunk(part, false)) { await cancel(stream); out.end(); return; }
    }
    if (!complete) {
      for (;;) {
        const { value, done } = await stream.read();
        arm();
        if (done) break;
        if (!out.chunk(value, false)) { await cancel(stream); out.end(); return; }
      }
    }
    out.end();
  } catch (e) {
    // The guard the top of this file is about. `TypeError: terminated` from a
    // body cut short is the case that reaches here in practice; a bug in the
    // lines above would reach it too, and must not be worse than a reset.
    if (answered) {
      // The head is already at the guest and no second one can be sent. A body
      // that stops early with no Content-Length is exactly what a real socket
      // shows for a connection lost mid-response, so ending it here says the
      // same thing the wire would.
      out.end();
    } else {
      refuse(out, 'ECONNRESET', e);
    }
  } finally {
    disarm();
  }
}

/**
 * A failure, as the two messages every exchange owes.
 *
 * `write` terminates the head and `end` supplies the empty body, because the
 * caller reads both unconditionally — one message left in the channel is the
 * NEXT exchange reading a terminator where its head belongs.
 */
function refuse(out, code, e) {
  out.write(ENC.encode(JSON.stringify({ error: code, message: (e && e.message) || String(e) })));
  out.end();
}

async function cancel(stream) {
  try { await stream?.cancel(); } catch { /* the guest left; nothing to salvage */ }
}

// Node hands the channels over before the thread starts; a browser has to post
// them, and the handshake must finish BEFORE the loop parks — a thread inside
// Atomics.wait will never run a message handler.
//
// `READY` goes back the other way for the same reason in reverse: the caller
// cannot tell a fetcher that is parked and waiting from one whose module never
// loaded, and it has to know before it parks a guest on the difference — a
// `workerUrl` a bundler moved is a guest that waits for ever, and that is the
// one mistake this package's own README warns about.
//
// It has to be posted SYNCHRONOUSLY, before serve() is entered. serve() is an
// async function whose very first act is a blocking Atomics.wait, so the thread
// parks inside its synchronous part: a microtask queued here would never run.
if (typeof process !== 'undefined' && process.versions && process.versions.node) {
  const { workerData, parentPort } = await import('node:worker_threads');
  parentPort.postMessage(READY);
  serve(workerData);
} else {
  globalThis.addEventListener('message', (event) => {
    globalThis.postMessage(READY);
    serve(event.data);
  }, { once: true });
}
