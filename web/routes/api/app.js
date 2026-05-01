const express = require('express');
const router = express.Router();
const { getPool } = require('../../config/database');
const { resolvePermissions } = require('../../services/permissionService');

// GET /api/me — current session user + permissions
//
// Permissions are sent as an array of granted keys, not the 27-key boolean
// map the server uses internally — typical user has 3-5 grants, so the array
// drops ~90% of the payload (~600 → ~50 bytes). Client (AuthContext.refresh)
// rehydrates back to `{ key: true, ... }` so the existing
// `user.permissions.X` truthy checks at all call sites work unchanged.
//
// Server-internal `res.locals.user.permissions` keeps the full keyed shape —
// only the wire format changes here. Admin role/user permission-edit
// endpoints still send the full map (they need explicit-false vs inherit).
router.get('/me', async (req, res) => {
    const user = res.locals.user;
    if (!user) {
        return res.json({ user: null });
    }

    const granted = Object.keys(user.permissions).filter(k => user.permissions[k]);

    res.json({
        user: {
            user_id: user.user_id,
            username: user.username,
            display_name: user.display_name,
            role_id: user.role_id,
            permissions: granted,
            permission_level: user.permission_level,
        }
    });
});

// GET /api/settings/public — public site settings (no auth required)
router.get('/settings/public', async (req, res) => {
    try {
        const pool = getPool();
        const [rows] = await pool.execute(
            `SELECT setting_key, setting_value FROM site_settings
             WHERE setting_key IN ('site_name', 'enable_registration', 'require_invitation_code')`
        );

        const settings = {};
        for (const row of rows) {
            settings[row.setting_key] = row.setting_value;
        }

        // Turnstile site key from env (not secret key)
        const turnstileSiteKey = process.env.TURNSTILE_SITE_KEY || '';

        res.json({
            siteName: settings.site_name || 'VideoSite',
            turnstileSiteKey,
            registrationEnabled: settings.enable_registration === 'true',
            invitationRequired: settings.require_invitation_code !== 'false',
        });
    } catch (err) {
        console.error('Failed to load public settings:', err);
        res.json({
            siteName: 'VideoSite',
            turnstileSiteKey: '',
            registrationEnabled: false,
            invitationRequired: true,
        });
    }
});

module.exports = router;
