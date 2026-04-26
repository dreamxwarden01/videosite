const express = require('express');
const router = express.Router();

const { requireAuth } = require('../../middleware/auth');
const { checkPermission } = require('../../middleware/permissions');
const { requireMfaForScenario } = require('../../middleware/mfa');
const {
  getMfaSettings, isUserMfaEnabled, getUserMfaMethodTypes,
  getAllowedMethodsForLevel, getScenarioPolicy, createChallenge,
  validateChallenge, consumeChallenge, maskEmail,
  ensureBmfa, rotateBmfaIfNeeded
} = require('../../services/mfaService');
const { getPool } = require('../../config/database');

// All routes require auth + manageSiteMFA permission
router.use('/admin/mfa', requireAuth, checkPermission('manageSiteMFA'));

const KNOWN_SCENARIOS = [
  'login', 'course', 'enrollment', 'user', 'invitation_codes',
  'roles', 'playback_stats', 'transcoding', 'settings', 'mfa'
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
router.get('/admin/mfa/settings', requireMfaForScenario('mfa'), async (req, res) => {
  try {
    const allSettings = await getMfaSettings();

    const general = {
      mfa_pending_challenge_timeout_seconds: parseInt(allSettings.mfa_pending_challenge_timeout_seconds || '900', 10),
      mfa_onetime_challenge_timeout_seconds: parseInt(allSettings.mfa_onetime_challenge_timeout_seconds || '600', 10),
      mfa_otp_timeout_seconds: parseInt(allSettings.mfa_otp_timeout_seconds || '300', 10),
    };

    const levels = {
      level_0: parseInt(allSettings.mfa_level_0_timeout_seconds || '604800', 10),
      level_1: parseInt(allSettings.mfa_level_1_timeout_seconds || '3600', 10),
      level_2: parseInt(allSettings.mfa_level_2_timeout_seconds || '600', 10),
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
          policies[scenario] = { enabled: false, level: 0, scope: 'W', reuse: 'persistent' };
        }
      } else {
        policies[scenario] = { enabled: false, level: 0, scope: 'W', reuse: 'persistent' };
      }
    }

    res.json({ general, levels, policies });
  } catch (err) {
    console.error('GET /admin/mfa/settings error:', err);
    res.status(500).json({ error: 'Failed to load MFA settings' });
  }
});

// ---------------------------------------------------------------------------
// PUT /admin/mfa/settings/general
// ---------------------------------------------------------------------------
router.put('/admin/mfa/settings/general', requireMfaForScenario('mfa'), async (req, res) => {
  try {
    const { mfa_pending_challenge_timeout_seconds, mfa_onetime_challenge_timeout_seconds, mfa_otp_timeout_seconds } = req.body;

    const challengeTimeout = parseInt(mfa_pending_challenge_timeout_seconds, 10);
    const onetimeTimeout = parseInt(mfa_onetime_challenge_timeout_seconds, 10);
    const otpTimeout = parseInt(mfa_otp_timeout_seconds, 10);

    // Validate ranges
    if (isNaN(challengeTimeout) || challengeTimeout < 600 || challengeTimeout > 7200) {
      return res.status(400).json({ error: 'Challenge timeout must be between 600 and 7200 seconds (10-120 minutes)' });
    }
    if (isNaN(onetimeTimeout) || onetimeTimeout < 60 || onetimeTimeout > 3600) {
      return res.status(400).json({ error: 'One-time challenge timeout must be between 60 and 3600 seconds (1-60 minutes)' });
    }
    if (onetimeTimeout > challengeTimeout) {
      return res.status(400).json({ error: 'One-time challenge timeout must not exceed the pending challenge timeout' });
    }
    if (isNaN(otpTimeout) || otpTimeout < 180 || otpTimeout > 3600) {
      return res.status(400).json({ error: 'OTP timeout must be between 180 and 3600 seconds (3-60 minutes)' });
    }
    if (otpTimeout > challengeTimeout) {
      return res.status(400).json({ error: 'OTP timeout must not exceed the challenge timeout' });
    }

    await upsertSetting('mfa_pending_challenge_timeout_seconds', challengeTimeout);
    await upsertSetting('mfa_onetime_challenge_timeout_seconds', onetimeTimeout);
    await upsertSetting('mfa_otp_timeout_seconds', otpTimeout);

    res.status(204).end();
  } catch (err) {
    console.error('PUT /admin/mfa/settings/general error:', err);
    res.status(500).json({ error: 'Failed to save general MFA settings' });
  }
});

// ---------------------------------------------------------------------------
// PUT /admin/mfa/settings/levels
// ---------------------------------------------------------------------------
router.put('/admin/mfa/settings/levels', requireMfaForScenario('mfa'), async (req, res) => {
  try {
    const { level_0, level_1, level_2 } = req.body;

    const parsedLevels = {};
    for (const [label, key, val] of [['Level 0', 'level_0', level_0], ['Level 1', 'level_1', level_1], ['Level 2', 'level_2', level_2]]) {
      const parsed = parseInt(val, 10);
      if (isNaN(parsed) || parsed < 60 || parsed > 31536000) {
        return res.status(400).json({ error: `${label} timeout must be between 60 and 31536000 seconds` });
      }
      parsedLevels[key] = parsed;
    }

    // Higher verification levels must have shorter or equal timeouts
    if (parsedLevels.level_1 > parsedLevels.level_0) {
      return res.status(400).json({ error: 'Level 1 timeout must not exceed Level 0 timeout' });
    }
    if (parsedLevels.level_2 > parsedLevels.level_1) {
      return res.status(400).json({ error: 'Level 2 timeout must not exceed Level 1 timeout' });
    }

    await upsertSetting('mfa_level_0_timeout_seconds', parsedLevels.level_0);
    await upsertSetting('mfa_level_1_timeout_seconds', parsedLevels.level_1);
    await upsertSetting('mfa_level_2_timeout_seconds', parsedLevels.level_2);

    res.status(204).end();
  } catch (err) {
    console.error('PUT /admin/mfa/settings/levels error:', err);
    res.status(500).json({ error: 'Failed to save level timeouts' });
  }
});

// ---------------------------------------------------------------------------
// PUT /admin/mfa/settings/policy/:scenario
// ---------------------------------------------------------------------------
router.put('/admin/mfa/settings/policy/:scenario', requireMfaForScenario('mfa'), async (req, res) => {
  try {
    const { scenario } = req.params;
    if (!KNOWN_SCENARIOS.includes(scenario)) {
      return res.status(400).json({ error: 'Unknown scenario: ' + scenario });
    }

    let { enabled, level, scope, reuse } = req.body;

    // Force login constraints
    if (scenario === 'login') {
      level = 0;
      scope = 'W';
    }

    // Validate level
    level = parseInt(level, 10);
    if (![0, 1, 2].includes(level)) {
      return res.status(400).json({ error: 'Level must be 0, 1, or 2' });
    }

    // Validate scope
    if (!['W', 'RW'].includes(scope)) {
      return res.status(400).json({ error: "Scope must be 'W' or 'RW'" });
    }

    // Validate reuse (accept legacy 'session' and convert)
    if (reuse === 'session') reuse = 'persistent';
    if (!['persistent', 'one-time'].includes(reuse)) {
      return res.status(400).json({ error: "Reuse must be 'persistent' or 'one-time'" });
    }

    const userId = res.locals.user.user_id;

    // For login/mfa scenarios: check admin has MFA enabled with methods satisfying the target level
    if (enabled && (scenario === 'login' || scenario === 'mfa')) {
      const hasMfa = await isUserMfaEnabled(userId);
      if (!hasMfa) {
        return res.status(400).json({ error: 'You must have MFA enabled on your account before enabling this policy' });
      }

      const userMethods = await getUserMfaMethodTypes(userId);
      const requiredMethods = getAllowedMethodsForLevel(level);
      const overlap = userMethods.filter(m => requiredMethods.includes(m));
      if (overlap.length === 0) {
        const methodHint = level === 2 ? 'a passkey' : level === 1 ? 'an authenticator or passkey' : 'an active MFA method';
        return res.status(400).json({ error: `You must have ${methodHint} before setting this verification level` });
      }
    }

    // For "mfa" scenario: require a one-time MFA challenge at max(current level, new level)
    if (scenario === 'mfa') {
      const currentPolicy = await getScenarioPolicy('mfa');
      const currentLevel = currentPolicy.enabled ? currentPolicy.level : 0;
      const challengeLevel = Math.max(currentLevel, enabled ? level : 0);

      // Only require challenge if the policy is currently enabled or being enabled
      if (currentPolicy.enabled || enabled) {
        const bmfaToken = await ensureBmfa(req, res);
        const challengeId = req.headers['x-mfa-challenge'];
        if (challengeId) {
          const result = await validateChallenge(challengeId, userId, bmfaToken, challengeLevel, req.originalUrl);
          if (!result.valid) {
            return res.status(403).json({ error: 'Invalid or expired verification', requireMFA: true });
          }
          await consumeChallenge(challengeId);
          await rotateBmfaIfNeeded(req, res, bmfaToken);
        } else {
          // Check user can satisfy the challenge level
          const hasMfa = await isUserMfaEnabled(userId);
          if (hasMfa) {
            const userMethods = await getUserMfaMethodTypes(userId);
            const requiredMethods = getAllowedMethodsForLevel(challengeLevel);
            const overlap = userMethods.filter(m => requiredMethods.includes(m));
            if (overlap.length === 0) {
              const methodHint = challengeLevel === 2 ? 'a passkey' : challengeLevel === 1 ? 'an authenticator or passkey' : 'an active MFA method';
              return res.status(400).json({ error: `You must have ${methodHint} to modify this policy at the required verification level` });
            }
          }

          // Create challenge
          const challenge = await createChallenge({
            userId,
            contextType: 'bmfa',
            contextId: bmfaToken,
            approvedEndpoint: req.originalUrl,
            mfaLevel: challengeLevel,
            messageType: 'admin_operation',
            messageOperation: 'Change MFA policy',
            canReuse: false
          });

          const pool = getPool();
          const [[userRow]] = await pool.execute('SELECT email FROM users WHERE user_id = ?', [userId]);
          const maskedEmail = userRow && userRow.email ? maskEmail(userRow.email) : null;

          // Filter allowed methods to what the user actually has
          const methodTypes = await getUserMfaMethodTypes(userId);
          const allowedMethods = challenge.allowedMethods.filter(m => {
            if (m === 'email') return !!(userRow && userRow.email);
            return methodTypes.includes(m);
          });

          return res.status(403).json({
            requireMFA: true,
            challengeId: challenge.id,
            allowedMethods,
            maskedEmail
          });
        }
      }
    }

    const policy = { enabled: !!enabled, level, scope, reuse };
    await upsertSetting('mfa_policy_' + scenario, JSON.stringify(policy));

    res.status(204).end();
  } catch (err) {
    console.error('PUT /admin/mfa/settings/policy error:', err);
    res.status(500).json({ error: 'Failed to save policy' });
  }
});

module.exports = router;
