// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// One request, as the sequence of decisions every door makes about it.
//
// There are two doors onto the same network. A guest that cannot yield goes
// through a worker and `Atomics.wait`; a guest that CAN — one whose runtime has
// JSPI, and whose shim suspends rather than parks — awaits the fetch on its own
// thread and needs no worker at all. They are different in exactly one respect,
// which is who waits.
//
// Everything else has to be identical, and this file is why: the redirect rule,
// what a failure is called, which headers a response may claim, and the
// deadline. Two copies of those would agree on the day they were written and
// drift by the second bug fixed in one of them — and the drift would show up as
// a guest that gets different answers depending on which browser it is in.

/**
 * How much body to hold before giving up on knowing its length.
 *
 * Under it, the whole body is in hand when the head goes out, so an accurate
 * `Content-Length` can go with it and wget draws a progress bar. Over it, the
 * head goes out without one and the body is close-delimited — correct either
 * way, and this is the only thing the threshold decides.
 */
export const DEFAULT_THRESHOLD = 2 << 20;

/**
 * Start one exchange: everything up to and including the response head.
 *
 * Answers one of three shapes, and a caller has to handle all three:
 *
 *   { error, message }              nothing was reached
 *   { redirected, location }        a 3xx the guest gets to decide about
 *   { head, held, stream, complete, arm, disarm }
 *
 * In the last, `head` is ready to send, `held` is whatever was buffered to
 * learn its length, and `stream` is the rest (null when there is none).
 * `arm` re-arms the deadline and must be called for every chunk taken from
 * `stream`; `disarm` ends it, and a caller that forgets leaves a timer holding
 * a thread awake.
 */
export async function beginExchange(request) {
  const { method, url, headers, body, credentials, timeout } = request;
  const threshold = request.threshold ?? DEFAULT_THRESHOLD;

  // A deadline on SILENCE, not on the exchange.
  //
  // It starts on the wait for headers, and from then on every chunk that
  // arrives re-arms it — so a large download over a slow link is never cut off
  // for taking its time, and a stream that simply stops does not leave a guest
  // waiting on bytes that are not coming. A clock that covered only the head
  // could not see the second case at all.
  const clock = timeout > 0 ? new AbortController() : null;
  let alarm = null;
  const arm = () => {
    if (!clock) return;
    if (alarm !== null) clearTimeout(alarm);
    alarm = setTimeout(() => clock.abort(), timeout);
  };
  const disarm = () => { if (alarm !== null) clearTimeout(alarm); alarm = null; };

  arm();
  let res;
  try {
    res = await fetch(url, {
      signal: clock ? clock.signal : undefined,
      method,
      headers,
      // A body is only legal on some methods, and passing an empty one to GET
      // makes fetch throw rather than ignore it.
      body: body && body.length ? body : undefined,
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
    disarm();
    // Everything arrives here identically: a CORS refusal, a DNS failure, a
    // port nothing HTTP is listening on. The browser deliberately does not say
    // which, so neither can we — and a connection that could not be made is the
    // honest reading of all three.
    return { error: 'ECONNREFUSED', message: (e && e.message) || String(e) };
  }

  // A redirect the guest asked to hear about. The body is discarded on purpose:
  // it belongs to the URL the guest has not agreed to fetch yet. Only for GET
  // and HEAD — see codec.redirectHead for why a synthesized 302 would be a lie
  // on anything else.
  if (res.redirected && (method === 'GET' || method === 'HEAD')) {
    disarm();
    try { await res.body?.cancel(); } catch { /* already done with it */ }
    return { redirected: true, location: res.url };
  }

  const entries = [];
  res.headers.forEach((value, name) => entries.push([name, value]));

  const stream = res.body?.getReader() || null;
  const held = [];
  let total = 0;
  let complete = !stream;

  try {
    while (stream && total <= threshold) {
      const { value, done } = await stream.read();
      arm();
      if (done) { complete = true; break; }
      held.push(value);
      total += value.length;
    }
  } catch (e) {
    // The head has not gone out yet, so this is still reportable as a failure
    // rather than as a body that stops early. `TypeError: terminated` from a
    // response cut short is what reaches here in practice.
    disarm();
    return { error: 'ECONNRESET', message: (e && e.message) || String(e) };
  }

  return {
    head: {
      status: res.status,
      statusText: res.statusText,
      headers: entries,
      url: res.url,
      contentLength: complete ? total : null,
    },
    held,
    stream,
    complete,
    arm,
    disarm,
  };
}
