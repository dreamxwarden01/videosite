'use strict';
// Persistent terminal SSO logout state; ordinary local replacement keeps the SID
// active. These rows intentionally have no expiry/reset path in this migration.
async function migrateSsoSessions(pool) {
    await pool.execute(`CREATE TABLE IF NOT EXISTS sso_session_state (
        sso_sid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
        subject_id BINARY(16) NOT NULL,
        revoked TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}
module.exports = { migrateSsoSessions };
