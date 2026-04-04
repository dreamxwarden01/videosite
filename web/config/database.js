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
            queueLimit: 0
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

module.exports = { getPool, createInstallPool, resetPool };
