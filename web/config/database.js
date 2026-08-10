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
            //
            // TWO conditions, and both are load-bearing:
            //
            //  field.length === 16 — the COLUMN's max width in BYTES. That is not the
            //    same as 16 characters: under utf8mb4 a 4-char column is also 16, which
            //    is how videos.video_type enum('ts','cmaf') ended up in here. mysql2
            //    reports BINARY and ENUM alike as type 'STRING' and exposes no charset
            //    or flags on the typeCast field, so type+length cannot tell them apart.
            //    'cmaf' was served as "636d6166" and the player, unable to match it,
            //    silently fell back to HLS on browsers that should get DASH.
            //
            //  buf.length === 16 — the VALUE's actual size. Every binary(16) UUID is
            //    exactly 16 bytes; 'cmaf' is 4 and 'ts' is 2, so the enum drops out.
            //    This check alone would be wrong — a 16-character title in a wide
            //    varchar would hex-encode — which is why the column check stays.
            //
            // buffer() may be called only ONCE per field (it advances the packet
            // reader), so it is read here and reused for both the test and the decode.
            typeCast(field, next) {
                if (field.type === 'STRING' && field.length === 16) {
                    const buf = field.buffer();
                    if (buf === null) return null;
                    return buf.length === 16 ? buf.toString('hex') : buf.toString('utf8');
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
