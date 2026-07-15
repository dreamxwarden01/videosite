// Admin: DreamSSO connection config + service-to-service mTLS management.
// Backs the two settings cards. All routes require manageSite.
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middleware/auth');
const { checkPermission } = require('../../middleware/permissions');
const { requireStepup } = require('../../middleware/stepup');
const { getSetting } = require('../../services/cache/settingsCache');
const { setSetting } = require('../../services/tokenService');
const mtls = require('../../services/mtlsService');
const oidc = require('../../lib/oidc');
const { isHostUrl, normalizeHostUrl } = require('../../services/hostValidation');

// The SSO connection + mTLS are the most sensitive site settings (a bad edit
// breaks sign-in for everyone), so they ride the same 'settings' step-up scenario
// as the rest of the Settings page. A no-op while the scenario is disabled; when
// enabled, scope='W' still lets the two GET reads through and only gates writes.
router.use('/sso', requireAuth, checkPermission('manageSite'), requireStepup('settings'));

// EDITABLE connection params (external references): the SSO issuer, videosite's
// client_id, and the account-portal URL. videosite's OWN endpoints (callback,
// back-channel) are derived from the site hostname and returned view-only — they
// can't drift from what's registered at the SSO. (Post-logout is dropped: our SSO
// shows a terminal signed-out page and doesn't honor post_logout_redirect_uri.)
// issuer + account_portal are scheme://<bare-host[:port]> (no path/space);
// client_id is a free token with no whitespace. The `host` rule is validated
// and normalized via services/hostValidation.js (mirrors the client).
const EDITABLE = {
  issuer: { key: 'sso_issuer', env: 'SSO_ISSUER', rule: 'host' },
  client_id: { key: 'sso_client_id', env: 'OIDC_CLIENT_ID', rule: 'id' },
  account_portal: { key: 'sso_account_portal_url', env: null, rule: 'host' },
};

async function siteBase() {
  const proto = await getSetting('site_protocol', 'https');
  const host = await getSetting('site_hostname', '');
  return host ? `${proto}://${host}` : null;
}

router.get('/sso/config', async (req, res) => {
  const pick = async (key, env, fb) => {
    const v = await getSetting(key, null);
    return (v != null && v !== '') ? v : (env && process.env[env]) || fb || '';
  };
  const base = await siteBase();
  res.json({
    // editable
    issuer: await pick('sso_issuer', 'SSO_ISSUER'),
    client_id: await pick('sso_client_id', 'OIDC_CLIENT_ID', 'videosite'),
    account_portal: await pick('sso_account_portal_url', null, 'https://account-dev.dreamxwarden.ca'),
    // derived, view-only (videosite's own endpoints — register these at the SSO)
    callback: base ? base + '/auth/callback' : process.env.OIDC_REDIRECT_URI || '',
    backchannel: base ? base + '/backchannel/events' : '',
    jwks: base ? base + '/.well-known/jwks.json' : '',
    client_key: oidc.clientKeyInfo(),
  });
});

// Rotate the client signing key. Safe one-click: the replaced key stays
// published for overlap and the SSO re-fetches our JWKS on the unknown kid.
router.post('/sso/rotate-client-key', async (req, res) => {
  res.json(await oidc.rotateClientKey());
});

router.put('/sso/config', async (req, res) => {
  const body = req.body || {};
  const errors = {};
  for (const [k, def] of Object.entries(EDITABLE)) {
    const v = String(body[k] ?? '').trim();
    if (!v) errors[k] = 'Required';
    else if (def.rule === 'id' && /\s/.test(v)) errors[k] = 'Cannot contain spaces';
    else if (def.rule === 'host' && !isHostUrl(v)) errors[k] = 'Enter a valid hostname or IP address (no spaces, slashes, or path)';
  }
  if (Object.keys(errors).length) return res.status(422).json({ errors });
  for (const [k, def] of Object.entries(EDITABLE)) {
    const v = String(body[k]).trim();
    await setSetting(def.key, def.rule === 'host' ? normalizeHostUrl(v) : v);
  }
  await oidc.loadConfig(); // apply to the live OIDC flow immediately
  res.status(204).end();
});

// --- mTLS ---
router.get('/sso/mtls', async (req, res) => res.json(await mtls.getStatus()));

router.post('/sso/mtls/csr', async (req, res) => {
  res.json(await mtls.startSetup(req.body && req.body.cn));
});

router.post('/sso/mtls/cert', async (req, res) => {
  const r = await mtls.installCert(req.body && req.body.cert);
  if (!r.ok) return res.status(422).json({ error: r.reason });
  res.json(r);
});

router.put('/sso/mtls/enforce', async (req, res) => {
  const r = await mtls.setEnforce(!!(req.body && req.body.enabled));
  if (!r.ok) return res.status(422).json({ error: r.reason });
  res.status(204).end();
});

router.delete('/sso/mtls', async (req, res) => {
  await mtls.reset();
  res.status(204).end();
});

module.exports = router;
