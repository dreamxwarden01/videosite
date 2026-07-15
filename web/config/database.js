const mysql = require('mysql2/promise');

let pool = null;

function getPool() {
    if (!pool) {
        pool = mysql.createPool({
            host: process.env.DB_HOST || 'localhost',
            port: parseInt(process.env.DB_PORT || '3306'),
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
            // After the user_id INT -> BINARY(16) (UUIDv7 = OIDC `sub`) rewrite, hand
            // every UUID column back as a 32-char hex string instead of a raw Buffer,
            // so the app keeps treating ids as strings (Redis keys, JSON, equality).
            // mysql2 reports CHAR/BINARY as type 'STRING'; the only fixed-16 columns
            // are the binary(16) UUIDs (verified — no char(16) text columns exist),
            // and this applies to both query() and execute() in mysql2 >= 3.22.
            typeCast(field, next) {
                if (field.type === 'STRING' && field.length === 16) {
                    const buf = field.buffer();
                    return buf === null ? null : buf.toString('hex');
                }
                return next();
            }
        });
    }
    return pool;
}

// Create a pool for the installation step (no database selected)
function createInstallPool(host, port, user, password) {
    return mysql.createPool({
        host,
        port: parseInt(port),
        user,
        password,
        waitForConnections: true,
        connectionLimit: 2,
        queueLimit: 0
    });
}

// Reset pool (used after installation writes .env)
function resetPool() {
    if (pool) {
        pool.end();
        pool = null;
    }
}

// Convert the canonical 32-char hex user id back to BINARY(16) for query params
// (WHERE / INSERT). Pass-through for null/undefined and already-Buffer values so
// callers can wrap defensively without double-converting.
function idBuf(hexId) {
    if (hexId == null || Buffer.isBuffer(hexId)) return hexId;
    return Buffer.from(String(hexId), 'hex');
}

module.exports = { getPool, createInstallPool, resetPool, idBuf };
