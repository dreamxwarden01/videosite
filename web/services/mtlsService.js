// Service-to-service mTLS client certificate management.
//
// The private key is generated on videosite (ECDSA P-256 — faster and smaller
// than RSA, and Cloudflare issues ECC client certs) and never leaves;
// @peculiar/x509 builds the PKCS#10 CSR (Node has no native CSR API, and
// node-forge can't do EC). The issued certificate is validated with Node's
// X509Certificate: it must not be expired and its public key must match the
// key the CSR was made from. Private key is stored encrypted
// (settingsEncryption); the cert is public (plain setting).
require('reflect-metadata'); // @peculiar/x509 (CJS) needs the polyfill loaded first
const x509 = require('@peculiar/x509');
const { webcrypto, X509Certificate, createPublicKey, randomBytes } = require('crypto');
const { getSecretSetting, setSecretSetting } = require('./settingsEncryption');
const { getSetting } = require('./cache/settingsCache');
const { setSetting } = require('./tokenService');

x509.cryptoProvider.set(webcrypto);

const K = {
  cert: 'mtls_cert',
  cn: 'mtls_cn',
  enforce: 'mtls_enforce',
  activeKey: 'mtls_private_key', // encrypted
  pendingKey: 'mtls_pending_key', // encrypted — set during setup, before the cert lands
  pendingCn: 'mtls_pending_cn',
};

const randomCn = () => 'videosite-' + randomBytes(9).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);

const EC_ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };

async function genKeyAndCsr(cn) {
  const keys = await webcrypto.subtle.generateKey(EC_ALG, true, ['sign', 'verify']);
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: [{ CN: [cn] }], // JSON name form — no DN-string parsing of user input
    keys,
    signingAlgorithm: EC_ALG,
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  const privateKeyPem =
    '-----BEGIN PRIVATE KEY-----\n' +
    pkcs8.toString('base64').match(/.{1,64}/g).join('\n') +
    '\n-----END PRIVATE KEY-----\n';
  return { privateKeyPem, csrPem: csr.toString('pem') };
}

const PEM_CERT_RE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

function certInfo(certPem) {
  // The stored value may be a chain (normalized leaf-first) — describe the leaf.
  const c = new X509Certificate((certPem.match(PEM_CERT_RE) || [certPem])[0]);
  return {
    cn: (c.subject.match(/CN=(.+)/) || [])[1]?.trim() || null,
    issuer: (c.issuer.match(/CN=(.+)/) || [])[1]?.trim() || c.issuer.replace(/\n/g, ', ') || null,
    // ISO UTC — the client renders local time
    not_before: new Date(c.validFrom).toISOString(),
    not_after: new Date(c.validTo).toISOString(),
    expired: new Date(c.validTo) < new Date(),
  };
}

// Accepts a single cert OR a full chain (leaf + intermediates, any order): the
// leaf is the block whose public key matches ours; expiry is checked on the
// leaf only; the returned chain is normalized LEAF-FIRST — the order Node's
// TLS `cert` option wants, so the whole chain is presented in the handshake.
function validateCertAgainstKey(certPem, keyPem) {
  const blocks = certPem.match(PEM_CERT_RE);
  if (!blocks || blocks.length === 0) return { ok: false, reason: 'parse_failed' };
  let parsed;
  try {
    parsed = blocks.map((b) => new X509Certificate(b));
  } catch {
    return { ok: false, reason: 'parse_failed' };
  }
  let keySpki;
  try {
    keySpki = createPublicKey(keyPem).export({ type: 'spki', format: 'der' });
  } catch {
    return { ok: false, reason: 'key_mismatch' };
  }
  const idx = parsed.findIndex((c) => {
    try {
      return c.publicKey.export({ type: 'spki', format: 'der' }).equals(keySpki);
    } catch {
      return false;
    }
  });
  if (idx === -1) return { ok: false, reason: 'key_mismatch' };
  if (new Date(parsed[idx].validTo) < new Date()) return { ok: false, reason: 'expired' };
  const chain = [blocks[idx], ...blocks.filter((_, i) => i !== idx)].join('\n');
  return { ok: true, chain };
}

async function getStatus() {
  const cert = await getSetting(K.cert, null);
  const pending = !!(await getSecretSetting(K.pendingKey, null));
  if (!cert) return { state: 'not_configured', enforce: false, pending };
  const info = certInfo(cert);
  const enforce = (await getSetting(K.enforce, 'false')) === 'true';
  return { state: 'configured', enforce: enforce && !info.expired, ...info };
}

// Step 1: generate a key (kept) + CSR (shown). Auto-names the CN if blank.
async function startSetup(cnInput) {
  const cn = cnInput && cnInput.trim() ? cnInput.trim().slice(0, 64) : randomCn();
  const { privateKeyPem, csrPem } = await genKeyAndCsr(cn);
  await setSecretSetting(K.pendingKey, privateKeyPem);
  await setSetting(K.pendingCn, cn);
  return { cn, csr: csrPem };
}

// Step 2 (setup) / renew: validate the issued cert against the matching key,
// then store it. Setup promotes the pending key; renew keeps the active key.
async function installCert(certPem) {
  certPem = String(certPem || '').trim();
  if (!certPem) return { ok: false, reason: 'no_cert' };
  const pendingKey = await getSecretSetting(K.pendingKey, null);
  const activeKey = await getSecretSetting(K.activeKey, null);
  const key = pendingKey || activeKey;
  if (!key) return { ok: false, reason: 'no_key' };

  const v = validateCertAgainstKey(certPem, key);
  if (!v.ok) return v;
  const info = certInfo(v.chain);

  if (pendingKey) {
    await setSecretSetting(K.activeKey, pendingKey);
    await setSetting(K.pendingKey, '');
    await setSetting(K.pendingCn, '');
  }
  await setSetting(K.cert, v.chain);
  await setSetting(K.cn, info.cn || '');
  // Auto-enable enforcement on EVERY valid install — setup or renew (product
  // decision: a new cryptographically valid cert should be immediately active).
  // validateCertAgainstKey already proved key-match + not-expired; getStatus/
  // outboundIdentity still mask it off if the cert later expires.
  await setSetting(K.enforce, 'true');
  return { ok: true, ...info };
}

async function setEnforce(enabled) {
  if (enabled) {
    const cert = await getSetting(K.cert, null);
    if (!cert) return { ok: false, reason: 'not_configured' };
    if (certInfo(cert).expired) return { ok: false, reason: 'expired' };
  }
  await setSetting(K.enforce, enabled ? 'true' : 'false');
  return { ok: true };
}

async function reset() {
  for (const k of [K.cert, K.cn, K.activeKey, K.pendingKey, K.pendingCn]) await setSetting(k, '');
  await setSetting(K.enforce, 'false');
  return { ok: true };
}

// Material for the outbound S2S dispatcher (s2sFetch): null unless enforcement
// is on and a live cert + key are present.
async function outboundIdentity() {
  if ((await getSetting(K.enforce, 'false')) !== 'true') return null;
  const cert = await getSetting(K.cert, null);
  const key = await getSecretSetting(K.activeKey, null);
  if (!cert || !key || certInfo(cert).expired) return null;
  return { cert, key };
}

module.exports = { getStatus, startSetup, installCert, setEnforce, reset, outboundIdentity };
