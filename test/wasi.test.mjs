// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// The WASI adapter is one difference of vocabulary, so this is a test about
// that difference and nothing else. Real busybox wget over it is proved in
// wasi-sh, which is where the shim and the applet both live.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createNet, AGAIN } from '../src/core.mjs';
import { wasiNet } from '../src/wasi.mjs';

const enc = (s) => new TextEncoder().encode(s);

function stubBackend(body) {
  return {
    fetch() {
      const chunks = body.map(enc);
      return {
        status: 200, headers: [], contentLength: null,
        read: () => (chunks.length ? chunks.shift() : null),
        cancel() {},
      };
    },
  };
}

test('AGAIN becomes null, so a shim needs no sentinel of ours', () => {
  const core = createNet({ backend: stubBackend(['hi']) });
  const net = wasiNet(core);
  const fd = net.connect(net.resolve('example.test'), 80);

  // Nothing written yet: the core says AGAIN, and a shim that had to import a
  // symbol to recognise it would be agreeing on the contract twice.
  assert.equal(core.recv(fd, 10), AGAIN);
  assert.equal(net.recv(fd, 10), null);

  net.send(fd, enc('GET / HTTP/1.1\r\nHost: example.test\r\n\r\n'));
  const got = net.recv(fd, 1 << 16);
  assert.ok(got instanceof Uint8Array && got.length > 0);
});

test('everything else passes straight through', () => {
  const core = createNet({ backend: stubBackend(['x']) });
  const net = wasiNet(core);
  const addr = net.resolve('example.test');

  assert.match(addr, /^172\.29\./);
  const fd = net.connect(addr, 443);
  assert.deepEqual(net.poll(fd), { readable: false, writable: true, hup: false });
  assert.equal(net.close(fd), true);
});
