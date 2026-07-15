const express = require('express');
const router = express.Router();
const { getPool } = require('../../config/database');
const { resolvePermissions } = require('../../services/permissionService');
const { requireAuth } = require('../../middleware/auth');

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
            avatar: user.sso_avatar || null,
            email: user.email || null,
            role_id: user.role_id,
            permissions: granted,
            permission_level: user.permission_level,
            org_name: await require('../../services/cache/settingsCache').getSetting('sso_org_name', ''),
            account_portal: await require('../../services/cache/settingsCache').getSetting('sso_account_portal_url', ''),
        }
    });
});

// GET /api/settings/public — public site settings (no auth required)
router.get('/settings/public', async (req, res) => {
    try {
        const pool = getPool();
        const [rows] = await pool.execute(
            `SELECT setting_value FROM site_settings WHERE setting_key = 'site_name'`
        );
        res.json({
            siteName: rows[0]?.setting_value || 'VideoSite',
        });
    } catch (err) {
        console.error('Failed to load public settings:', err);
        res.json({ siteName: 'VideoSite' });
    }
});

// GET /api/avatar/:file — the caller's own profile picture, mirrored from the
// SSO (disk cache, S2S fetch on miss). Name changes with content, so a year of
// private+immutable is exactly right.
router.get('/avatar/:file', requireAuth, async (req, res) => {
    const user = res.locals.user;
    const file = String(req.params.file);
    if (!user.sso_avatar || file !== user.sso_avatar) {
        return res.status(404).json({ error: 'Not found' });
    }
    const { readOrFetch } = require('../../services/avatarService');
    const buf = await readOrFetch(file);
    if (!buf) return res.status(404).json({ error: 'Not found' });
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.set('Content-Type', 'image/webp');
    res.send(buf);
});

module.exports = router;
