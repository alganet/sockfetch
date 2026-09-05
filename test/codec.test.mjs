// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRequestParser, serializeHead, redirectHead, reasonFor,
  UNSUPPORTED_CHUNKED, MALFORMED,
} from '../src/codec.mjs';

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

test('a request split across writes parses once it is whole', () => {
  const p = createRequestParser();
  assert.equal(p.push(enc('GET /simple/flask/ HTTP/1.1\r\nHost: pypi.o')), null);
  assert.equal(p.push(enc('rg\r\nUser-Agent: Wg')), null);
  const r = p.push(enc('et\r\n\r\n'));
  assert.equal(r.method, 'GET');
  assert.equal(r.target, '/simple/flask/');
  assert.equal(r.version, 'HTTP/1.1');
  assert.equal(r.host, 'pypi.org');
  assert.equal(r.body.length, 0);
  assert.deepEqual(r.headers, [['Host', 'pypi.org'], ['User-Agent', 'Wget']]);
});

test('a body is taken by Content-Length, and the next request survives it', () => {
  const p = createRequestParser();
  const first = p.push(enc(
    'POST /x HTTP/1.1\r\nHost: h\r\nContent-Length: 5\r\n\r\nhello'
    + 'GET /y HTTP/1.1\r\nHost: h\r\n\r\n',
  ));
  assert.equal(first.method, 'POST');
  assert.equal(dec(first.body), 'hello');
  const second = p.take();
  assert.equal(second.method, 'GET');
  assert.equal(second.target, '/y');
});

test('a folded header line is joined rather than rejected', () => {
  const p = createRequestParser();
  const r = p.push(enc('GET / HTTP/1.1\r\nHost: h\r\nX-Long: one\r\n  two\r\n\r\n'));
  assert.deepEqual(r.headers, [['Host', 'h'], ['X-Long', 'one two']]);
});

test('a chunked request body is refused, not mis-parsed', () => {
  const p = createRequestParser();
  const r = p.push(enc('POST / HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\n'));
  assert.equal(r.error, UNSUPPORTED_CHUNKED);
});

test('a request line that is not one is an error', () => {
  const p = createRequestParser();
  assert.equal(p.push(enc('hello there\r\n\r\n')).error, MALFORMED);
});

test("the origin's Content-Length and Content-Encoding never reach the guest", () => {
  const head = dec(serializeHead({
    status: 200,
    headers: [
      ['Content-Type', 'application/json'],
      ['Content-Length', '1234'],       // the COMPRESSED length, most likely
      ['Content-Encoding', 'gzip'],     // and fetch already undid it
      ['Connection', 'keep-alive'],
    ],
    contentLength: 5000,
  }));
  assert.match(head, /^HTTP\/1\.1 200 OK\r\n/);
  assert.match(head, /Content-Type: application\/json/);
  assert.doesNotMatch(head, /1234/);
  assert.doesNotMatch(head, /gzip/);
  assert.doesNotMatch(head, /keep-alive/);
  assert.match(head, /Content-Length: 5000/);
  assert.match(head, /Connection: close\r\n\r\n$/);
});

test('a length-less response is close-delimited', () => {
  const head = dec(serializeHead({ status: 200, headers: [], contentLength: null }));
  assert.doesNotMatch(head, /Content-Length/);
  assert.match(head, /Connection: close/);
});

test('the synthesized redirect carries the final URL and no body', () => {
  const head = dec(redirectHead('https://files.pythonhosted.org/packages/ab/cd/flask.whl'));
  assert.match(head, /^HTTP\/1\.1 302 Found\r\n/);
  assert.match(head, /Location: https:\/\/files\.pythonhosted\.org\/packages\/ab\/cd\/flask\.whl/);
  assert.match(head, /Content-Length: 0/);
});

test('a status with no reason phrase still gets a plausible one', () => {
  assert.equal(reasonFor(404), 'Not Found');
  assert.equal(reasonFor(418), 'Client Error');
});
