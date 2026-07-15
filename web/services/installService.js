const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { assertDbBaseline } = require('../lib/dbBaseline');

async function testDatabaseConnection(host, port, user, password) {
    const conn = await mysql.createConnection({ host, port: parseInt(port), user, password });
    await conn.end();
    return true;
}

async function setupDatabase(host, port, user, password, dbName) {
    // schema.sql and seed.sql's applied-migration list are a matched pair (see
    // lib/dbBaseline.js). If this build's copies disagree, the install produces a
    // subtly wrong schema — a replayed migration dies on a duplicate column, or, far
    // worse, a migration marked applied that schema.sql never had is skipped and its
    // column is silently absent. Fail here, with the reason, rather than downstream.
    assertDbBaseline();

    // Connect without database selected
    const conn = await mysql.createConnection({ host, port: parseInt(port), user, password, multipleStatements: true });

    // Create database if not exists
    await conn.execute(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await conn.changeUser({ database: dbName });

    // Read and execute schema
    const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    await conn.query(schema);

    // Read and execute seed
    const seedPath = path.join(__dirname, '..', 'db', 'seed.sql');
    const seed = fs.readFileSync(seedPath, 'utf8');
    await conn.query(seed);

    await conn.end();
}

function generateSessionSecret() {
    return crypto.randomBytes(64).toString('base64');
}

function generateMfaEncryptionKey() {
    return crypto.randomBytes(32).toString('hex');
}

// Seals the mTLS private key and other sensitive site_settings rows. The app
// REFUSES TO START without it and migration 035 throws — yet the old installer
// never wrote it, so every fresh install was dead on its first boot.
function generateSettingsSecretKey() {
    return crypto.randomBytes(32).toString('hex');
}

function envLine(key, value) {
    const v = String(value ?? '');
    // Quote only when needed; dotenv reads JSON-style double-quoted values back.
    return `${key}=${/[\s#"'\\]/.test(v) ? JSON.stringify(v) : v}`;
}

function writeEnvFile(config) {
    const envContent = [
        '# Written by the first-run installer.',
        '',
        '# Database',
        envLine('DB_HOST', config.dbHost),
        envLine('DB_PORT', config.dbPort),
        envLine('DB_USER', config.dbUser),
        envLine('DB_PASSWORD', config.dbPassword),
        envLine('DB_NAME', config.dbName),
        '',
        '# Redis (required — sessions, permission cache, progress coalescing, rate limits).',
        '# Configure server with maxmemory-policy volatile-lru and appendonly yes.',
        envLine('REDIS_HOST', config.redisHost),
        envLine('REDIS_PORT', config.redisPort),
        envLine('REDIS_PASSWORD', config.redisPassword || ''),
        envLine('REDIS_DB', config.redisDb || '0'),
        '',
        '# Object storage (Cloudflare R2)',
        envLine('R2_ENDPOINT', config.r2Endpoint),
        envLine('R2_BUCKET_NAME', config.r2BucketName),
        envLine('R2_ACCESS_KEY_ID', config.r2AccessKeyId),
        envLine('R2_SECRET_ACCESS_KEY', config.r2SecretAccessKey),
        envLine('R2_PUBLIC_DOMAIN', config.r2PublicDomain),
        '',
        '# Secrets — generated here. Back them up: the settings key seals the mTLS',
        '# private key and other sealed settings rows, and is unrecoverable.',
        envLine('SESSION_SECRET', config.sessionSecret),
        envLine('MFA_ENCRYPTION_KEY', config.mfaEncryptionKey),
        envLine('SETTINGS_SECRET_ENCRYPTION_KEY', config.settingsSecretKey),
        '',
        '# DreamSSO. The issuer + client id are also admin-editable (Settings -> SSO);',
        '# the callback / back-channel / JWKS URLs are DERIVED from the site hostname.',
        envLine('SSO_ISSUER', config.ssoIssuer || ''),
        envLine('OIDC_CLIENT_ID', config.ssoClientId || 'videosite'),
        envLine('OIDC_CLIENT_KEY_FILE', config.clientKeyFile),
        '',
        '# App',
        'NODE_ENV=production',
        envLine('PORT', config.port || 3000),
        '',
    ].join('\n');

    const envPath = process.env.INSTALL_ENV_FILE || path.join(__dirname, '..', '.env');
    fs.writeFileSync(envPath, envContent, { mode: 0o600 });
}

async function markInstalled(host, port, user, password, dbName) {
    const conn = await mysql.createConnection({ host, port: parseInt(port), user, password, database: dbName });
    await conn.execute(
        "INSERT INTO site_settings (setting_key, setting_value) VALUES ('installed', 'true') ON DUPLICATE KEY UPDATE setting_value = 'true'"
    );
    await conn.end();
}

module.exports = {
    testDatabaseConnection,
    setupDatabase,
    generateSessionSecret,
    generateMfaEncryptionKey,
    generateSettingsSecretKey,
    writeEnvFile,
    markInstalled,
};
