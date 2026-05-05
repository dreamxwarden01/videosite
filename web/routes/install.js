const express = require('express');
const router = express.Router();
const { S3Client, HeadBucketCommand } = require('@aws-sdk/client-s3');
const {
    testDatabaseConnection,
    setupDatabase,
    generateSessionSecret,
    generateMfaEncryptionKey,
    writeEnvFile,
    markInstalled
} = require('../services/installService');
const { createUser } = require('../services/userService');
const { markInstalled: markInstalledCache } = require('../middleware/installer');
const { resetPool } = require('../config/database');
const redisService = require('../services/redis');

// GET /install — serve standalone install page
//
// no-store: response depends on installer state (pre-install only — the
// checkInstalled middleware returns 404 once installed) so caching it at
// the edge would let users see the install page after the site is live.
router.get('/install', (req, res) => {
    const path = require('path');
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, '..', 'client', 'dist', 'install.html'));
});

// POST /api/install — JSON API for SPA install page
router.post('/api/install', async (req, res) => {
    try {
        const {
            dbHost, dbPort, dbUser, dbPassword, dbName,
            redisHost, redisPort, redisPassword, redisDb,
            r2Endpoint, r2BucketName, r2AccessKeyId, r2SecretAccessKey, r2PublicDomain,
            siteName, siteHostname, siteProtocol,
            adminUsername, adminDisplayName, adminPassword, adminPasswordConfirm,
            smtpHost, smtpPort, smtpUser, smtpPass, smtpSecure, smtpFromName, smtpFromAddress, smtpReplyTo,
            turnstileSiteKey, turnstileSecretKey
        } = req.body;

        // Validation
        const errors = [];
        if (!dbHost || !dbPort || !dbUser || !dbPassword || !dbName) errors.push('All database fields are required');
        if (!redisHost || !redisPort) errors.push('Redis host and port are required');
        if (!r2Endpoint || !r2BucketName || !r2AccessKeyId || !r2SecretAccessKey || !r2PublicDomain) errors.push('All R2 fields are required');
        if (!siteName || !siteHostname) errors.push('Site name and hostname are required');
        // Admin username validation
        if (!adminUsername) {
            errors.push('Admin username is required');
        } else {
            const u = adminUsername.trim();
            if (u.length < 3 || u.length > 20) errors.push('Username must be between 3 and 20 characters');
            else if (!/^[A-Za-z0-9_-]+$/.test(u)) errors.push('Username can only contain letters, digits, dashes, and underscores');
            if (['root', 'admin', 'superadmin'].includes(u.toLowerCase())) errors.push('Username cannot be "root", "admin", or "superadmin"');
        }

        // Admin display name validation
        if (!adminDisplayName || !adminDisplayName.trim()) {
            errors.push('Display name is required');
        } else {
            const d = adminDisplayName.trim();
            if (d.length > 30) errors.push('Display name must be 30 characters or fewer');
            else if (!/^[A-Za-z0-9 ]+$/.test(d)) errors.push('Display name can only contain letters, digits, and spaces');
        }

        // Admin password validation
        if (!adminPassword) {
            errors.push('Admin password is required');
        } else {
            if (adminPassword.length < 8) errors.push('Password must be at least 8 characters');
            if (adminPassword.includes(' ')) errors.push('Password cannot contain spaces');
            let categories = 0;
            if (/[A-Z]/.test(adminPassword)) categories++;
            if (/[a-z]/.test(adminPassword)) categories++;
            if (/[0-9]/.test(adminPassword)) categories++;
            if (/[^A-Za-z0-9]/.test(adminPassword)) categories++;
            if (categories < 3) errors.push('Password must include at least 3 of: uppercase, lowercase, digits, special characters');
        }
        if (adminPassword !== adminPasswordConfirm) errors.push('Passwords do not match');

        if (errors.length > 0) {
            return res.status(422).json({ success: false, error: errors.join('. ') });
        }

        // Test database connection
        try {
            await testDatabaseConnection(dbHost, dbPort || '3306', dbUser, dbPassword);
        } catch (err) {
            return res.status(422).json({ success: false, error: 'Database connection failed: ' + err.message });
        }

        // Test Redis connection
        try {
            await redisService.testConnection({
                host: redisHost,
                port: redisPort || '6379',
                password: redisPassword,
                db: redisDb || '0',
            });
        } catch (err) {
            return res.status(422).json({ success: false, error: 'Redis connection failed: ' + err.message });
        }

        // Test R2 connection
        try {
            const testClient = new S3Client({
                region: 'auto',
                endpoint: r2Endpoint,
                credentials: { accessKeyId: r2AccessKeyId, secretAccessKey: r2SecretAccessKey },
            });
            await testClient.send(new HeadBucketCommand({ Bucket: r2BucketName }));
        } catch (err) {
            return res.status(422).json({ success: false, error: 'R2 connection failed: ' + err.message });
        }

        // Setup database
        await setupDatabase(dbHost, dbPort || '3306', dbUser, dbPassword, dbName);

        // Write .env file
        const sessionSecret = generateSessionSecret();
        const mfaEncryptionKey = generateMfaEncryptionKey();
        writeEnvFile({
            dbHost, dbPort: dbPort || '3306', dbUser, dbPassword, dbName,
            redisHost, redisPort: redisPort || '6379', redisPassword: redisPassword || '', redisDb: redisDb || '0',
            r2Endpoint, r2BucketName, r2AccessKeyId, r2SecretAccessKey,
            r2PublicDomain: (r2PublicDomain || '').trim().replace(/^https?:\/\//, '').split('/')[0],
            sessionSecret,
            mfaEncryptionKey,
            smtpHost, smtpPort, smtpUser, smtpPass, smtpSecure, smtpFromName, smtpFromAddress, smtpReplyTo,
            turnstileSiteKey, turnstileSecretKey,
            port: 3000
        });

        // Reload env vars
        require('dotenv').config({ override: true });
        resetPool();

        // Connect Redis on the running process so endpoints work without restart
        try {
            await redisService.connect();
        } catch (err) {
            console.error('Post-install Redis connect failed:', err.message);
            return res.status(500).json({ success: false, error: 'Installation completed but Redis connection failed. Restart the server and check REDIS_* env vars.' });
        }

        // Create superadmin user
        const mysql = require('mysql2/promise');
        const conn = await mysql.createConnection({
            host: dbHost, port: parseInt(dbPort || '3306'), user: dbUser, password: dbPassword, database: dbName
        });

        const argon2 = require('argon2');
        const passwordHash = await argon2.hash(adminPassword, { type: argon2.argon2id });

        await conn.execute(
            `INSERT INTO users (username, display_name, password_hash, role_id, is_active)
             VALUES (?, ?, ?, 0, 1)`,
            [adminUsername, adminDisplayName || adminUsername, passwordHash]
        );

        // Save site settings to DB
        const cleanHostname = (siteHostname || '').trim().replace(/^https?:\/\//, '').split('/')[0];
        const siteSettings = [
            ['site_name', siteName],
            ['site_protocol', siteProtocol || 'https'],
            ['site_hostname', cleanHostname],
        ];
        for (const [key, value] of siteSettings) {
            await conn.execute(
                'INSERT INTO site_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
                [key, value]
            );
        }

        await markInstalled(dbHost, dbPort || '3306', dbUser, dbPassword, dbName);
        await conn.end();
        markInstalledCache();

        res.json({ success: true });
    } catch (err) {
        console.error('Installation error:', err);
        res.status(500).json({ success: false, error: 'Installation failed: ' + err.message });
    }
});

module.exports = router;
