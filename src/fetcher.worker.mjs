// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// The thread that is allowed to await, for a guest that cannot.
//
// It parks in `Atomics.wait` when idle, wakes on a request, and does an
// ordinary `await fetch(...)` — which works precisely because nothing else is
// in flight while it is parked. The guest's thread is parked at the same time,
// on the other channel, which is what makes a synchronous recv(2) possible at
// all.
//
// What it decides about a request is not in here: see exchange.mjs, which the
// other door shares. What IS in here is the marshalling — a head as JSON, a
// body as chunks through a fixed window — and the guarantee below.
//
// ## Why nothing in here may throw
//
// The guest is in `Atomics.wait` on a message this thread owes it, and every
// deadline on this path runs HERE. So an exception that escapes this loop is
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
import { beginExchange, DEFAULT_THRESHOLD } from './exchange.mjs';

const ENC = new TextEncoder();
const DEC = new TextDecoder();

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
    await handle({ ...request, body, threshold }, responses);
  }
}

/** One request, and no way for it to end without a reply. */
async function handle(request, out) {
  let answered = false;
  let exchange = null;
  try {
    exchange = await beginExchange(request);

    if (exchange.error) { refuse(out, exchange.error, exchange); return; }
    if (exchange.redirected) {
      out.write(ENC.encode(JSON.stringify({ redirected: true, location: exchange.location })));
      answered = true;
      out.end();
      return;
    }

    const { head, held, stream, complete, arm } = exchange;
    out.write(ENC.encode(JSON.stringify(head)));
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
    exchange?.disarm?.();
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
