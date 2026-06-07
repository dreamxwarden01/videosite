// Worker auth IP helpers.
//
// Two kinds of IP comparison happen:
//
//  1. Session matching (middleware/workerAuth.js): is the request coming from
//     "the same machine" as the one that authenticated? For IPv6 we treat any
//     two addresses sharing the same /64 prefix as the same machine, so a
//     privacy-extension rotation within a customer prefix doesn't invalidate
//     the bearer token. For IPv4 we compare full /32.
//
//  2. Leak detection (services/workerAuthService.js): is this sign-in IP one
//     we've seen before for the same key within the last 60s? Here we want
//     /128 exact-match on IPv6, full /32 on IPv4 — a privacy-extension
//     rotation that legitimately happens within /64 produces a brand-new
//     /128 (never duplicates an old one), so the leak detector won't false-
//     positive on it.
//
// Inputs may come from a variety of sources (Express req.ip, X-Forwarded-For,
// :: 1, fe80::%scope, IPv4-mapped IPv6 like ::ffff:1.2.3.4). normalizeIP
// produces a canonical string suitable for storage / comparison; matchIP
// applies the /64 vs /32 rule.

const net = require('net');

// Returns the canonical full form of an IPv6 address:
// 8 colon-separated lowercase 4-hex-digit groups, no '::' compression, no
// trailing IPv4 dotted-quad. Returns null on parse failure.
function expandIPv6(addr) {
    if (!addr || !net.isIPv6(addr)) return null;

    // Strip zone identifier (fe80::1%eth0) — never travels on the wire so
    // it's only meaningful at the kernel level. Trim before parsing.
    let s = addr.toLowerCase();
    const pct = s.indexOf('%');
    if (pct >= 0) s = s.slice(0, pct);

    // Convert trailing IPv4 dotted-quad (e.g. ::ffff:1.2.3.4) into two hex
    // groups so we get the standard 8-group form.
    const v4match = s.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4match) {
        const parts = v4match[2].split('.').map(n => parseInt(n, 10));
        if (parts.some(n => !(n >= 0 && n <= 255))) return null;
        const hex1 = ((parts[0] << 8) | parts[1]).toString(16);
        const hex2 = ((parts[2] << 8) | parts[3]).toString(16);
        s = v4match[1] + hex1 + ':' + hex2;
    }

    // Split on the (at most one) '::' elision marker, then materialise the
    // missing zero groups in the gap.
    const halves = s.split('::');
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    if (halves.length === 1 && left.length !== 8) return null;
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    const groups = [
        ...left,
        ...Array(missing).fill('0'),
        ...right,
    ];
    if (groups.length !== 8) return null;
    if (groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return null;
    return groups.map(g => g.padStart(4, '0')).join(':');
}

// Canonical /128 string suitable for storage in Redis / DB and exact equality
// checks. IPv4 is returned as-is (already canonical). Anything that doesn't
// parse as a valid IP is returned unchanged so we don't silently lose data,
// though it won't match anything useful.
function normalizeIP(addr) {
    if (!addr) return '';
    if (net.isIPv4(addr)) return addr;
    if (net.isIPv6(addr)) {
        const exp = expandIPv6(addr);
        return exp || addr;
    }
    return addr;
}

// /64 prefix of a normalised IPv6 (first 4 hex groups). Returns null for non-
// IPv6 inputs.
function ipv6Prefix64(addr) {
    const exp = expandIPv6(addr);
    if (!exp) return null;
    return exp.split(':').slice(0, 4).join(':');
}

// True if `a` and `b` represent the same "machine" for worker-session purposes.
// /64 match for IPv6 pairs, full /32 match for IPv4 pairs. Mixed families never
// match. Empty inputs never match (caller decides what to do with that).
function ipMatchesSession(a, b) {
    if (!a || !b) return false;
    if (net.isIPv4(a) && net.isIPv4(b)) return a === b;
    if (net.isIPv6(a) && net.isIPv6(b)) {
        const pa = ipv6Prefix64(a);
        const pb = ipv6Prefix64(b);
        return pa !== null && pa === pb;
    }
    return false;
}

module.exports = {
    expandIPv6,
    normalizeIP,
    ipv6Prefix64,
    ipMatchesSession,
};
