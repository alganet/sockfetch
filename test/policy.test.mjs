// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPolicy } from '../src/policy.mjs';

test('a name aliases into 172.29/16, stably and both ways', () => {
  const p = createPolicy();
  const a = p.resolve('pypi.org');
  assert.match(a, /^172\.29\.\d+\.\d+$/);
  assert.equal(p.resolve('pypi.org'), a, 'the same name keeps the same address');
  assert.equal(p.nameOf(a), 'pypi.org');
  assert.notEqual(p.resolve('registry.npmjs.org'), a);
});

test('a literal address resolves to itself and is nobody\'s alias', () => {
  const p = createPolicy();
  assert.equal(p.resolve('93.184.216.34'), '93.184.216.34');
  assert.equal(p.nameOf('93.184.216.34'), null);
});

test('an embedder resolver wins, and stays reversible', () => {
  const p = createPolicy({ resolve: (n) => (n === 'known.test' ? '10.0.0.7' : null) });
  assert.equal(p.resolve('known.test'), '10.0.0.7');
  assert.equal(p.nameOf('10.0.0.7'), 'known.test');
  assert.match(p.resolve('other.test'), /^172\.29\./);
});

test('the port is what picks the scheme, because the guest speaks plaintext', () => {
  const p = createPolicy();
  assert.equal(p.schemeFor(443), 'https');
  assert.equal(p.schemeFor(80), 'http');
  assert.equal(p.schemeFor(8080), 'http');
  assert.equal(p.urlFor({ host: 'pypi.org', port: 443, target: '/simple/' }).href,
    'https://pypi.org/simple/');
  assert.equal(p.urlFor({ host: 'example.test', port: 8080, target: '/a' }).href,
    'http://example.test:8080/a');
});

test('a Host header carrying its own port is authoritative', () => {
  const p = createPolicy();
  assert.equal(p.urlFor({ host: 'example.test:9000', port: 9000, target: '/a' }).href,
    'http://example.test:9000/a');
});

test('an absolute request target wins over Host, as a proxy would read it', () => {
  const p = createPolicy();
  assert.equal(p.urlFor({ host: 'ignored.test', port: 80, target: 'http://real.test/x' }).href,
    'http://real.test/x');
});

test('forbidden headers go, and so does the one cosmetic header that would cost a preflight', () => {
  const p = createPolicy();
  const { headers, dropped } = p.headersFor([
    ['Host', 'h'], ['Connection', 'close'], ['Content-Length', '3'],
    ['Accept-Encoding', 'gzip'], ['User-Agent', 'Wget'], ['Proxy-Foo', 'x'],
    ['Accept', '*/*'], ['Authorization', 'Bearer t'], ['X-Custom', 'y'],
  ]);
  assert.deepEqual(headers, [['Accept', '*/*'], ['Authorization', 'Bearer t'], ['X-Custom', 'y']],
    'meaningful headers are forwarded and take their preflight');
  assert.deepEqual(dropped.sort(),
    ['accept-encoding', 'connection', 'content-length', 'host', 'proxy-foo', 'user-agent']);
});

test('an allowlist refuses, and a rewrite redirects', () => {
  const p = createPolicy({
    allow: (u) => u.hostname === 'pypi.org',
    rewrite: (u) => `https://proxy.test/?url=${encodeURIComponent(u.href)}`,
  });
  assert.equal(p.allow(new URL('https://pypi.org/a')), true);
  assert.equal(p.allow(new URL('https://evil.test/a')), false);
  assert.equal(p.rewrite(new URL('https://pypi.org/a')).href,
    'https://proxy.test/?url=https%3A%2F%2Fpypi.org%2Fa');
});

test('credentials are omitted unless asked for: the guest is not the browser user', () => {
  assert.equal(createPolicy().credentials, 'omit');
  assert.equal(createPolicy({ credentials: true }).credentials, 'include');
});
