// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// A one-way byte channel between two threads, where the READING side may be
// blocked in `Atomics.wait` and the writing side may be an ordinary async
// function. One fixed buffer, chunk at a time, with backpressure.
//
// This is the whole reason the package works without Asyncify or JSPI. The
// guest is a synchronous program: it calls recv(2) and expects bytes back
// before the call returns, and there is no stack to suspend. `Atomics.wait`
// parks that thread — legal in a worker, and in Node on any thread — while
// another thread does the asynchronous work, which is the one shape of
// "block on a promise" the platform actually offers.
//
// Chunked rather than one big buffer because a response can be a tarball: a
// 40 MB body moves through a 1 MB window instead of requiring a 40 MB
// SharedArrayBuffer allocated up front for the one request that needs it.
//
// **Neither end may be a browser's main thread.** `Atomics.wait` throws there.
// That is not a limitation this package can lift; it is what the platform says.

const FULL = 0;    // 0 = the reader has taken it, 1 = a chunk is waiting
const LEN = 1;
const LAST = 2;    // this chunk ends the message
const CANCEL = 3;  // the reader has gone; the writer must stop

export const DEFAULT_CHUNK = 1 << 20;

/** Allocate the shared memory for one channel. Transfer the result verbatim. */
export function createChannel(chunk = DEFAULT_CHUNK) {
  return {
    ctl: new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT),
    data: new SharedArrayBuffer(chunk),
  };
}

/** The writing end. `write` blocks while the reader is behind. */
export function writer(channel) {
  const ctl = new Int32Array(channel.ctl);
  const data = new Uint8Array(channel.data);

  /**
   * `force` writes even under a cancel, and exactly one thing uses it: the
   * terminator. A cancelled message still has to END, because the reader is
   * draining to the end of it — see the reader's cancel(). A refused
   * terminator is a reader that drains for ever.
   */
  const put = (bytes, last, force) => {
    // Re-checked on every wake, because a notify is a hint rather than a
    // promise: a spurious wake and a cancel both land here.
    for (;;) {
      if (!force && Atomics.load(ctl, CANCEL) === 1) return false;
      if (Atomics.load(ctl, FULL) === 0) break;
      Atomics.wait(ctl, FULL, 1);
    }
    data.set(bytes, 0);
    Atomics.store(ctl, LEN, bytes.length);
    Atomics.store(ctl, LAST, last ? 1 : 0);
    Atomics.store(ctl, FULL, 1);
    Atomics.notify(ctl, FULL);
    return true;
  };

  return {
    /** Send one message, split across as many chunks as it needs. */
    write(bytes) {
      const size = data.length;
      if (bytes.length <= size) return put(bytes, true);
      for (let off = 0; off < bytes.length; off += size) {
        const end = Math.min(off + size, bytes.length);
        if (!put(bytes.subarray(off, end), end >= bytes.length)) return false;
      }
      return true;
    },
    /** Send one chunk of a message whose end is not known yet. */
    chunk(bytes, last) {
      const size = data.length;
      if (bytes.length <= size) return put(bytes, last);
      for (let off = 0; off < bytes.length; off += size) {
        const end = Math.min(off + size, bytes.length);
        if (!put(bytes.subarray(off, end), last && end >= bytes.length)) return false;
      }
      return true;
    },
    /** Send an empty terminator — an empty body is still a message. */
    end() { return put(new Uint8Array(0), true, true); },
    cancelled() { return Atomics.load(ctl, CANCEL) === 1; },
  };
}

/** The reading end. `read` blocks until a chunk arrives. */
export function reader(channel) {
  const ctl = new Int32Array(channel.ctl);
  const data = new Uint8Array(channel.data);

  return {
    /** One chunk. `{ bytes, last }` — `last` ends the message. */
    read() {
      while (Atomics.load(ctl, FULL) === 0) Atomics.wait(ctl, FULL, 0);
      const len = Atomics.load(ctl, LEN);
      const last = Atomics.load(ctl, LAST) === 1;
      const bytes = data.slice(0, len);
      Atomics.store(ctl, FULL, 0);
      Atomics.notify(ctl, FULL);
      return { bytes, last };
    },
    /** Every chunk up to the end of the message, joined. */
    readAll() {
      const parts = [];
      let total = 0;
      for (;;) {
        const { bytes, last } = this.read();
        parts.push(bytes);
        total += bytes.length;
        if (last) break;
      }
      if (parts.length === 1) return parts[0];
      const out = new Uint8Array(total);
      let off = 0;
      for (const p of parts) { out.set(p, off); off += p.length; }
      return out;
    },
    /**
     * Stop the writer.
     *
     * Needed because a guest can walk away mid-body — wget with `-O -` down a
     * closed pipe, a PHP script that read what it wanted — and the writer would
     * otherwise park in `Atomics.wait` for a reader that is never coming,
     * holding its whole thread.
     */
    cancel() {
      // The flag only. Clearing FULL here would DISCARD a chunk the writer had
      // already handed over, and the writer — which may be awaiting something
      // else at this instant — would then write its next one into a channel
      // that has silently moved on. Every frame after that is one behind: a
      // body fragment arrives where a response head belongs, and the exchange
      // after it never completes.
      //
      // So a cancel says "stop early", and the caller drains to the end of the
      // message it stops. Nothing is ever left in the channel for the next
      // exchange to trip over.
      Atomics.store(ctl, CANCEL, 1);
      Atomics.notify(ctl, FULL);
    },
    /**
     * Stop caring, then read to the end of the message anyway.
     *
     * The terminator IS the acknowledgement: the writer only sends one after
     * it has stopped producing, so seeing it means there is nothing further in
     * flight and the flag can be cleared here safely. Leaving it set instead
     * would refuse the NEXT message's head — silently, since a refused write
     * returns false into a caller with nothing useful to do about it — and the
     * guest would parse a terminator as a head.
     */
    cancelAndDrain() {
      this.cancel();
      for (;;) {
        if (this.read().last) {
          Atomics.store(ctl, CANCEL, 0);
          return;
        }
      }
    },
  };
}
