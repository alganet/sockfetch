// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// What a request is allowed to become on its way out: the scheme it gets, the
// headers it keeps, the origins it may reach, and the address a name resolves
// to.
//
// Separated from the codec because these are the decisions an embedder wants to
// change and the codec's are not. A page that fronts one proxy, a test that
// stubs the network and a runtime that must refuse everything outside an
// allowlist all want the same parser and a different policy.

/** Names `fetch()` refuses to let a caller set. Dropping them is not a choice. */
const FORBIDDEN = new Set([
  'accept-charset', 'accept-encoding', 'access-control-request-headers',
  'access-control-request-method', 'connection', 'content-length', 'cookie',
  'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin',
  'referer', 'set-cookie', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  'via',
]);

/** Prefixes the same rule covers. */
const FORBIDDEN_PREFIX = ['proxy-', 'sec-'];

/**
 * Names that are legal to send and would cost a CORS preflight, for nothing.
 *
 * `User-Agent` is the whole list and the reason the list exists: busybox wget
 * puts one on EVERY request, PHP puts one on every request the `user_agent` ini
 * names, and either makes the request non-simple — so the browser sends an
 * OPTIONS first, which almost no CORS-open origin answers, and every fetch
 * fails. The header buys nothing across this boundary: the browser sends its
 * own, and no origin's behaviour should turn on which shell asked.
 *
 * Nothing else goes here on purpose. A custom header that MEANS something —
 * `Authorization`, an `X-` anything — is forwarded and takes its preflight,
 * because a request that cannot be made as asked should fail rather than
 * quietly become a different request.
 */
const COSMETIC = new Set(['user-agent']);

const isForbidden = (name) =>
  FORBIDDEN.has(name) || FORBIDDEN_PREFIX.some((p) => name.startsWith(p));

/**
 * The alias range, and it is Emscripten's rather than one of our choosing.
 *
 * `libcore.js`'s `$DNS` maps hostnames into 172.29.*.* — "we can't actually
 * resolve hostnames in the browser", says the comment above it — and a PHP
 * built with Emscripten therefore already reports addresses out of that block.
 * Matching it means the two guests this package serves describe the same host
 * the same way, and that the address a script prints reads as an ordinary
 * machine behind a NAT rather than as a tell.
 *
 * There is no real address to be had. `fetch()` never reveals the peer and the
 * browser exposes no resolver, so an address here is an ALIAS with a reverse
 * map behind it and nothing more. See `resolve` in the options for the hook
 * where a DoH resolver could sit — and note that its answer still would not be
 * the address the browser connected to.
 */
const ALIAS_PREFIX = '172.29.';
const ALIAS_MAX = 0xffff;

/** Is this already a literal IPv4 address? Then it resolves to itself. */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Build a policy.
 *
 * @param {object} [options]
 * @param {(url: URL) => boolean} [options.allow] refuse an origin outright
 * @param {(url: URL) => URL|string} [options.rewrite] send it somewhere else
 *   (a CORS proxy); applied after `allow`
 * @param {(hostname: string) => string|null} [options.resolve] supply the
 *   address for a name; `null` falls through to the alias allocator
 * @param {boolean} [options.credentials] send cookies and auth. Off, and it
 *   should stay off: the guest is not the browser's user.
 */
export function createPolicy(options = {}) {
  const { allow, rewrite, resolve } = options;
  const credentials = options.credentials ? 'include' : 'omit';

  // Both directions of the alias map. `names` is what makes a connect() to an
  // address we handed out resolvable back to the name it stood for — needed
  // only when a request arrives with no Host header, which HTTP/1.1 forbids
  // and HTTP/1.0 allows.
  const addrs = new Map();
  const names = new Map();
  let next = 1;

  return {
    /**
     * The scheme a port implies.
     *
     * 443 is https and everything else is http, which is not a guess about the
     * origin so much as a statement about the guest: it speaks plaintext
     * always (its TLS is bypassed — see the phasm transport shim and busybox's
     * FEATURE_WGET_HTTPS staying off), so the port is the ONLY thing left that
     * says which scheme was meant.
     */
    schemeFor(port) {
      return port === 443 ? 'https' : 'http';
    },

    /** The URL a parsed request is asking for, or null if it is unusable. */
    urlFor({ host, port, target }) {
      // An absolute target is what a request through a proxy looks like, and
      // it wins over Host — that is what a proxy would do with it.
      if (/^https?:\/\//i.test(target)) {
        try { return new URL(target); } catch { return null; }
      }
      if (!host) return null;
      const scheme = this.schemeFor(port);
      // The Host header carries its own port when it is not the default, and
      // it is authoritative: a client that connected to 8080 and said
      // `Host: example.com` means 8080 either way.
      const authority = host.includes(':') || (port === 80 || port === 443)
        ? host
        : `${host}:${port}`;
      try { return new URL(target, `${scheme}://${authority}`); } catch { return null; }
    },

    /**
     * The headers that survive the crossing.
     *
     * Returns `{ headers, dropped }` rather than just the headers: the caller
     * cannot report a drop to the guest — there is no channel for it — but a
     * test can assert it and an embedder can log it, and a silent drop nobody
     * can observe is how this kind of shim earns its reputation.
     */
    headersFor(entries) {
      const headers = [];
      const dropped = [];
      for (const [rawName, value] of entries) {
        const name = rawName.toLowerCase();
        if (isForbidden(name) || COSMETIC.has(name)) { dropped.push(name); continue; }
        headers.push([rawName, value]);
      }
      return { headers, dropped };
    },

    /** May this URL be reached at all? */
    allow(url) {
      return allow ? !!allow(url) : true;
    },

    /** Where the request actually goes. */
    rewrite(url) {
      if (!rewrite) return url;
      const next = rewrite(url);
      return typeof next === 'string' ? new URL(next) : next;
    },

    credentials,

    /** A name's address: the caller's resolver, a literal, or an alias. */
    resolve(hostname) {
      const name = String(hostname).toLowerCase();
      if (IPV4.test(name)) return name;
      const given = resolve && resolve(name);
      if (given) { names.set(given, name); addrs.set(name, given); return given; }
      const known = addrs.get(name);
      if (known) return known;
      if (next > ALIAS_MAX) return null;   // 65535 names is a session gone wrong
      const id = next++;
      const addr = `${ALIAS_PREFIX}${(id >> 8) & 0xff}.${id & 0xff}`;
      addrs.set(name, addr);
      names.set(addr, name);
      return addr;
    },

    /** The name an alias stood for, if it was one of ours. */
    nameOf(addr) {
      return names.get(addr) || null;
    },
  };
}
