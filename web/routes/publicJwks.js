'use strict';
const express = require('express');

/** Public registration endpoint; errors and unsupported methods are never cached. */
function publicJwksRouter(readKeys = () => require('../lib/oidc').publicJwks()) {
    const router = express.Router();
    router.all('/.well-known/jwks.json', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (req.method !== 'GET') {
            res.set('Allow', 'GET');
            return res.status(405).json({ error: 'method_not_allowed' });
        }
        try {
            const keys = await readKeys();
            res.set('Cache-Control', 'public, max-age=120, must-revalidate');
            return res.json(keys);
        } catch {
            res.set('Cache-Control', 'no-store');
            return res.status(500).json({ error: 'keys_unavailable' });
        }
    });
    return router;
}

module.exports = { publicJwksRouter };
