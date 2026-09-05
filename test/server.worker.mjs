// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// The suite's origin, on a thread of its own.
//
// It has to be: the thread driving the guest side parks in `Atomics.wait` for
// the whole of every exchange, so a server sharing that event loop could never
// answer the request being waited on. That is a fact about the test, not about
// the design — a real origin is not in this process — but it is exactly the
// deadlock an embedder will hit if they put a dev server on the guest's thread,
// so it is worth having written down where somebody will find it.

import { createServer } from 'node:http';
import { parentPort } from 'node:worker_threads';

/** Bigger than the fetcher's default buffering threshold, so it must stream. */
export const BIG = 3 << 20;

const server = createServer((req, res) => {
  if (req.url === '/small') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('hello world');
  } else if (req.url === '/big') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    const slice = Buffer.alloc(64 * 1024, 0x61);
    let sent = 0;
    const pump = () => {
      while (sent < BIG) {
        sent += slice.length;
        if (!res.write(slice)) { res.once('drain', pump); return; }
      }
      res.end();
    };
    pump();
  } else if (req.url === '/redirect') {
    res.writeHead(302, { location: '/small' });
    res.end();
  } else if (req.url === '/missing') {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('nope');
  } else if (req.url === '/silent') {
    // Accepted, and then nothing — ever. The one failure a synchronous guest
    // cannot survive without a deadline: it is parked for the whole exchange.
  } else if (req.url === '/truncated') {
    // A length it will not honour, and the socket pulled out from under it.
    // `fetch` resolves on the headers and then rejects the body read with
    // `TypeError: terminated`, which is the exception that used to END the
    // fetcher thread and park the guest on a reply nobody would ever send.
    //
    // Under the buffering threshold, so the head has NOT gone out yet and the
    // failure can still be reported as one.
    res.writeHead(200, { 'content-length': String(8 << 20) });
    res.write(Buffer.alloc(64 * 1024, 0x61));
    setTimeout(() => res.socket.destroy(), 40);
  } else if (req.url === '/truncated-big') {
    // The same break, past the threshold: the head is already at the guest and
    // no second one can be sent, so all that is left is to end a body that
    // stopped early — which is what a close-delimited body IS on a real socket.
    res.writeHead(200, { 'content-length': String(16 << 20) });
    const slice = Buffer.alloc(64 * 1024, 0x61);
    let sent = 0;
    const pump = () => {
      while (sent < BIG) {
        sent += slice.length;
        if (!res.write(slice)) { res.once('drain', pump); return; }
      }
      setTimeout(() => res.socket.destroy(), 40);
    };
    pump();
  } else if (req.url === '/stall') {
    // A download that GOT GOING and then froze, with the connection held open
    // and no reset to end it. Past the threshold on purpose: under it the
    // buffering loop is still waiting for a head to send and any failure is
    // reportable, which is `/truncated`'s case. Here the head is long gone and
    // the guest is reading a body that has simply stopped arriving.
    //
    // This is what the old clock could not see. It covered the wait for headers
    // and was cleared the moment they came, so from then on nothing anywhere
    // was running that could end the wait. It is re-armed by every chunk now,
    // which ends silence without ever cutting off a link that is merely slow.
    res.writeHead(200, { 'content-length': String(16 << 20) });
    const slice = Buffer.alloc(64 * 1024, 0x61);
    let sent = 0;
    const pump = () => {
      while (sent < BIG) {
        sent += slice.length;
        if (!res.write(slice)) { res.once('drain', pump); return; }
      }
      // ...and then nothing, for as long as anyone cares to wait.
    };
    pump();
  } else if (req.url === '/echo') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`${req.method}:${Buffer.concat(chunks)}`);
    });
  } else {
    res.writeHead(500);
    res.end();
  }
});

// `node --test` runs every file under test/, this one included, so it has to be
// harmless when it is imported rather than spawned.
if (parentPort) {
  server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));
}
