const { getPool } = require('../config/database');

/**
 * Run all pending migrations.
 *
 * At BOOT this is deliberately lenient: a migration failure is logged and the
 * running site carries on rather than crashing.
 *
 * The INSTALLER passes { strict: true } and needs the opposite: swallowing a failure
 * would hand the operator a "success" page on top of a broken schema.
 *
 * TO ADD A MIGRATION: append it to the array below and touch NOTHING else. Do not
 * add it to db/seed.sql and do not regenerate db/schema.sql — those two are a frozen
 * baseline pair, and a fresh install runs everything after it exactly as an existing
 * install does. `npm run check:db` enforces that. See lib/dbBaseline.js for why.
 */
async function runMigrations({ strict = false } = {}) {
    const pool = getPool();

    try {
        // Ensure migrations tracking table exists
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                migration_id   VARCHAR(100) PRIMARY KEY,
                applied_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);

        const migrations = [
            {
                id: '001_fix_worker_key_column_sizes',
                up: async () => {
                    // worker_access_keys.key_id: VARCHAR(32) -> VARCHAR(64)
                    await pool.execute(`ALTER TABLE worker_access_keys MODIFY key_id VARCHAR(64) NOT NULL`);
                    // processing_queue.worker_key_id: VARCHAR(32) -> VARCHAR(64)
                    await pool.execute(`ALTER TABLE processing_queue MODIFY worker_key_id VARCHAR(64) DEFAULT NULL`);
                }
            },
            {
                id: '002_worker_pending_abort_transcoding',
                up: async () => {
                    // Add 'pending' and 'aborted' to processing_queue status enum
                    await pool.execute(`
                        ALTER TABLE processing_queue
                        MODIFY COLUMN status ENUM('queued','pending','leased','processing','completed','error','aborted')
                        NOT NULL DEFAULT 'queued'
                    `);
                    // Add pending_until for check-then-lease protocol
                    await pool.execute(`
                        ALTER TABLE processing_queue
                        ADD COLUMN pending_until DATETIME DEFAULT NULL AFTER last_heartbeat
                    `);
                    // Add abort_requested flag for deletion-triggered abort
                    await pool.execute(`
                        ALTER TABLE processing_queue
                        ADD COLUMN abort_requested TINYINT(1) NOT NULL DEFAULT 0 AFTER pending_until
                    `);
                    // Add cleared flag for transcoding status page soft-clear
                    await pool.execute(`
                        ALTER TABLE processing_queue
                        ADD COLUMN cleared TINYINT(1) NOT NULL DEFAULT 0 AFTER abort_requested
                    `);
                    // Add error_at timestamp for transcoding status page sorting
                    await pool.execute(`
                        ALTER TABLE processing_queue
                        ADD COLUMN error_at DATETIME DEFAULT NULL AFTER cleared
                    `);
                }
            },
            {
                id: '003_add_encryption_key',
                up: async () => {
                    // Add encryption_key column for HLS AES-128 encryption
                    await pool.execute(`
                        ALTER TABLE videos
                        ADD COLUMN encryption_key VARBINARY(16) DEFAULT NULL AFTER r2_source_key
                    `);
                }
            },
            {
                id: '004_drop_abort_requested',
                up: async () => {
                    // abort_requested is replaced by 404-based abort detection:
                    // when a job is deleted, worker API calls return 404
                    await pool.execute(`
                        ALTER TABLE processing_queue
                        DROP COLUMN abort_requested
                    `);
                }
            },
            {
                id: '005_registration_tables',
                up: async () => {
                    // Pending registrations — one active registration per email
                    await pool.execute(`
                        CREATE TABLE IF NOT EXISTS pending_registrations (
                            email           VARCHAR(255) NOT NULL PRIMARY KEY,
                            token           VARCHAR(128) NOT NULL,
                            invitation_code VARCHAR(12)  DEFAULT NULL,
                            created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                            last_sent_at    DATETIME     NOT NULL,
                            INDEX idx_token (token),
                            INDEX idx_expires (created_at)
                        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                    `);

                    // Email rate limiting for registration
                    await pool.execute(`
                        CREATE TABLE IF NOT EXISTS registration_email_limits (
                            email      VARCHAR(255) PRIMARY KEY,
                            first_sent DATETIME     NOT NULL,
                            last_sent  DATETIME     NOT NULL,
                            total_sent INT UNSIGNED NOT NULL DEFAULT 0
                        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                    `);

                    // Invitation codes
                    await pool.execute(`
                        CREATE TABLE IF NOT EXISTS invitation_codes (
                            code       VARCHAR(12)  PRIMARY KEY,
                            created_by INT UNSIGNED DEFAULT NULL,
                            created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                            expires_at DATETIME     NOT NULL,
                            FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL
                        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                    `);

                    // Add inviteUser permission to superadmin and admin
                    await pool.execute(`
                        INSERT IGNORE INTO role_permissions (role_id, permission_key, granted)
                        VALUES (0, 'inviteUser', 1), (1, 'inviteUser', 1)
                    `);

                    // Add registration site settings defaults
                    await pool.execute(`
                        INSERT IGNORE INTO site_settings (setting_key, setting_value)
                        VALUES ('enable_registration', 'false'),
                               ('require_invitation_code', 'true'),
                               ('registration_token_validity_minutes', '30'),
                               ('registration_default_role', '2')
                    `);
                }
            },
            {
                id: '006_mfa_system',
                up: async () => {
                    // Add MFA columns to users table
                    await pool.execute(`
                        ALTER TABLE users
                        ADD COLUMN mfa_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER email
                    `);
                    await pool.execute(`
                        ALTER TABLE users
                        ADD COLUMN password_changed_at DATETIME DEFAULT NULL AFTER password_hash
                    `);

                    // MFA methods (TOTP, passkey, email)
                    await pool.execute(`
                        CREATE TABLE IF NOT EXISTS user_mfa_methods (
                            id                   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                            user_id              INT UNSIGNED NOT NULL,
                            method_type          ENUM('email','authenticator','passkey') NOT NULL,
                            label                VARCHAR(100) DEFAULT NULL,
                            totp_secret_encrypted VARCHAR(512) DEFAULT NULL,
                            credential_id        VARCHAR(512) DEFAULT NULL,
                            public_key           TEXT DEFAULT NULL,
                            sign_count           INT UNSIGNED DEFAULT 0,
                            transports           TEXT DEFAULT NULL,
                            is_active            TINYINT(1) NOT NULL DEFAULT 1,
                            created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                            UNIQUE KEY uq_credential (credential_id),
                            INDEX idx_user_method (user_id, method_type),
                            FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
                        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                    `);

                    // Pre-auth sessions (before MFA is verified at login)
                    await pool.execute(`
                        CREATE TABLE IF NOT EXISTS mfa_preauth_sessions (
                            id           VARCHAR(64) PRIMARY KEY,
                            user_id      INT UNSIGNED NOT NULL,
                            challenge_id VARCHAR(64) DEFAULT NULL,
                            ip_address   VARCHAR(45) DEFAULT NULL,
                            user_agent   TEXT DEFAULT NULL,
                            created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                            expires_at   DATETIME NOT NULL,
                            INDEX idx_user_expires (user_id, expires_at),
                            FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
                        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                    `);

                    // MFA challenges (OTP, passkey, etc.)
                    await pool.execute(`
                        CREATE TABLE IF NOT EXISTS mfa_challenges (
                            id                VARCHAR(64) PRIMARY KEY,
                            user_id           INT UNSIGNED NOT NULL,
                            context_type      ENUM('sid','preauth') NOT NULL,
                            context_id        VARCHAR(128) NOT NULL,
                            approved_endpoint VARCHAR(255) DEFAULT NULL,
                            allowed_methods   VARCHAR(100) NOT NULL DEFAULT 'email,authenticator,passkey',
                            mfa_level         TINYINT UNSIGNED NOT NULL DEFAULT 0,
                            message_type      ENUM('login','password_reset','mfa_change','admin_operation','email_verification') NOT NULL,
                            message_operation VARCHAR(255) DEFAULT NULL,
                            status            ENUM('pending','verified','consumed','expired') NOT NULL DEFAULT 'pending',
                            can_reuse         TINYINT(1) NOT NULL DEFAULT 0,
                            used_count        INT UNSIGNED NOT NULL DEFAULT 0,
                            otp_hash          VARCHAR(255) DEFAULT NULL,
                            otp_attempts      INT UNSIGNED NOT NULL DEFAULT 0,
                            otp_sent_at       DATETIME DEFAULT NULL,
                            webauthn_challenge VARCHAR(255) DEFAULT NULL,
                            verified_method   ENUM('email','authenticator','passkey') DEFAULT NULL,
                            verified_at       DATETIME DEFAULT NULL,
                            created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                            expires_at        DATETIME NOT NULL,
                            INDEX idx_user_context (user_id, context_type, context_id),
                            INDEX idx_status_expires (status, expires_at),
                            FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
                        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                    `);

                    // OTP rate limiting per user
                    await pool.execute(`
                        CREATE TABLE IF NOT EXISTS mfa_otp_rate_limits (
                            user_id    INT UNSIGNED PRIMARY KEY,
                            first_sent DATETIME     NOT NULL,
                            last_sent  DATETIME     NOT NULL,
                            total_sent INT UNSIGNED NOT NULL DEFAULT 0,
                            FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
                        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                    `);

                    // Add MFA permissions to superadmin and admin. (The former
                    // manageSiteMFA row is dropped by a later migration — MFA
                    // settings folded into manageSite.)
                    await pool.execute(`
                        INSERT IGNORE INTO role_permissions (role_id, permission_key, granted)
                        VALUES (0, 'requireMFA', 1), (1, 'requireMFA', 1)
                    `);

                    // Add MFA site settings defaults
                    await pool.execute(`
                        INSERT IGNORE INTO site_settings (setting_key, setting_value)
                        VALUES ('mfa_pending_challenge_timeout_seconds', '900'),
                               ('mfa_otp_timeout_seconds', '300'),
                               ('mfa_level_0_timeout_seconds', '604800'),
                               ('mfa_level_1_timeout_seconds', '3600'),
                               ('mfa_level_2_timeout_seconds', '600'),
                               ('mfa_policy_login', '{"enabled":false,"level":0,"scope":"W","reuse":"persistent"}'),
                               ('mfa_policy_course', '{"enabled":false,"level":0,"scope":"W","reuse":"persistent"}'),
                               ('mfa_policy_enrollment', '{"enabled":false,"level":0,"scope":"W","reuse":"persistent"}'),
                               ('mfa_policy_user', '{"enabled":false,"level":0,"scope":"W","reuse":"persistent"}'),
                               ('mfa_policy_invitation_codes', '{"enabled":false,"level":0,"scope":"W","reuse":"persistent"}'),
                               ('mfa_policy_roles', '{"enabled":false,"level":0,"scope":"W","reuse":"persistent"}'),
                               ('mfa_policy_playback_stats', '{"enabled":false,"level":0,"scope":"W","reuse":"persistent"}'),
                               ('mfa_policy_transcoding', '{"enabled":false,"level":0,"scope":"W","reuse":"persistent"}'),
                               ('mfa_policy_settings', '{"enabled":false,"level":0,"scope":"W","reuse":"persistent"}'),
                               ('mfa_policy_mfa', '{"enabled":false,"level":0,"scope":"W","reuse":"persistent"}')
                    `);
                }
            },
            {
                id: '007_mfa_email_verification_type',
                up: async () => {
                    await pool.execute(`
                        ALTER TABLE mfa_challenges
                        MODIFY COLUMN message_type ENUM('login','password_reset','mfa_change','admin_operation','email_verification') NOT NULL
                    `);
                }
            },
            {
                id: '008_webauthn_challenge_column',
                up: async () => {
                    await pool.execute(`
                        ALTER TABLE mfa_challenges
                        ADD COLUMN webauthn_challenge VARCHAR(255) DEFAULT NULL AFTER otp_sent_at
                    `);
                }
            },
            {
                id: '009_mfa_methods_last_used',
                up: async () => {
                    await pool.execute(`
                        ALTER TABLE user_mfa_methods
                        ADD COLUMN last_used_at DATETIME DEFAULT NULL AFTER created_at
                    `);
                }
            },
            {
                id: '010_mfa_totp_rate_limits',
                up: async () => {
                    await pool.execute(`
                        CREATE TABLE IF NOT EXISTS mfa_totp_rate_limits (
                            user_id          INT UNSIGNED PRIMARY KEY,
                            attempt_count    INT UNSIGNED NOT NULL DEFAULT 0,
                            first_attempt_at DATETIME NOT NULL,
                            FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
                        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                    `);
                }
            },
            {
                id: '011_unique_user_email',
                up: async () => {
                    await pool.execute(`ALTER TABLE users ADD UNIQUE INDEX uq_users_email (email)`);
                }
            },
            {
                id: '012_password_reset',
                up: async () => {
                    await pool.execute(`
                        CREATE TABLE IF NOT EXISTS password_reset_tokens (
                            token      VARCHAR(128) NOT NULL PRIMARY KEY,
                            user_id    INT UNSIGNED NOT NULL,
                            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                            used       TINYINT(1) NOT NULL DEFAULT 0,
                            FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
                            INDEX idx_user_id (user_id),
                            INDEX idx_created_at (created_at)
                        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                    `);
                    await pool.execute(`
                        CREATE TABLE IF NOT EXISTS password_reset_email_limits (
                            email      VARCHAR(255) PRIMARY KEY,
                            first_sent DATETIME NOT NULL,
                            last_sent  DATETIME NOT NULL,
                            total_sent INT UNSIGNED NOT NULL DEFAULT 0
                        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                    `);
                    await pool.execute(`
                        UPDATE site_settings
                        SET setting_key = 'emailed_link_validity_minutes'
                        WHERE setting_key = 'registration_token_validity_minutes'
                    `);
                }
            },
            {
                id: '013_user_role_permission_level_10',
                up: async () => {
                    // Change the default "user" role permission_level from 2 to 10
                    // This targets any server still using the original default level
                    await pool.execute(`
                        UPDATE roles SET permission_level = 10 WHERE permission_level = 2
                    `);
                }
            },
            {
                id: '014_bmfa_tokens',
                up: async () => {
                    // Browser MFA identity tokens — replaces mfa_preauth_sessions
                    await pool.execute(`
                        CREATE TABLE IF NOT EXISTS bmfa_tokens (
                            token       VARCHAR(128) NOT NULL PRIMARY KEY,
                            ip_address  VARCHAR(45)  DEFAULT NULL,
                            user_agent  TEXT         DEFAULT NULL,
                            created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                            expires_at  DATETIME     NOT NULL,
                            INDEX idx_expires (expires_at)
                        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                    `);

                    // Add 'bmfa' to context_type ENUM on mfa_challenges
                    await pool.execute(`
                        ALTER TABLE mfa_challenges
                        MODIFY COLUMN context_type ENUM('sid','preauth','bmfa') NOT NULL
                    `);

                    // Drop preauth sessions table — no longer needed
                    await pool.execute(`DROP TABLE IF EXISTS mfa_preauth_sessions`);
                }
            },
            {
                id: '015_mfa_reuse_session_to_persistent',
                up: async () => {
                    // Rename reuse policy value 'session' → 'persistent' in stored JSON
                    await pool.execute(`
                        UPDATE site_settings
                        SET setting_value = REPLACE(setting_value, '"reuse":"session"', '"reuse":"persistent"')
                        WHERE setting_key LIKE 'mfa_policy_%'
                          AND setting_value LIKE '%"reuse":"session"%'
                    `);
                }
            },
            {
                id: '016_remove_hashed_course_id',
                up: async () => {
                    await pool.execute(`ALTER TABLE courses DROP COLUMN hashed_course_id`);
                }
            },
            {
                id: '017_upload_sessions',
                up: async () => {
                    await pool.execute(`
                        CREATE TABLE IF NOT EXISTS upload_sessions (
                            upload_id         VARCHAR(12)  PRIMARY KEY,
                            video_id          INT UNSIGNED DEFAULT NULL,
                            course_id         CHAR(6)      NOT NULL,
                            title             VARCHAR(255) DEFAULT NULL,
                            week              VARCHAR(20)  DEFAULT NULL,
                            lecture_date      DATE         DEFAULT NULL,
                            description       TEXT         DEFAULT NULL,
                            r2_upload_id      VARCHAR(1024) NOT NULL,
                            object_key        VARCHAR(500) NOT NULL,
                            original_filename VARCHAR(255) NOT NULL,
                            file_size_bytes   BIGINT UNSIGNED NOT NULL,
                            total_parts       INT UNSIGNED NOT NULL,
                            status            ENUM('active','completing','completed','aborted') NOT NULL DEFAULT 'active',
                            last_heartbeat    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                            created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                            completed_at      DATETIME     DEFAULT NULL,
                            created_by        INT UNSIGNED NOT NULL,
                            INDEX idx_video_active (video_id, status),
                            INDEX idx_heartbeat (status, last_heartbeat),
                            FOREIGN KEY (course_id) REFERENCES courses(course_id) ON DELETE CASCADE,
                            FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE CASCADE
                        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                    `);
                }
            },
            {
                id: '018_widen_r2_upload_id',
                up: async () => {
                    await pool.execute(`ALTER TABLE upload_sessions MODIFY r2_upload_id VARCHAR(1024) NOT NULL`);
                }
            },
            {
                id: '020_remove_r2_turnstile_from_settings',
                up: async () => {
                    await pool.execute(`
                        DELETE FROM site_settings WHERE setting_key IN (
                            'r2_endpoint', 'r2_bucket_name', 'r2_access_key_id',
                            'r2_secret_access_key', 'r2_public_domain',
                            'turnstile_site_key', 'turnstile_secret_key'
                        )
                    `);
                }
            },
            {
                id: '021_mfa_onetime_challenge_timeout',
                up: async () => {
                    await pool.execute(`
                        INSERT IGNORE INTO site_settings (setting_key, setting_value)
                        VALUES ('mfa_onetime_challenge_timeout_seconds', '600')
                    `);
                }
            },
            {
                id: '019_course_id_to_int',
                up: async () => {
                    // Find and drop all FK constraints referencing courses.course_id
                    const [fks] = await pool.execute(`
                        SELECT TABLE_NAME, CONSTRAINT_NAME
                        FROM information_schema.KEY_COLUMN_USAGE
                        WHERE REFERENCED_TABLE_SCHEMA = DATABASE()
                          AND REFERENCED_TABLE_NAME = 'courses'
                          AND REFERENCED_COLUMN_NAME = 'course_id'
                    `);
                    for (const fk of fks) {
                        await pool.execute(`ALTER TABLE \`${fk.TABLE_NAME}\` DROP FOREIGN KEY \`${fk.CONSTRAINT_NAME}\``);
                    }

                    // Convert all course_id columns from CHAR(6) to INT UNSIGNED
                    await pool.execute(`ALTER TABLE courses MODIFY course_id INT UNSIGNED NOT NULL AUTO_INCREMENT`);
                    await pool.execute(`ALTER TABLE enrollments MODIFY course_id INT UNSIGNED NOT NULL`);
                    await pool.execute(`ALTER TABLE videos MODIFY course_id INT UNSIGNED NOT NULL`);
                    await pool.execute(`ALTER TABLE upload_sessions MODIFY course_id INT UNSIGNED NOT NULL`);

                    // Re-add FK constraints
                    await pool.execute(`ALTER TABLE enrollments ADD FOREIGN KEY (course_id) REFERENCES courses(course_id) ON DELETE CASCADE`);
                    await pool.execute(`ALTER TABLE videos ADD FOREIGN KEY (course_id) REFERENCES courses(course_id) ON DELETE CASCADE`);
                    await pool.execute(`ALTER TABLE upload_sessions ADD FOREIGN KEY (course_id) REFERENCES courses(course_id) ON DELETE CASCADE`);
                }
            },
            {
                id: '022_transcoding_profiles',
                up: async () => {
                    // Transcoding profiles table (NULL course_id = global default)
                    await pool.execute(`
                        CREATE TABLE IF NOT EXISTS transcoding_profiles (
                            profile_id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                            course_id          INT UNSIGNED DEFAULT NULL,
                            name               VARCHAR(100) NOT NULL,
                            width              INT UNSIGNED NOT NULL,
                            height             INT UNSIGNED NOT NULL,
                            video_bitrate_kbps INT UNSIGNED NOT NULL,
                            audio_bitrate_kbps INT UNSIGNED NOT NULL,
                            codec              VARCHAR(20)  NOT NULL DEFAULT 'h264',
                            profile            VARCHAR(20)  NOT NULL DEFAULT 'high',
                            preset             VARCHAR(20)  NOT NULL DEFAULT 'medium',
                            segment_duration   INT UNSIGNED NOT NULL DEFAULT 6,
                            gop_size           INT UNSIGNED NOT NULL DEFAULT 48,
                            sort_order         TINYINT UNSIGNED NOT NULL DEFAULT 0,
                            created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                            updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                            INDEX idx_course (course_id),
                            FOREIGN KEY (course_id) REFERENCES courses(course_id) ON DELETE CASCADE
                        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                    `);

                    // Per-course transcoding overrides
                    await pool.execute(`ALTER TABLE courses ADD COLUMN use_custom_profiles TINYINT(1) NOT NULL DEFAULT 0 AFTER description`);
                    await pool.execute(`ALTER TABLE courses ADD COLUMN audio_normalization TINYINT(1) NOT NULL DEFAULT 1 AFTER use_custom_profiles`);

                    // Seed default global profiles
                    await pool.execute(`
                        INSERT INTO transcoding_profiles (course_id, name, width, height, video_bitrate_kbps, audio_bitrate_kbps, codec, profile, preset, segment_duration, gop_size, sort_order)
                        VALUES (NULL, '1080p', 1920, 1080, 3500, 192, 'h264', 'high', 'medium', 6, 48, 0),
                               (NULL, '720p',  1280, 720,  2000, 128, 'h264', 'main', 'medium', 6, 48, 1)
                    `);

                    // Audio normalization global defaults
                    await pool.execute(`
                        INSERT IGNORE INTO site_settings (setting_key, setting_value)
                        VALUES ('audio_normalization_target', '-20'),
                               ('audio_normalization_peak', '-2'),
                               ('audio_normalization_max_gain', '20')
                    `);
                }
            },
            {
                id: '023_course_materials',
                up: async () => {
                    await pool.execute(`
                        CREATE TABLE IF NOT EXISTS course_materials (
                            material_id       INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                            course_id         INT UNSIGNED NOT NULL,
                            object_key        VARCHAR(255) NOT NULL,
                            filename          VARCHAR(255) NOT NULL,
                            file_size         BIGINT UNSIGNED NOT NULL DEFAULT 0,
                            content_type      VARCHAR(100) NOT NULL DEFAULT 'application/octet-stream',
                            week              VARCHAR(20) DEFAULT NULL,
                            status            ENUM('uploading','active','aborted') NOT NULL DEFAULT 'uploading',
                            uploaded_by       INT UNSIGNED NOT NULL,
                            created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                            updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                            FOREIGN KEY (course_id) REFERENCES courses(course_id) ON DELETE CASCADE,
                            FOREIGN KEY (uploaded_by) REFERENCES users(user_id) ON DELETE CASCADE,
                            INDEX idx_course_materials_course (course_id),
                            INDEX idx_course_materials_status (status)
                        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                    `);

                    // Grant all 3 to superadmin
                    await pool.execute(`
                        INSERT IGNORE INTO role_permissions (role_id, permission_key, granted) VALUES
                            (0, 'accessAttachments', 1),
                            (0, 'uploadAttachments', 1),
                            (0, 'deleteAttachments', 1)
                    `);

                    // Grant accessAttachments to all other roles
                    await pool.execute(`
                        INSERT IGNORE INTO role_permissions (role_id, permission_key, granted)
                        SELECT role_id, 'accessAttachments', 1 FROM roles WHERE role_id > 0
                    `);

                    // Grant upload + delete to admin-level roles (permission_level <= 1)
                    await pool.execute(`
                        INSERT IGNORE INTO role_permissions (role_id, permission_key, granted)
                        SELECT role_id, 'uploadAttachments', 1 FROM roles WHERE permission_level <= 1 AND role_id > 0
                    `);
                    await pool.execute(`
                        INSERT IGNORE INTO role_permissions (role_id, permission_key, granted)
                        SELECT role_id, 'deleteAttachments', 1 FROM roles WHERE permission_level <= 1 AND role_id > 0
                    `);
                }
            },
            {
                id: '024_drop_material_original_filename',
                up: async () => {
                    const [cols] = await pool.execute(
                        `SELECT 1 FROM information_schema.COLUMNS
                         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'course_materials' AND COLUMN_NAME = 'original_filename'`
                    );
                    if (cols.length > 0) {
                        await pool.execute(`ALTER TABLE course_materials DROP COLUMN original_filename`);
                    }
                }
            },
            {
                id: '025_worker_sessions',
                up: async () => {
                    // Bearer-token sessions for the worker. IP-bound, 1-hour inactivity expiry,
                    // one active session per worker_access_keys row (re-auth revokes prior).
                    await pool.execute(`
                        CREATE TABLE IF NOT EXISTS worker_sessions (
                            session_id     VARCHAR(32)  NOT NULL PRIMARY KEY,
                            worker_key_id  VARCHAR(64)  NOT NULL,
                            bearer_token   VARCHAR(128) NOT NULL UNIQUE,
                            ip_address     VARCHAR(64)  NOT NULL,
                            last_seen      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                            created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                            FOREIGN KEY (worker_key_id) REFERENCES worker_access_keys(key_id) ON DELETE CASCADE,
                            INDEX idx_worker_sessions_key (worker_key_id),
                            INDEX idx_worker_sessions_last_seen (last_seen)
                        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                    `);
                }
            },
            {
                id: '026_watch_seconds_decimal',
                up: async () => {
                    // INT → DECIMAL(10,2) so the client can report actual
                    // wall-clock-elapsed playback (fractional seconds) without
                    // half-second rounding loss on every flush. DECIMAL, not
                    // FLOAT: watch_seconds is a running counter and += 0.N on
                    // FLOAT accumulates IEEE-754 drift; DECIMAL is exact.
                    await pool.execute(`ALTER TABLE watch_progress MODIFY watch_seconds DECIMAL(10,2) NOT NULL DEFAULT 0`);
                }
            },
            {
                id: '027_cmaf_support',
                up: async () => {
                    // Videos: tag each row with its container format. Legacy rows
                    // stay on TS forever; new uploads will start getting 'cmaf'
                    // once the upload flow is flipped (phase 4 of the rollout).
                    await pool.execute(`
                        ALTER TABLE videos
                        ADD COLUMN video_type ENUM('ts','cmaf') NOT NULL DEFAULT 'ts' AFTER encryption_key
                    `);

                    // Transcoding profiles: audio is now a single site-wide
                    // rendition (CMAF puts audio in its own adaptation set),
                    // so per-profile audio_bitrate_kbps is gone.
                    await pool.execute(`
                        ALTER TABLE transcoding_profiles
                        DROP COLUMN audio_bitrate_kbps
                    `);

                    // fps_limit per profile — downsample if source > limit,
                    // never upsample. Default 60 matches current content norms.
                    await pool.execute(`
                        ALTER TABLE transcoding_profiles
                        ADD COLUMN fps_limit INT UNSIGNED NOT NULL DEFAULT 60 AFTER video_bitrate_kbps
                    `);

                    // Site-wide audio bitrate default (kbps). One rendition for
                    // every CMAF job. Validated 128–320 on the API boundary.
                    await pool.execute(`
                        INSERT IGNORE INTO site_settings (setting_key, setting_value)
                        VALUES ('audio_bitrate_default', '192')
                    `);
                }
            },
            {
                id: '028_mfa_otp_encrypt',
                up: async () => {
                    // Drop all in-flight OTP state — per directive we don't
                    // preserve mid-verification rows across this migration.
                    await pool.execute(`
                        UPDATE mfa_challenges
                        SET otp_hash = NULL, otp_sent_at = NULL, otp_attempts = 0
                    `);
                    // otp_hash held an argon2 hash; we now store the OTP
                    // encrypted with MFA_ENCRYPTION_KEY so it can be recovered
                    // and resent unchanged when the user asks for a retry.
                    await pool.execute(`
                        ALTER TABLE mfa_challenges
                        CHANGE COLUMN otp_hash otp_value VARCHAR(255) DEFAULT NULL
                    `);
                    // otp_sent_at tracks the latest send (drives verification
                    // expiry); otp_generated_at tracks the original generation
                    // and decides when a resend must produce a fresh code.
                    await pool.execute(`
                        ALTER TABLE mfa_challenges
                        ADD COLUMN otp_generated_at DATETIME DEFAULT NULL AFTER otp_value
                    `);
                }
            },
            {
                id: '029_rename_session_last_activity_to_last_seen',
                up: async () => {
                    // Match the worker_sessions naming. Backend / frontend /
                    // API responses all switch to last_seen in lockstep.
                    await pool.execute(`
                        ALTER TABLE sessions
                        CHANGE COLUMN last_activity last_seen DATETIME NOT NULL
                    `);
                }
            },
            {
                id: '030_cloudflare_turnstile_worker_gate',
                up: async () => {
                    // Admin toggle for "Turnstile is verified at the edge by
                    // a Cloudflare Worker; origin should skip its own
                    // siteverify call." Defaults to off — existing deploys
                    // keep their current origin-side verification behavior
                    // until an admin enables it from the Settings page.
                    await pool.execute(`
                        INSERT IGNORE INTO site_settings (setting_key, setting_value)
                        VALUES ('cloudflare_turnstile_worker_gate', 'false')
                    `);
                }
            },
            {
                id: '031_pending_deletes',
                up: async () => {
                    // Durable queue for R2 object deletions. Replaces the
                    // fire-and-forget `cleanR2Prefix.catch(log)` pattern
                    // scattered across course/video/material/processing
                    // services with a single retry-capable mechanism.
                    //
                    // mode='key' — DeleteObject(target). 'prefix' —
                    // ListObjectsV2 + batched DeleteObjects until empty.
                    // hashed_video_id is denormalized off `target` for the
                    // hash-collision check at video creation time; null
                    // for source / attachment / material rows. Reaper
                    // hard-deletes the row on success — failed-and-stuck
                    // rows accumulate `attempts` + `last_error` and stay
                    // in the table for ops visibility.
                    await pool.execute(`
                        CREATE TABLE IF NOT EXISTS pending_deletes (
                            id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                            mode              ENUM('key','prefix') NOT NULL,
                            target            VARCHAR(512) NOT NULL,
                            hashed_video_id   VARCHAR(64) DEFAULT NULL,
                            execute_at        DATETIME NOT NULL,
                            attempts          INT UNSIGNED NOT NULL DEFAULT 0,
                            last_attempt_at   DATETIME DEFAULT NULL,
                            last_error        TEXT DEFAULT NULL,
                            source            VARCHAR(32) DEFAULT NULL,
                            created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                            INDEX idx_pending_deletes_execute_at (execute_at),
                            INDEX idx_pending_deletes_hashed_video_id (hashed_video_id)
                        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                    `);
                }
            },
            {
                id: '032_stateful_attachment_uploads',
                up: async () => {
                    // upload_sessions now backs both video (multipart) and
                    // attachment (single-PUT) flows. type tells the two
                    // apart; r2_upload_id + total_parts are multipart-only;
                    // content_type is set by attachments (used at
                    // /complete to set R2 Cache-Control and to seed the
                    // course_materials row).
                    await pool.execute(`
                        ALTER TABLE upload_sessions
                          ADD COLUMN type ENUM('video','attachment')
                            NOT NULL DEFAULT 'video' AFTER created_by
                    `);
                    await pool.execute(`
                        ALTER TABLE upload_sessions
                          ADD COLUMN content_type VARCHAR(100)
                            DEFAULT NULL AFTER object_key
                    `);
                    await pool.execute(`
                        ALTER TABLE upload_sessions
                          MODIFY COLUMN r2_upload_id VARCHAR(1024) DEFAULT NULL
                    `);
                    await pool.execute(`
                        ALTER TABLE upload_sessions
                          MODIFY COLUMN total_parts INT UNSIGNED DEFAULT NULL
                    `);

                    // course_materials.status was used to distinguish
                    // 'uploading' placeholders from confirmed 'active'
                    // rows. With the new flow the placeholder lives in
                    // upload_sessions and course_materials only gets a
                    // row at /complete — so the column is dead. User
                    // verified no in-flight rows in prod before deploy.
                    await pool.execute(`
                        ALTER TABLE course_materials DROP INDEX idx_course_materials_status
                    `);
                    await pool.execute(`
                        ALTER TABLE course_materials DROP COLUMN status
                    `);
                }
            },
            {
                id: '033_enhanced_transcoding_profiles',
                up: async () => {
                    // Split global transcoding_profiles into two sets — the
                    // existing "default" set and a new "enhanced" set
                    // (1440p/1080p/720p, higher bitrates) — discriminated by
                    // is_enhanced_profile. is_system_profile flags the seeded
                    // rows so the admin UI hides the Delete button and the
                    // PUT handler rejects payloads that drop them.
                    //
                    // course_id IS NOT NULL (course-specific overrides) keep
                    // is_system_profile=0 and is_enhanced_profile=NULL — the
                    // enhanced concept is meaningless for those rows.
                    await pool.execute(`
                        ALTER TABLE transcoding_profiles
                          ADD COLUMN is_system_profile   TINYINT(1) NOT NULL DEFAULT 0 AFTER course_id,
                          ADD COLUMN is_enhanced_profile TINYINT(1)          DEFAULT NULL AFTER is_system_profile
                    `);
                    await pool.execute(`
                        UPDATE transcoding_profiles
                           SET is_system_profile = 1, is_enhanced_profile = 0
                         WHERE course_id IS NULL
                    `);

                    // gop_size (frames) -> gop_seconds. The worker computes
                    // keyint = round(gop_seconds * effective_fps) at FFmpeg
                    // arg time so GOP stays at 2s regardless of source fps.
                    // DECIMAL(4,2) allows fractional values (e.g. 1.5s).
                    await pool.execute(`
                        ALTER TABLE transcoding_profiles
                          ADD COLUMN gop_seconds DECIMAL(4,2) UNSIGNED NOT NULL DEFAULT 2.00 AFTER segment_duration
                    `);
                    await pool.execute(`
                        ALTER TABLE transcoding_profiles DROP COLUMN gop_size
                    `);

                    // Seed the enhanced set.
                    await pool.execute(`
                        INSERT INTO transcoding_profiles
                          (course_id, is_system_profile, is_enhanced_profile, name,
                           width, height, video_bitrate_kbps, fps_limit,
                           codec, profile, preset, segment_duration, gop_seconds, sort_order)
                        VALUES
                          (NULL, 1, 1, '1440p', 2560, 1440, 18000, 60, 'h264', 'high', 'medium', 6, 2.00, 0),
                          (NULL, 1, 1, '1080p', 1920, 1080, 10000, 60, 'h264', 'high', 'medium', 6, 2.00, 1),
                          (NULL, 1, 1, '720p',  1280,  720,  6000, 60, 'h264', 'main', 'medium', 6, 2.00, 2)
                    `);

                    // Per-course toggle: when use_custom_profiles=0, this
                    // picks between the default and enhanced global sets.
                    await pool.execute(`
                        ALTER TABLE courses
                          ADD COLUMN use_enhanced_profiles TINYINT(1) NOT NULL DEFAULT 0 AFTER use_custom_profiles
                    `);
                }
            },
            {
                id: '034_toggle_own_mfa',
                up: async () => {
                    // toggleOwnMfa gates the per-account MFA enable/disable
                    // toggle on the profile page. Granted to every existing
                    // role so current behavior (anyone can toggle their own
                    // MFA) is preserved; deny it per-user (or per-role) to
                    // lock the toggle, e.g. on shared demo accounts.
                    //
                    // Independent of requireMFA — see routes/api/mfa.js: the
                    // enable endpoint accepts toggleOwnMfa OR requireMFA so a
                    // require-MFA user can still complete forced enrollment
                    // even without the toggle permission.
                    await pool.execute(`
                        INSERT IGNORE INTO role_permissions (role_id, permission_key, granted)
                        SELECT role_id, 'toggleOwnMfa', 1 FROM roles
                    `);
                }
            },
            {
                id: '035_encrypt_settings_secrets',
                up: async () => {
                    // Encrypt-at-rest for sensitive site_settings rows
                    // (HMAC playback secret, email-sender HMAC secret).
                    // Future writes via setSecretSetting() encrypt
                    // transparently; this migration covers the rows that
                    // already exist on existing deployments.
                    //
                    // Failures here fail-loud (throw) so the operator
                    // can't end up with encrypted DB rows + no key to
                    // decrypt them. Idempotent via the enc:v1: prefix.
                    if (!process.env.SETTINGS_SECRET_ENCRYPTION_KEY) {
                        throw new Error(
                            'Migration 035 requires SETTINGS_SECRET_ENCRYPTION_KEY in .env. ' +
                            'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" ' +
                            'then add SETTINGS_SECRET_ENCRYPTION_KEY=... to .env and restart.'
                        );
                    }
                    const { encryptSettingValue, isEncrypted } = require('../services/settingsEncryption');
                    const SECRET_KEYS = ['hmac_secret_key', 'email_secret_key'];
                    for (const key of SECRET_KEYS) {
                        const [[row]] = await pool.execute(
                            'SELECT setting_value FROM site_settings WHERE setting_key = ?',
                            [key]
                        );
                        if (!row) continue;                          // never configured — nothing to encrypt
                        if (isEncrypted(row.setting_value)) continue; // already encrypted on a prior run
                        const encrypted = encryptSettingValue(row.setting_value);
                        await pool.execute(
                            'UPDATE site_settings SET setting_value = ? WHERE setting_key = ?',
                            [encrypted, key]
                        );
                    }
                }
            },
            {
                id: '036_rename_hmac_enabled',
                up: async () => {
                    // Disambiguate the two HMAC concepts in site_settings:
                    //   - hmac_secret_key       — video playback URL signing
                    //   - hmac_enabled          — video HMAC toggle  (renamed here)
                    //   - email_secret_key      — email-sender worker HMAC
                    //   - cf_access_client_*    — service token for email worker
                    //
                    // Renames hmac_enabled → video_hmac_enabled. INSERT-SELECT
                    // copies the value (no-op if the old row is absent),
                    // ON DUPLICATE KEY UPDATE makes it safe to re-run after a
                    // partial run, and the DELETE drops the old row.
                    await pool.execute(`
                        INSERT INTO site_settings (setting_key, setting_value)
                        SELECT 'video_hmac_enabled', setting_value
                          FROM site_settings WHERE setting_key = 'hmac_enabled'
                        ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)
                    `);
                    await pool.execute(`DELETE FROM site_settings WHERE setting_key = 'hmac_enabled'`);
                }
            },
            {
                id: '037_rename_hmac_token_validity',
                up: async () => {
                    // Same rename mechanic as 036 — moves the validity hint to
                    // the video_-prefixed namespace so the Cloudflare card's
                    // keys all line up (video_hmac_*, email_hmac_*, etc.).
                    await pool.execute(`
                        INSERT INTO site_settings (setting_key, setting_value)
                        SELECT 'video_hmac_token_validity', setting_value
                          FROM site_settings WHERE setting_key = 'hmac_token_validity'
                        ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)
                    `);
                    await pool.execute(`DELETE FROM site_settings WHERE setting_key = 'hmac_token_validity'`);
                }
            },
            {
                id: '038_worker_access_keys_status',
                up: async () => {
                    // Replace the boolean is_active with a tri-state status:
                    //   'active'      - normal, accepts auth and polls
                    //   'paused'      - admin-paused; auth still works (so the
                    //                   running worker keeps a valid session)
                    //                   but polling returns empty and lease
                    //                   rejects, so no new jobs flow.
                    //   'deactivated' - revoked by leak detection or admin;
                    //                   auth refuses, existing sessions are
                    //                   cleared at deactivation time.
                    //
                    // Existing is_active=1 rows map to 'active', is_active=0 to
                    // 'deactivated'. The new column is added first, backfilled,
                    // then is_active is dropped.
                    await pool.execute(`
                        ALTER TABLE worker_access_keys
                          ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'active' AFTER label
                    `);
                    await pool.execute(`
                        UPDATE worker_access_keys
                           SET status = CASE WHEN is_active = 1 THEN 'active' ELSE 'deactivated' END
                    `);
                    await pool.execute(`
                        ALTER TABLE worker_access_keys DROP COLUMN is_active
                    `);
                }
            },
            {
                id: '039_videos_has_poster',
                up: async () => {
                    // Per-video poster JPG generated by the worker right after
                    // probe. Default 0 keeps old videos at "no poster" — the
                    // course list page falls back to the play-icon glyph for
                    // those rows. The worker reports has_poster=true on
                    // successful upload via /api/worker/tasks/complete, which
                    // flips this to 1.
                    //
                    // Stored at R2 key `{hashed_video_id}/{processing_job_id}/poster.jpg`.
                    // The list endpoint mints a per-file HMAC token only for
                    // rows where this flag is set, so we don't sign URLs that
                    // would 404 anyway.
                    await pool.execute(`
                        ALTER TABLE videos
                          ADD COLUMN has_poster TINYINT(1) NOT NULL DEFAULT 0
                    `);
                }
            },
            {
                id: '040_copy_posters_to_per_course_layout',
                up: async () => {
                    // Move every existing per-video poster from the per-job
                    // `{hashed_video_id}/{processing_job_id}/poster.jpg` key
                    // into the per-course `posters/{course_id}/{video_id}.jpg`
                    // layout. This change unlocks two things downstream:
                    //   1. Course delete sweeps `posters/{course_id}/` as one
                    //      R2 prefix instead of needing per-video logic.
                    //   2. Re-uploading the same video_id overwrites the
                    //      poster in place (stable key, no orphan).
                    //
                    // Strategy: R2 server-side CopyObject — no download/upload
                    // round trip. The old key stays in place (~35 KB per
                    // video) until the video or course is deleted; the hash-
                    // prefix sweep in deletionService catches it then.
                    //
                    // Per-row try/catch so a single missing source object
                    // (e.g. the poster was hand-deleted out of R2) doesn't
                    // abort the whole pass. Idempotent — if the migration
                    // table loses a row and we re-run, CopyObject overwrites
                    // the destination, which is fine. The schema_migrations
                    // entry guards against the normal case.
                    const { CopyObjectCommand } = require('@aws-sdk/client-s3');
                    const { getR2Client, getR2BucketName } = require('../config/r2');
                    const r2 = getR2Client();
                    const bucket = getR2BucketName();

                    const [rows] = await pool.execute(`
                        SELECT video_id, course_id, hashed_video_id, processing_job_id
                          FROM videos
                         WHERE has_poster = 1
                           AND hashed_video_id IS NOT NULL
                           AND processing_job_id IS NOT NULL
                    `);
                    if (rows.length === 0) {
                        console.log('Migration 040: no posters to copy');
                        return;
                    }

                    let copied = 0;
                    let skipped = 0;
                    for (const row of rows) {
                        const oldKey = `${row.hashed_video_id}/${row.processing_job_id}/poster.jpg`;
                        const newKey = `posters/${row.course_id}/${row.video_id}.jpg`;
                        try {
                            await r2.send(new CopyObjectCommand({
                                Bucket: bucket,
                                Key: newKey,
                                CopySource: `${bucket}/${oldKey}`,
                                ContentType: 'image/jpeg',
                                CacheControl: 'public, max-age=31536000, immutable',
                                MetadataDirective: 'REPLACE',
                            }));
                            copied++;
                        } catch (err) {
                            console.error(
                                `Migration 040: failed to copy ${oldKey} → ${newKey}: ${err.message}`
                            );
                            skipped++;
                        }
                    }
                    console.log(`Migration 040: copied ${copied} poster(s), skipped ${skipped}`);
                }
            },
            {
                id: '041_sso_avatar',
                up: async () => {
                    // Profile picture file name mirrored from the SSO
                    // ({sub}-{16hex}.webp); bytes are fetched S2S on demand.
                    await pool.execute(`
                        ALTER TABLE users
                        ADD COLUMN sso_avatar VARCHAR(80) DEFAULT NULL AFTER display_name
                    `);
                }
            },
            {
                id: '042_sso_identity_cleanup',
                up: async () => {
                    // Identity moved to the SSO: local registration, password
                    // reset, invitation codes, email OTP (MFA level 0), and the
                    // enable/disable flag are gone. Suspension is SSO-owned
                    // (back-channel kills sessions; sign-in refused upstream).
                    await pool.execute('ALTER TABLE users DROP COLUMN is_active');
                    await pool.execute('DROP TABLE IF EXISTS pending_registrations');
                    await pool.execute('DROP TABLE IF EXISTS registration_email_limits');
                    await pool.execute('DROP TABLE IF EXISTS password_reset_tokens');
                    await pool.execute('DROP TABLE IF EXISTS password_reset_email_limits');
                    await pool.execute('DROP TABLE IF EXISTS invitation_codes');
                    await pool.execute('DROP TABLE IF EXISTS mfa_otp_rate_limits');
                    // Email was only ever an implicit MFA method (level 0) —
                    // no enrolled rows should exist, but sweep defensively.
                    await pool.execute(`DELETE FROM user_mfa_methods WHERE method_type = 'email'`);
                    await pool.execute(`
                        DELETE FROM site_settings WHERE setting_key IN (
                            'enable_registration', 'require_invitation_code',
                            'registration_token_validity_minutes', 'emailed_link_validity_minutes',
                            'cloudflare_turnstile_worker_gate',
                            'email_secret_key', 'email_with_service_credentials',
                            'cf_access_client_id', 'cf_access_client_secret',
                            'mfa_otp_timeout_seconds', 'mfa_level_0_timeout_seconds',
                            'mfa_policy_login', 'mfa_policy_invitation_codes'
                        )
                    `);
                    // Surviving scenario policies at the removed level 0 move
                    // to level 1 (authenticator + passkey).
                    const [policies] = await pool.execute(
                        `SELECT setting_key, setting_value FROM site_settings WHERE setting_key LIKE 'mfa_policy_%'`
                    );
                    for (const row of policies) {
                        try {
                            const p = JSON.parse(row.setting_value);
                            if (p && Number(p.level) === 0) {
                                p.level = 1;
                                await pool.execute(
                                    'UPDATE site_settings SET setting_value = ? WHERE setting_key = ?',
                                    [JSON.stringify(p), row.setting_key]
                                );
                            }
                        } catch { /* unparseable policy — leave it */ }
                    }
                }
            },
            {
                id: '043_course_code_name_rename',
                up: async () => {
                    // The old course_name is really a short code; the old
                    // description is the real title. Rename to course_code +
                    // course_name (sidebar shows the code, the header the
                    // name, falling back to the code when name is null).
                    await pool.execute('ALTER TABLE courses CHANGE COLUMN course_name course_code VARCHAR(15) NOT NULL');
                    await pool.execute('ALTER TABLE courses CHANGE COLUMN description course_name VARCHAR(300) DEFAULT NULL');
                    // Empty (never-set) descriptions become NULL so the
                    // name-or-code fallback works everywhere.
                    await pool.execute("UPDATE courses SET course_name = NULL WHERE course_name = ''");
                }
            },
            {
                id: '044_module_number_and_label',
                up: async () => {
                    // Generalize "week" into a course-configurable module number.
                    // Each item keeps its number in a renamed column; the course
                    // gets a label term (week/chapter/module/…) shown next to it.
                    await pool.execute('ALTER TABLE videos CHANGE COLUMN week module_number VARCHAR(50) DEFAULT NULL');
                    await pool.execute('ALTER TABLE upload_sessions CHANGE COLUMN week module_number VARCHAR(20) DEFAULT NULL');
                    await pool.execute('ALTER TABLE course_materials CHANGE COLUMN week module_number VARCHAR(20) DEFAULT NULL');
                    await pool.execute('ALTER TABLE courses ADD COLUMN module_label VARCHAR(20) DEFAULT NULL');
                    // Every existing course keeps its current "Week N" labelling.
                    await pool.execute("UPDATE courses SET module_label = 'week'");
                }
            },
            {
                id: '045_drop_course_mfa_policy',
                up: async () => {
                    // The /admin/courses* routes no longer call requireMfaForScenario:
                    // step-up moves to SSO. The surviving policy row rendered a Course
                    // card in admin MFA settings that gated nothing.
                    await pool.execute(`DELETE FROM site_settings WHERE setting_key = 'mfa_policy_course'`);
                }
            },
            {
                id: '046_drop_clear_playback_stat_perm',
                up: async () => {
                    // Playback stats were distributed into the course modal +
                    // edit-user section; the site-wide reset now lives in Site
                    // Settings under manageSite. The old clearPlaybackStat key is
                    // gone from ALL_PERMISSIONS — drop its granted rows + any
                    // per-user overrides so nothing dangles. (permissionCache
                    // already filters unknown keys, so this is pure hygiene.)
                    await pool.execute(`DELETE FROM role_permissions WHERE permission_key = 'clearPlaybackStat'`);
                    await pool.execute(`DELETE FROM user_permission_overrides WHERE permission_key = 'clearPlaybackStat'`);
                }
            },
            {
                id: '047_drop_manage_site_mfa_perm',
                up: async () => {
                    // MFA settings were folded into the unified /admin/settings
                    // surface, gated by manageSite alone. The manageSiteMFA key
                    // is gone from ALL_PERMISSIONS — drop its granted rows + any
                    // per-user overrides so nothing dangles. (permissionCache
                    // already filters unknown keys, so this is pure hygiene.)
                    await pool.execute(`DELETE FROM role_permissions WHERE permission_key = 'manageSiteMFA'`);
                    await pool.execute(`DELETE FROM user_permission_overrides WHERE permission_key = 'manageSiteMFA'`);
                }
            },
            {
                id: '048_session_stepup',
                up: async () => {
                    // SSO step-up (sudo) window for videosite. The /auth/stepup
                    // ceremony stamps the fresh factor + time on the session row;
                    // the gate + status endpoint read it. Column-guarded so a
                    // re-run (or a hand-applied column) is a no-op — MySQL 8 has no
                    // ADD COLUMN IF NOT EXISTS.
                    const [cols] = await pool.execute(
                        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
                          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sessions'
                            AND COLUMN_NAME IN ('stepup_at','stepup_method')`
                    );
                    const have = new Set(cols.map(c => c.COLUMN_NAME));
                    if (!have.has('stepup_at')) {
                        await pool.execute(`ALTER TABLE sessions ADD COLUMN stepup_at DATETIME NULL`);
                    }
                    if (!have.has('stepup_method')) {
                        await pool.execute(`ALTER TABLE sessions ADD COLUMN stepup_method VARCHAR(16) NULL`);
                    }
                }
            },
            {
                id: '049_drop_password_columns',
                up: async () => {
                    // videosite authenticates nobody — sign-in is the SSO, users are
                    // JIT-created from the id_token, and the installer no longer makes
                    // an account. password_hash was write-only dead weight: the old
                    // installer wrote an argon2 hash that nothing ever read.
                    //
                    // It was also an active bug: the column is NOT NULL with no default,
                    // and findOrCreateBySub INSERTs without it — so JIT-creating a brand
                    // new SSO identity would fail outright under MySQL strict mode.
                    // Column-guarded (MySQL 8 has no DROP COLUMN IF EXISTS).
                    const [cols] = await pool.execute(
                        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
                          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
                            AND COLUMN_NAME IN ('password_hash','password_changed_at')`
                    );
                    const have = new Set(cols.map(c => c.COLUMN_NAME));
                    if (have.has('password_hash')) {
                        await pool.execute('ALTER TABLE users DROP COLUMN password_hash');
                    }
                    if (have.has('password_changed_at')) {
                        await pool.execute('ALTER TABLE users DROP COLUMN password_changed_at');
                    }
                }
            },
        ];

        for (const migration of migrations) {
            const [rows] = await pool.execute(
                'SELECT 1 FROM schema_migrations WHERE migration_id = ?',
                [migration.id]
            );
            if (rows.length === 0) {
                console.log(`Running migration: ${migration.id}`);
                await migration.up();
                await pool.execute(
                    'INSERT INTO schema_migrations (migration_id) VALUES (?)',
                    [migration.id]
                );
                console.log(`Migration ${migration.id} applied successfully`);
            }
        }
    } catch (err) {
        console.error('Migration error:', err.message);
        // Boot: log and carry on rather than take a running site down.
        // Installer (strict): the operator must not be told the install worked.
        if (strict) throw err;
    }
}

module.exports = { runMigrations };
