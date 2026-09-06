// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// HTTP/1.1 on the wire, in both directions: the bytes a guest writes into what
// it believes is a socket, parsed into something `fetch()` can be asked for;
// and a `Response`, written back out as the bytes that guest expects to read.
//
// This file knows nothing about sockets, fetch or policy. It is a pair of pure
// functions over bytes, which is what makes it testable without a network and
// reusable by an adapter that is not one of ours.

const CR = 13, LF = 10;
const DEC = new TextDecoder('utf-8');
const ENC = new TextEncoder();

/** Reasons a request cannot be turned into a fetch. */
export const UNSUPPORTED_CHUNKED = 'chunked request bodies are not supported';
export const MALFORMED = 'the request could not be parsed';

/** Find CRLFCRLF, the end of the head. -1 while it has not arrived. */
function endOfHead(buf, len) {
  for (let i = 3; i < len; i++) {
    if (buf[i] === LF && buf[i - 1] === CR && buf[i - 2] === LF && buf[i - 3] === CR) return i + 1;
  }
  return -1;
}

/**
 * Split a head into its request line and headers.
 *
 * Obs-folded continuation lines (a header value carried onto the next line
 * behind whitespace) are joined rather than rejected: they are deprecated
 * rather than gone, and a parser that drops them turns a legal request into a
 * silently different one.
 */
function parseHead(text) {
  const lines = text.split('\r\n');
  const start = lines.shift() || '';
  const parts = start.split(' ');
  if (parts.length < 3) return null;
  const [method, target] = parts;
  const version = parts[parts.length - 1];
  if (!method || !target || !/^HTTP\/\d\.\d$/.test(version)) return null;

  const headers = [];
  for (const line of lines) {
    if (!line) continue;
    if (line[0] === ' ' || line[0] === '\t') {
      if (!headers.length) return null;
      headers[headers.length - 1][1] += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 1) return null;
    headers.push([line.slice(0, colon), line.slice(colon + 1).trim()]);
  }
  return { method, target, version, headers };
}

const headerValue = (headers, name) => {
  const wanted = name.toLowerCase();
  for (const [k, v] of headers) if (k.toLowerCase() === wanted) return v;
  return null;
};

/**
 * A parser over one connection's byte stream.
 *
 * Stateful because a socket is: `push()` is handed whatever the guest happened
 * to write(2), which may be half a header or three requests, and the parser has
 * to be the thing that knows where it got to. Bytes past a completed request
 * stay buffered, so a client that reuses the connection is parsed rather than
 * confused — neither of ours does, and a parser that assumed so would be a trap
 * for the third one.
 */
export function createRequestParser() {
  let buf = new Uint8Array(2048);
  let len = 0;
  let head = null;        // parsed, waiting for its body
  let bodyNeeded = 0;

  const grow = (extra) => {
    if (len + extra <= buf.length) return;
    let size = buf.length;
    while (size < len + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(buf.subarray(0, len));
    buf = next;
  };

  const consume = (upto) => {
    buf.copyWithin(0, upto, len);
    len -= upto;
  };

  return {
    /**
     * Feed bytes; get back a complete request, an error, or null for
     * "keep writing".
     */
    push(bytes) {
      grow(bytes.length);
      buf.set(bytes, len);
      len += bytes.length;
      return this.take();
    },

    /** Try to complete a request from what is already buffered. */
    take() {
      if (!head) {
        const end = endOfHead(buf, len);
        if (end < 0) return null;
        const parsed = parseHead(DEC.decode(buf.subarray(0, end - 2)));
        consume(end);
        if (!parsed) return { error: MALFORMED };
        if (headerValue(parsed.headers, 'transfer-encoding')) {
          return { error: UNSUPPORTED_CHUNKED };
        }
        head = parsed;
        bodyNeeded = Number(headerValue(parsed.headers, 'content-length') || 0);
        if (!Number.isFinite(bodyNeeded) || bodyNeeded < 0) return { error: MALFORMED };
      }
      if (len < bodyNeeded) return null;

      const body = bodyNeeded ? buf.slice(0, bodyNeeded) : new Uint8Array(0);
      consume(bodyNeeded);
      const request = head;
      head = null;
      bodyNeeded = 0;

      const host = headerValue(request.headers, 'host');
      return { ...request, host, body };
    },
  };
}

/**
 * The head of a response, as bytes.
 *
 * `Connection: close` always, because both clients send it and because the
 * length rule below leaves the connection as the only end-of-body marker in
 * the streaming case.
 *
 * **The origin's own `Content-Length` is never forwarded**, and that is a
 * correctness rule rather than tidiness. `fetch()` has already decoded any
 * `Content-Encoding` by the time we see the body, so the origin's length
 * describes bytes we no longer have — and `Content-Encoding` is NOT a
 * CORS-safelisted response header, so on a cross-origin response we usually
 * cannot even tell whether it was applied. Passing that number through makes a
 * gzipped response arrive truncated at exactly the compressed length, silently.
 *
 * So a length is emitted only when the caller counted the bytes itself
 * (see the buffer threshold in the fetcher), and otherwise omitted — a
 * close-delimited body, which HTTP/1.1 allows and which both busybox wget and
 * PHP's http wrapper read correctly.
 */
export function serializeHead({ status, statusText, headers = [], contentLength = null }) {
  const out = [`HTTP/1.1 ${status} ${statusText || reasonFor(status)}`];
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    // Hop-by-hop and length headers are ours to decide, not the origin's.
    if (lower === 'connection' || lower === 'keep-alive' || lower === 'transfer-encoding'
      || lower === 'content-length' || lower === 'content-encoding') continue;
    out.push(`${name}: ${value}`);
  }
  if (contentLength !== null) out.push(`Content-Length: ${contentLength}`);
  out.push('Connection: close');
  return ENC.encode(`${out.join('\r\n')}\r\n\r\n`);
}

/**
 * The redirect the guest gets to decide about.
 *
 * `fetch()` cannot show us the real one — `redirect: 'manual'` answers with an
 * opaque response carrying status 0 and no headers — so what the guest is
 * handed is SYNTHESIZED from `Response.redirected` and `Response.url`. It is a
 * 302 because that is the reading both clients apply identically to a GET, and
 * it is only ever produced for GET and HEAD: on any other method a made-up 302
 * could turn a POST into a GET when the real chain (a 307, say) did not.
 *
 * The point of doing this at all is that following silently breaks semantics
 * the guest owns — PHP's `follow_location` and `max_redirects`, wget's
 * `--max-redirect`. A script that says "do not follow" must not be followed
 * for.
 */
export function redirectHead(location) {
  return serializeHead({
    status: 302,
    statusText: 'Found',
    headers: [['Location', location]],
    contentLength: 0,
  });
}

const REASONS = {
  200: 'OK', 201: 'Created', 204: 'No Content', 206: 'Partial Content',
  301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified',
  307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 408: 'Request Timeout', 410: 'Gone',
  429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway',
  503: 'Service Unavailable', 504: 'Gateway Timeout',
};

/** A reason phrase for a status, because `fetch` does not always carry one. */
export function reasonFor(status) {
  return REASONS[status] || (status < 200 ? 'Informational'
    : status < 300 ? 'OK' : status < 400 ? 'Redirect'
    : status < 500 ? 'Client Error' : 'Server Error');
}

// ─── the other direction ─────────────────────────────────────────────────────
//
// Everything above serves a guest that is a CLIENT: it parses the request the
// guest wrote and serialises the response it should read. A guest that is a
// SERVER needs the mirror — a request written INTO it, and a response read back
// OUT of it — and that is what follows.
//
// The two halves share `endOfHead` and the CRLF rules and nothing else, because
// a request line and a status line are different grammars. They are here rather
// than in a file of their own for the reason the file exists: one place that
// knows how HTTP/1.1 is spelled, so the two directions cannot disagree about it.

/**
 * A request, as the bytes a server expects to read.
 *
 * Three headers are this function's rather than the caller's, and each is a
 * correctness rule:
 *
 * - **`Host`** is required by HTTP/1.1 and a server may reject a request
 *   without one. The caller usually has it; where it does not, the address the
 *   server is listening on is the honest answer.
 * - **`Content-Length`** is counted from the body handed over, never copied
 *   from the caller. A length that disagrees with the bytes is how a server
 *   comes to block waiting for a body that already ended.
 * - **`Connection: close`** because this is one exchange. The server is told
 *   so up front rather than discovering it, which is what lets a response with
 *   no length of its own be read to the end.
 *
 * `Transfer-Encoding` is dropped for the same reason `Content-Length` is
 * recomputed: the body here is already whole, so a chunked framing the caller
 * inherited from somewhere else would describe bytes that are not on the wire.
 */
export function serializeRequestHead({ method = 'GET', target = '/', headers = [], host = null, contentLength = 0 }) {
  const out = [`${method} ${target} HTTP/1.1`];
  let sawHost = false;
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (lower === 'content-length' || lower === 'connection' || lower === 'transfer-encoding'
      || lower === 'keep-alive') continue;
    if (lower === 'host') sawHost = true;
    out.push(`${name}: ${value}`);
  }
  if (!sawHost && host) out.splice(1, 0, `Host: ${host}`);
  out.push(`Content-Length: ${contentLength}`);
  out.push('Connection: close');
  return ENC.encode(`${out.join('\r\n')}\r\n\r\n`);
}

/** Split a status line and headers. The mirror of {@link parseHead}. */
function parseStatus(text) {
  const lines = text.split('\r\n');
  const start = lines.shift() || '';
  const match = /^HTTP\/(\d)\.(\d) (\d{3})(?: (.*))?$/.exec(start);
  if (!match) return null;

  const headers = [];
  for (const line of lines) {
    if (!line) continue;
    if (line[0] === ' ' || line[0] === '\t') {
      if (!headers.length) return null;
      headers[headers.length - 1][1] += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 1) return null;
    headers.push([line.slice(0, colon), line.slice(colon + 1).trim()]);
  }
  return { status: Number(match[3]), statusText: match[4] || '', headers };
}

/** Statuses that carry no body at all, whatever the headers claim. */
const BODILESS = new Set([204, 304]);

/**
 * A parser over one server's byte stream.
 *
 * Stateful for the same reason the request parser is: a guest writes whatever
 * it happens to `write(2)`, and the thing that knows where it got to has to be
 * the parser.
 *
 * **A response can end three ways and all three are here**, because which one
 * applies is the server's choice and not ours:
 *
 * - `Content-Length` — exact, and the common case.
 * - `Transfer-Encoding: chunked` — decoded, because a server we do not control
 *   is free to stream and a parser that only understood the other two would
 *   truncate it at the first chunk header.
 * - Neither — the body runs to the close, which HTTP/1.1 allows and which is
 *   what `php -S` does for dynamic output. `finish()` is how that end arrives:
 *   nothing in the byte stream announces it, so the caller has to.
 */
export function createResponseParser() {
  let buf = new Uint8Array(2048);
  let len = 0;
  let head = null;
  let mode = null;              // 'length' | 'chunked' | 'close'
  let needed = 0;
  let chunkLeft = 0;
  let sawTerminator = false;
  const body = [];
  let bodyLen = 0;

  const grow = (extra) => {
    if (len + extra <= buf.length) return;
    let size = buf.length;
    while (size < len + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(buf.subarray(0, len));
    buf = next;
  };
  const consume = (upto) => { buf.copyWithin(0, upto, len); len -= upto; };
  const keep = (bytes) => { if (bytes.length) { body.push(bytes); bodyLen += bytes.length; } };

  const joined = () => {
    const out = new Uint8Array(bodyLen);
    let at = 0;
    for (const part of body) { out.set(part, at); at += part.length; }
    return out;
  };

  const done = () => ({ ...head, body: joined() });

  /** One CRLF-terminated line from the front of the buffer, or null. */
  const line = () => {
    for (let i = 1; i < len; i++) {
      if (buf[i] === LF && buf[i - 1] === CR) {
        const text = DEC.decode(buf.subarray(0, i - 1));
        consume(i + 1);
        return text;
      }
    }
    return null;
  };

  return {
    push(bytes) {
      grow(bytes.length);
      buf.set(bytes, len);
      len += bytes.length;
      return this.take();
    },

    take() {
      if (!head) {
        const end = endOfHead(buf, len);
        if (end < 0) return null;
        const parsed = parseStatus(DEC.decode(buf.subarray(0, end - 2)));
        consume(end);
        if (!parsed) return { error: MALFORMED };
        head = parsed;
        const encoding = (headerValue(parsed.headers, 'transfer-encoding') || '').toLowerCase();
        const length = headerValue(parsed.headers, 'content-length');
        if (BODILESS.has(parsed.status) || parsed.status < 200) { mode = 'length'; needed = 0; }
        else if (encoding.includes('chunked')) { mode = 'chunked'; }
        else if (length !== null) {
          needed = Number(length);
          if (!Number.isFinite(needed) || needed < 0) return { error: MALFORMED };
          mode = 'length';
        } else { mode = 'close'; }
      }

      if (mode === 'length') {
        const take = Math.min(len, needed - bodyLen);
        if (take > 0) { keep(buf.slice(0, take)); consume(take); }
        return bodyLen >= needed ? done() : null;
      }

      if (mode === 'chunked') {
        for (;;) {
          if (chunkLeft > 0) {
            const take = Math.min(len, chunkLeft);
            if (!take) return null;
            keep(buf.slice(0, take));
            consume(take);
            chunkLeft -= take;
            continue;
          }
          // Between chunks: a bare CRLF closes the one just read, then a size.
          const text = line();
          if (text === null) return null;
          if (text === '') continue;                      // the trailing CRLF
          if (sawTerminator) continue;                    // trailers, ignored
          const size = parseInt(text.split(';')[0], 16);
          if (!Number.isFinite(size) || size < 0) return { error: MALFORMED };
          if (size === 0) { sawTerminator = true; return done(); }
          chunkLeft = size;
        }
      }

      // 'close': everything is body until somebody says it ended.
      if (len) { keep(buf.slice(0, len)); consume(len); }
      return null;
    },

    /**
     * The connection ended. Returns the response if that was a legal way for it
     * to end, and an error if the server stopped mid-promise.
     */
    finish() {
      if (!head) return len ? { error: MALFORMED } : null;
      if (mode === 'close') return done();
      if (mode === 'length' && bodyLen >= needed) return done();
      return { error: 'the server closed before the response was complete' };
    },
  };
}
