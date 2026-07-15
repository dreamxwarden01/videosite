// Server-side host validation for the settings surfaces (site hostname + the
// SSO issuer / account-portal URLs). A "host" is a bare hostname or IPv4
// address with an OPTIONAL :port — no scheme, no path, no whitespace. This is
// the authoritative check; the client mirror (client/src/utils/hostname.js)
// only shapes input. Keep the two in sync.
// (Bracketed IPv6 literals are intentionally not supported.)

// Reduce a value to a bare host[:port]: drop a scheme prefix, everything from
// the first slash/backslash/query/fragment, and all whitespace.
function stripToHost(input) {
  let s = String(input == null ? '' : input).trim();
  s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  s = s.split(/[/\\?#]/)[0];
  s = s.replace(/\s+/g, '');
  return s;
}

const LABEL = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

// A valid bare host[:port]: no spaces/slashes/scheme/path; dotted labels; an
// optional port in 1–65535. All-numeric labels pass, so IPv4 validates too.
function isValidHost(input) {
  const s = String(input == null ? '' : input).trim();
  if (!s || /[\s/\\]/.test(s)) return false;
  let host = s;
  let port = null;
  const i = s.lastIndexOf(':');
  if (i !== -1) { host = s.slice(0, i); port = s.slice(i + 1); }
  if (port !== null) {
    if (!/^\d{1,5}$/.test(port)) return false;
    const p = parseInt(port, 10);
    if (p < 1 || p > 65535) return false;
  }
  if (!host) return false;
  return host.split('.').every((l) => LABEL.test(l));
}

// Split a URL into { protocol, host }; missing/odd scheme → https, host stripped.
function splitHostUrl(url) {
  const s = String(url == null ? '' : url).trim();
  const m = s.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([\s\S]*)$/);
  const protocol = m && m[1].toLowerCase() === 'http' ? 'http' : 'https';
  const host = stripToHost(m ? m[2] : s);
  return { protocol, host };
}

// True when `v` is scheme://<valid-host> (scheme optional; defaults https).
function isHostUrl(v) {
  return isValidHost(splitHostUrl(v).host);
}

// Canonical stored form: `${protocol}://${bare-host}` (path/space/etc. removed).
function normalizeHostUrl(v) {
  const { protocol, host } = splitHostUrl(v);
  return host ? `${protocol}://${host}` : '';
}

module.exports = { stripToHost, isValidHost, splitHostUrl, isHostUrl, normalizeHostUrl };
