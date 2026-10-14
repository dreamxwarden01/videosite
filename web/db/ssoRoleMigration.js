'use strict';
// Additive migration; the baseline schema/seed pair remains frozen.
async function migrateSsoRoles(pool) {
    const statements = [
        `CREATE TABLE IF NOT EXISTS sso_catalog_state (
            singleton TINYINT NOT NULL PRIMARY KEY,
            catalog_epoch CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            catalog_revision BIGINT NOT NULL DEFAULT 0,
            catalog_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
            event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
            snapshot LONGTEXT NULL,
            lease_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
            lease_event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
            lease_until DATETIME(6) NULL,
            next_attempt_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS sso_pending_events (
            sequence BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
            kind VARCHAR(64) NOT NULL, payload LONGTEXT NOT NULL,
            payload_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            status VARCHAR(16) NOT NULL DEFAULT 'pending', attempts INT NOT NULL DEFAULT 0,
            next_attempt_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
            last_error_code VARCHAR(64) NULL,
            created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
            delivered_at DATETIME(6) NULL,
            INDEX sso_pending_order (status, sequence)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS sso_role_authority (
            subject_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
            authority_epoch CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
            authority_revision BIGINT NULL, role_id INT NULL,
            generation BIGINT NOT NULL DEFAULT 0,
            session_generation BIGINT NOT NULL DEFAULT 0,
            blocked TINYINT(1) NOT NULL DEFAULT 0,
            effects_pending TINYINT(1) NOT NULL DEFAULT 0,
            refresh_pending TINYINT(1) NOT NULL DEFAULT 0,
            refresh_after DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
            updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
            INDEX sso_role_refresh (refresh_pending, refresh_after)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS sso_role_inbox (
            event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
            subject_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            payload_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            received_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ];
    for (const sql of statements) await pool.execute(sql);
    // Column guards also finish an interrupted additive migration safely.
    const additions = {
        sso_catalog_state: { event_id: 'CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL', lease_event_id: 'CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL' },
        sso_pending_events: { next_attempt_at: 'DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)', last_error_code: 'VARCHAR(64) NULL' },
    };
    for (const [table, fields] of Object.entries(additions)) {
        const [existing] = await pool.execute('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [table]);
        const names = new Set(existing.map(row => row.COLUMN_NAME));
        for (const [name, definition] of Object.entries(fields)) if (!names.has(name)) await pool.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
    const [columns] = await pool.execute(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sessions' AND COLUMN_NAME='sso_role_generation'`);
    if (!columns.length) await pool.execute('ALTER TABLE sessions ADD COLUMN sso_role_generation BIGINT NOT NULL DEFAULT 0');
}
module.exports = { migrateSsoRoles };
