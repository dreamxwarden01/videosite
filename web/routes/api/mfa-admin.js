const express = require('express');
const router = express.Router();

const { requireAuth } = require('../../middleware/auth');
const { checkPermission } = require('../../middleware/permissions');
const { requireStepup, scenarioPolicy, stepupMethodsForLevel, windowSecondsFor, stepupState } = require('../../middleware/stepup');
const { getMfaSettings } = require('../../services/mfaService');
const { getPool } = require('../../config/database');

// All routes require auth + manageSite permission. MFA settings folded into the
// unified /admin/settings surface (one superadmin-tier gate); the former
// manageSiteMFA permission was dropped. Per-scenario step-up still applies below.
router.use('/admin/mfa', requireAuth, checkPermission('manageSite'));

// login + invitation_codes scenarios left with the SSO migration (login MFA is the
// SSO's job; invitation codes moved there wholesale); course deletion is gated by
// the SSO step-up on its own route.
// Step-up scenarios (settings-driven). playback_stats dropped (folded into course +
// user pages) and mfa dropped (MFA settings merged into site settings, covered by
// the 'settings' scenario). Each row is the mfa_policy_<scenario> setting.
const KNOWN_SCENARIOS = [
  'enrollment', 'user', 'roles', 'transcoding', 'settings'
];

// Helper: upsert a site setting
async function upsertSetting(key, value) {
  const pool = getPool();
  await pool.execute(
    'INSERT INTO site_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
    [key, String(value)]
  );
  await require('../../services/cache/settingsCache').invalidate();
}

// ---------------------------------------------------------------------------
// GET /admin/mfa/settings — return all MFA settings + scenario policies
// ---------------------------------------------------------------------------
router.get('/admin/mfa/settings', requireStepup('settings'), async (req, res) => {
  try {
    const allSettings = await getMfaSettings();

    // The step-up sudo-window durations (the pending-challenge timeout is gone —
    // the SSO txn TTL governs the in-flight challenge). one-time = the one-time
    // window; level_1/level_2 = the persistent window per level.
    const general = {
      onetime_timeout_seconds: parseInt(allSettings.mfa_onetime_challenge_timeout_seconds || '600', 10),
      level_1_timeout_seconds: parseInt(allSettings.mfa_level_1_timeout_seconds || '3600', 10),
      level_2_timeout_seconds: parseInt(allSettings.mfa_level_2_timeout_seconds || '600', 10),
    };

    const policies = {};
    for (const scenario of KNOWN_SCENARIOS) {
      const raw = allSettings['mfa_policy_' + scenario];
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          // Migrate legacy 'session' → 'persistent'
          if (parsed.reuse === 'session') parsed.reuse = 'persistent';
          policies[scenario] = parsed;
        } catch {
          policies[scenario] = { enabled: false, level: 1, scope: 'W', reuse: 'persistent' };
        }
      } else {
        policies[scenario] = { enabled: false, level: 1, scope: 'W', reuse: 'persistent' };
      }
    }

    res.json({ general, policies });
  } catch (err) {
    console.error('GET /admin/mfa/settings error:', err);
    res.status(500).json({ error: 'Failed to load MFA settings' });
  }
});

// ---------------------------------------------------------------------------
// PUT /admin/mfa/settings/general — the step-up window durations (one-time +
// per-level persistent windows), merged into one save. Pending timeout removed.
// ---------------------------------------------------------------------------
router.put('/admin/mfa/settings/general', requireStepup('settings'), async (req, res) => {
  try {
    const onetime = parseInt(req.body.onetime_timeout_seconds, 10);
    const level1 = parseInt(req.body.level_1_timeout_seconds, 10);
    const level2 = parseInt(req.body.level_2_timeout_seconds, 10);

    if (isNaN(onetime) || onetime < 60 || onetime > 3600) {
      return res.status(400).json({ error: 'One-time window must be 60–3600 seconds (1–60 minutes)' });
    }
    if (isNaN(level1) || level1 < 60 || level1 > 31536000) {
      return res.status(400).json({ error: 'Level 1 window must be 60–31536000 seconds' });
    }
    if (isNaN(level2) || level2 < 60 || level2 > 31536000) {
      return res.status(400).json({ error: 'Level 2 window must be 60–31536000 seconds' });
    }
    // A stronger level shouldn't outlast a weaker one.
    if (level2 > level1) {
      return res.status(400).json({ error: 'Level 2 window must not exceed Level 1' });
    }

    await upsertSetting('mfa_onetime_challenge_timeout_seconds', onetime);
    await upsertSetting('mfa_level_1_timeout_seconds', level1);
    await upsertSetting('mfa_level_2_timeout_seconds', level2);

    res.status(204).end();
  } catch (err) {
    console.error('PUT /admin/mfa/settings/general error:', err);
    res.status(500).json({ error: 'Failed to save step-up windows' });
  }
});

// ---------------------------------------------------------------------------
// PUT /admin/mfa/settings/policy/:scenario
// ---------------------------------------------------------------------------
// Validate one incoming policy → { enabled, level, scope, reuse } or throws a
// 400-worthy message.
function validatePolicy(scenario, raw) {
  if (!KNOWN_SCENARIOS.includes(scenario)) throw new Error('Unknown scenario: ' + scenario);
  const level = parseInt(raw && raw.level, 10);
  if (![1, 2].includes(level)) throw new Error(`Level must be 1 or 2 (${scenario})`);
  if (!['W', 'RW'].includes(raw && raw.scope)) throw new Error(`Scope must be 'W' or 'RW' (${scenario})`);
  let reuse = raw && raw.reuse === 'session' ? 'persistent' : (raw && raw.reuse);
  if (!['persistent', 'one-time'].includes(reuse)) throw new Error(`Reuse must be 'persistent' or 'one-time' (${scenario})`);
  return { enabled: !!(raw && raw.enabled), level, scope: raw.scope, reuse };
}

// PUT /admin/mfa/settings/policies — save the whole changed grid in ONE request.
// Body: { policies: { <scenario>: { enabled, level, scope, reuse } } } (send only
// the changed rows). Validated all-or-nothing, then upserted.
router.put('/admin/mfa/settings/policies', requireStepup('settings'), async (req, res) => {
  try {
    const incoming = req.body && req.body.policies;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return res.status(400).json({ error: 'A policies object is required' });
    }
    const validated = {};
    for (const [scenario, raw] of Object.entries(incoming)) {
      try { validated[scenario] = validatePolicy(scenario, raw); }
      catch (e) { return res.status(400).json({ error: e.message }); }
    }

    // Self-protection: enabling 'settings' (or raising its level) will gate this very
    // editor, so require a FRESH step-up at the TARGET level first — the admin proves
    // they can satisfy the policy before it takes effect. The route's own
    // requireStepup uses the CURRENT settings level (possibly disabled → no gate), so
    // this is the enable/raise transition guard.
    if (validated.settings && validated.settings.enabled) {
      const current = await scenarioPolicy('settings');
      const raising = !current.enabled || validated.settings.level > current.level;
      if (raising) {
        const targetMethods = stepupMethodsForLevel(validated.settings.level);
        const windowMs = (await windowSecondsFor(validated.settings)) * 1000;
        const st = await stepupState(res.locals.user.session_id, targetMethods, windowMs);
        if (!st.satisfied) {
          return res.status(403).json({
            error: 'Identity verification required',
            code: 'step_up_required',
            accepted: targetMethods,
            scenario: 'settings',
          });
        }
      }
    }

    for (const [scenario, policy] of Object.entries(validated)) {
      await upsertSetting('mfa_policy_' + scenario, JSON.stringify(policy));
    }
    res.status(204).end();
  } catch (err) {
    console.error('PUT /admin/mfa/settings/policies error:', err);
    res.status(500).json({ error: 'Failed to save policies' });
  }
});

module.exports = router;
