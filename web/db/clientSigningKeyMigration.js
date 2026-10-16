'use strict';
async function migrateClientSigningKeys(pool) {
    await pool.execute(`CREATE TABLE IF NOT EXISTS oidc_client_signing_state (
        singleton TINYINT UNSIGNED PRIMARY KEY,
        version BIGINT UNSIGNED NOT NULL DEFAULT 0,
        encrypted_state LONGTEXT NULL,
        modified_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
        CONSTRAINT oidc_client_signing_singleton CHECK(singleton=1)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await pool.execute('INSERT IGNORE INTO oidc_client_signing_state(singleton) VALUES(1)');
}
module.exports = { migrateClientSigningKeys };
