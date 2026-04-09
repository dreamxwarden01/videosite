const {
    getScenarioPolicy,
    getAllowedMethodsForLevel,
    validateChallenge,
    consumeChallenge,
    findValidLongStatus,
    createChallenge,
    maskEmail,
    isUserMfaEnabled,
    getUserMfaMethodTypes,
    ensureBmfa,
    rotateBmfaIfNeeded
} = require('../services/mfaService');
const { getPool } = require('../config/database');

/**
 * Factory that returns Express middleware enforcing MFA for a given scenario.
 *
 * @param {string} scenario  - scenario key (maps to mfa_policy_<scenario> setting)
 * @param {object} [options]
 * @param {boolean} [options.forceOneTime] - skip persistent reuse even when policy allows it
 * @param {boolean} [options.mandatory]   - always require challenge even if scenario is disabled (level 0, no reuse)
 */
function requireMfaForScenario(scenario, options) {
    const opts = options || {};

    return async (req, res, next) => {
        try {
            const user = res.locals.user;

            // 1. Read policy
            const policy = await getScenarioPolicy(scenario);
            if (!policy.enabled && !opts.mandatory) {
                return next();
            }
            // If mandatory but policy disabled, use safe defaults
            if (!policy.enabled && opts.mandatory) {
                policy.enabled = true;
                policy.level = 0;
                policy.scope = 'RW';
                policy.reuse = 'one-time';
            }

            // 2. Scope check — write-only policies let GETs through
            if (policy.scope === 'W' && req.method === 'GET') {
                return next();
            }

            // 3. Ensure bmfa token exists
            const bmfaToken = await ensureBmfa(req, res);

            // 4. Check X-MFA-Challenge header
            const challengeId = req.headers['x-mfa-challenge'];
            if (challengeId) {
                const result = await validateChallenge(challengeId, user.user_id, bmfaToken, policy.level, req.originalUrl);
                if (result.valid) {
                    await consumeChallenge(challengeId);
                    await rotateBmfaIfNeeded(req, res, bmfaToken);
                    return next();
                }
                return res.status(403).json({
                    error: 'Invalid or expired verification',
                    requireMFA: true
                });
            }

            // 5. Persistent reuse (unless forceOneTime)
            if (policy.reuse === 'persistent' && !opts.forceOneTime) {
                const existing = await findValidLongStatus(user.user_id, bmfaToken, policy.level);
                if (existing) {
                    await rotateBmfaIfNeeded(req, res, bmfaToken);
                    return next();
                }
            }

            // 6. Verify user has MFA enabled and suitable methods
            const mfaEnabled = await isUserMfaEnabled(user.user_id);
            if (!mfaEnabled) {
                return res.status(403).json({
                    requireMFA: true,
                    mfaSetupRequired: true,
                    mfaEnabled: false,
                    requiredMethods: getAllowedMethodsForLevel(policy.level)
                });
            }

            const userMethods = await getUserMfaMethodTypes(user.user_id);
            const allowedMethods = getAllowedMethodsForLevel(policy.level);
            const overlap = userMethods.filter(m => allowedMethods.includes(m));
            if (overlap.length === 0) {
                return res.status(403).json({
                    requireMFA: true,
                    mfaSetupRequired: true,
                    mfaEnabled: true,
                    requiredMethods: allowedMethods
                });
            }

            // 7. Create new challenge
            const humanName = scenario.replace(/_/g, ' ');
            const challenge = await createChallenge({
                userId: user.user_id,
                contextType: 'bmfa',
                contextId: bmfaToken,
                approvedEndpoint: req.originalUrl,
                mfaLevel: policy.level,
                messageType: 'admin_operation',
                messageOperation: humanName,
                canReuse: policy.reuse === 'persistent' && !opts.forceOneTime
            });

            // Fetch user email for masking
            const pool = getPool();
            const [[userRow]] = await pool.execute(
                'SELECT email FROM users WHERE user_id = ?',
                [user.user_id]
            );
            const maskedEmail = userRow && userRow.email ? maskEmail(userRow.email) : null;

            // Filter allowed methods to what the user actually has
            const filteredMethods = challenge.allowedMethods.filter(m => {
                if (m === 'email') return !!(userRow && userRow.email);
                return userMethods.includes(m);
            });

            return res.status(403).json({
                requireMFA: true,
                challengeId: challenge.id,
                allowedMethods: filteredMethods,
                maskedEmail,
                pendingTtlSeconds: challenge.pendingTtlSeconds
            });
        } catch (err) {
            console.error('MFA middleware error:', err);
            return res.status(500).json({ error: 'MFA verification failed' });
        }
    };
}

module.exports = { requireMfaForScenario };
