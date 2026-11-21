'use strict';
const express = require('express');
const path = require('node:path');

// These files have content-versioned directory names. Keep this namespace out
// of installation/auth and SPA handling, including failures and non-read verbs.
function fontsRouter(directory = path.join(__dirname, '..', 'client', 'dist', 'fonts')) {
    const router = express.Router();
    router.use((req, res, next) => {
        if (req.method === 'GET' || req.method === 'HEAD') return next();
        res.set({ Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
        return res.status(405).end();
    });
    router.use(express.static(directory, {
        maxAge: '1y', immutable: true, index: false, redirect: false, dotfiles: 'ignore',
    }));
    router.use((_req, res) => res.set('Cache-Control', 'no-store').status(404).type('text/plain').send('Not found'));
    return router;
}

module.exports = { fontsRouter };
