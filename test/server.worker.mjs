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
