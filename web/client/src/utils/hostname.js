// Host input helpers for the settings surfaces (site hostname + the SSO
// issuer / account-portal URLs). A "host" here is a bare hostname or IPv4
// address with an OPTIONAL :port — no scheme, no path, no whitespace. Mirrored
// server-side in services/hostValidation.js — keep the two in sync.
// (Bracketed IPv6 literals are intentionally not supported.)

// Reduce any pasted/typed value to a bare host[:port]: drop a scheme prefix,
// everything from the first slash/backslash/query/fragment, and all whitespace.
export function stripToHost(input) {
  let s = String(input == null ? '' : input).trim();
  s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, ''); // scheme://
  s = s.split(/[/\\?#]/)[0]; // path / query / fragment / stray backslash
  s = s.replace(/\s+/g, ''); // no whitespace anywhere
  return s;
}

// One DNS label: 1–63 chars, alphanumeric + internal hyphens. All-numeric
// labels are allowed, so IPv4 addresses validate as a byproduct.
const LABEL = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

// A valid bare host[:port]: no spaces/slashes/scheme/path; dotted labels; an
// optional port in 1–65535.
export function isValidHost(input) {
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

// Split a stored URL into { protocol, host } for the dropdown + input pair.
// A missing/odd scheme defaults to https; the host is stripped to bare form.
export function splitHostUrl(url) {
  const s = String(url == null ? '' : url).trim();
  const m = s.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([\s\S]*)$/);
  const protocol = m && m[1].toLowerCase() === 'http' ? 'http' : 'https';
  const host = stripToHost(m ? m[2] : s);
  return { protocol, host };
}

// Reconstruct the stored URL; empty host → empty string (an unset value).
export function joinHostUrl(protocol, host) {
  const p = protocol === 'http' ? 'http' : 'https';
  return host ? `${p}://${host}` : '';
}
