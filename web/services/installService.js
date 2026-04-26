const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { createUser } = require('./userService');

async function testDatabaseConnection(host, port, user, password) {
    const conn = await mysql.createConnection({ host, port: parseInt(port), user, password });
    await conn.end();
    return true;
}

async function setupDatabase(host, port, user, password, dbName) {
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

function writeEnvFile(config) {
    const envContent = `# Database
DB_HOST=${config.dbHost}
DB_PORT=${config.dbPort}
DB_USER=${config.dbUser}
DB_PASSWORD=${config.dbPassword}
DB_NAME=${config.dbName}

# Redis (required — sessions, permission cache, progress coalescing, rate limits).
# Configure server with maxmemory-policy volatile-lru and appendonly yes.
REDIS_HOST=${config.redisHost}
REDIS_PORT=${config.redisPort}
REDIS_PASSWORD=${config.redisPassword || ''}
REDIS_DB=${config.redisDb || '0'}

# R2
R2_ENDPOINT=${config.r2Endpoint}
R2_BUCKET_NAME=${config.r2BucketName}
R2_ACCESS_KEY_ID=${config.r2AccessKeyId}
R2_SECRET_ACCESS_KEY=${config.r2SecretAccessKey}
R2_PUBLIC_DOMAIN=${config.r2PublicDomain}

# Session
SESSION_SECRET=${config.sessionSecret}

# App
NODE_ENV=production
PORT=${config.port || 3000}

# MFA
MFA_ENCRYPTION_KEY=${config.mfaEncryptionKey}

# Email (SMTP)
SMTP_HOST=${config.smtpHost || ''}
SMTP_PORT=${config.smtpPort || '465'}
SMTP_USER=${config.smtpUser || ''}
SMTP_PASS=${config.smtpPass || ''}
SMTP_SECURE=${config.smtpSecure || 'true'}
SMTP_FROM_NAME="${config.smtpFromName || ''}"
SMTP_FROM_ADDRESS=${config.smtpFromAddress || ''}
SMTP_REPLY_TO=${config.smtpReplyTo || ''}

# Cloudflare Turnstile
TURNSTILE_SITE_KEY=${config.turnstileSiteKey || ''}
TURNSTILE_SECRET_KEY=${config.turnstileSecretKey || ''}
`;

    const envPath = path.join(__dirname, '..', '.env');
    fs.writeFileSync(envPath, envContent);
}

async function markInstalled(host, port, user, password, dbName) {
    const conn = await mysql.createConnection({ host, port: parseInt(port), user, password, database: dbName });

    // Insert R2 settings into site_settings
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
    writeEnvFile,
    markInstalled
};
