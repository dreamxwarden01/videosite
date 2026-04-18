-- VideoSite Database Schema

CREATE TABLE IF NOT EXISTS roles (
    role_id          INT UNSIGNED PRIMARY KEY,
    role_name        VARCHAR(50)  NOT NULL UNIQUE,
    permission_level INT UNSIGNED NOT NULL,
    description      VARCHAR(255) DEFAULT NULL,
    is_system        TINYINT(1)   NOT NULL DEFAULT 0,
    created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id        INT UNSIGNED NOT NULL,
    permission_key VARCHAR(50)  NOT NULL,
    granted        TINYINT(1)   NOT NULL DEFAULT 1,
    PRIMARY KEY (role_id, permission_key),
    FOREIGN KEY (role_id) REFERENCES roles(role_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS users (
    user_id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username           VARCHAR(50)  NOT NULL UNIQUE,
    display_name       VARCHAR(100) NOT NULL,
    email              VARCHAR(255) DEFAULT NULL,
    mfa_enabled        TINYINT(1)   NOT NULL DEFAULT 0,
    password_hash      VARCHAR(255) NOT NULL,
    password_changed_at DATETIME    DEFAULT NULL,
    role_id            INT UNSIGNED NOT NULL DEFAULT 2,
    is_active          TINYINT(1)   NOT NULL DEFAULT 1,
    created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE INDEX uq_users_email (email),
    FOREIGN KEY (role_id) REFERENCES roles(role_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_permission_overrides (
    user_id        INT UNSIGNED NOT NULL,
    permission_key VARCHAR(50)  NOT NULL,
    override_value TINYINT      NOT NULL,
    PRIMARY KEY (user_id, permission_key),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sessions (
    session_id   VARCHAR(128) PRIMARY KEY,
    user_id      INT UNSIGNED NOT NULL,
    last_activity DATETIME    NOT NULL,
    last_sign_in DATETIME     NOT NULL,
    user_agent   VARCHAR(255) DEFAULT NULL,
    ip_address   VARCHAR(45)  DEFAULT NULL,
    created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS courses (
    course_id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    course_name          VARCHAR(255) NOT NULL,
    description          TEXT         DEFAULT NULL,
    use_custom_profiles  TINYINT(1)   NOT NULL DEFAULT 0,
    audio_normalization  TINYINT(1)   NOT NULL DEFAULT 1,
    is_active            TINYINT(1)   NOT NULL DEFAULT 1,
    created_by           INT UNSIGNED DEFAULT NULL,
    created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS enrollments (
    enrollment_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id       INT UNSIGNED NOT NULL,
    course_id     INT UNSIGNED NOT NULL,
    enrolled_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_enrollment (user_id, course_id),
    FOREIGN KEY (user_id)   REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (course_id) REFERENCES courses(course_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS videos (
    video_id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    course_id           INT UNSIGNED NOT NULL,
    title               VARCHAR(255) NOT NULL,
    description         TEXT         DEFAULT NULL,
    week                VARCHAR(50)  DEFAULT NULL,
    lecture_date        DATE         DEFAULT NULL,
    hashed_video_id     VARCHAR(64)  NOT NULL UNIQUE,
    duration_seconds    INT UNSIGNED DEFAULT NULL,
    original_filename   VARCHAR(255) DEFAULT NULL,
    file_size_bytes     BIGINT UNSIGNED DEFAULT NULL,
    status              ENUM('queued','worker_downloading','processing','worker_uploading','finished','error')
                        NOT NULL DEFAULT 'queued',
    processing_job_id   VARCHAR(64)  DEFAULT NULL,
    processing_progress TINYINT UNSIGNED DEFAULT 0,
    processing_error    TEXT         DEFAULT NULL,
    r2_source_key       VARCHAR(500) DEFAULT NULL,
    encryption_key      VARBINARY(16) DEFAULT NULL,
    uploaded_by         INT UNSIGNED DEFAULT NULL,
    created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (course_id)   REFERENCES courses(course_id) ON DELETE CASCADE,
    FOREIGN KEY (uploaded_by) REFERENCES users(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS processing_queue (
    task_id        INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    video_id       INT UNSIGNED NOT NULL UNIQUE,
    status         ENUM('queued','pending','leased','processing','completed','error','aborted')
                   NOT NULL DEFAULT 'queued',
    job_id         VARCHAR(64)  DEFAULT NULL,
    worker_key_id  VARCHAR(64)  DEFAULT NULL,
    leased_at      DATETIME     DEFAULT NULL,
    last_heartbeat DATETIME     DEFAULT NULL,
    pending_until  DATETIME     DEFAULT NULL,
    cleared        TINYINT(1)   NOT NULL DEFAULT 0,
    error_at       DATETIME     DEFAULT NULL,
    progress       TINYINT UNSIGNED DEFAULT 0,
    error_message  TEXT         DEFAULT NULL,
    created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (video_id) REFERENCES videos(video_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS upload_sessions (
    upload_id         VARCHAR(12)  PRIMARY KEY,
    video_id          INT UNSIGNED DEFAULT NULL,
    course_id         INT UNSIGNED NOT NULL,
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS worker_access_keys (
    key_id       VARCHAR(64)  PRIMARY KEY,
    key_secret   VARCHAR(255) NOT NULL,
    label        VARCHAR(100) DEFAULT NULL,
    is_active    TINYINT(1)   NOT NULL DEFAULT 1,
    created_by   INT UNSIGNED DEFAULT NULL,
    created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME     DEFAULT NULL,
    FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS watch_progress (
    user_id       INT UNSIGNED NOT NULL,
    video_id      INT UNSIGNED NOT NULL,
    watch_seconds DECIMAL(10,2) NOT NULL DEFAULT 0,
    last_position FLOAT        NOT NULL DEFAULT 0,
    last_watch_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, video_id),
    FOREIGN KEY (user_id)  REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (video_id) REFERENCES videos(video_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS site_settings (
    setting_key   VARCHAR(50)  PRIMARY KEY,
    setting_value TEXT         NOT NULL,
    updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pending_registrations (
    email           VARCHAR(255) NOT NULL PRIMARY KEY,
    token           VARCHAR(128) NOT NULL,
    invitation_code VARCHAR(12)  DEFAULT NULL,
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_sent_at    DATETIME     NOT NULL,
    INDEX idx_token (token),
    INDEX idx_expires (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS registration_email_limits (
    email      VARCHAR(255) PRIMARY KEY,
    first_sent DATETIME     NOT NULL,
    last_sent  DATETIME     NOT NULL,
    total_sent INT UNSIGNED NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS invitation_codes (
    code       VARCHAR(12)  PRIMARY KEY,
    created_by INT UNSIGNED DEFAULT NULL,
    created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME     NOT NULL,
    FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
    last_used_at         DATETIME DEFAULT NULL,
    UNIQUE KEY uq_credential (credential_id),
    INDEX idx_user_method (user_id, method_type),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mfa_challenges (
    id                VARCHAR(64) PRIMARY KEY,
    user_id           INT UNSIGNED NOT NULL,
    context_type      ENUM('sid','preauth','bmfa') NOT NULL,
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mfa_otp_rate_limits (
    user_id    INT UNSIGNED PRIMARY KEY,
    first_sent DATETIME     NOT NULL,
    last_sent  DATETIME     NOT NULL,
    total_sent INT UNSIGNED NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mfa_totp_rate_limits (
    user_id          INT UNSIGNED PRIMARY KEY,
    attempt_count    INT UNSIGNED NOT NULL DEFAULT 0,
    first_attempt_at DATETIME NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token      VARCHAR(128) NOT NULL PRIMARY KEY,
    user_id    INT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    used       TINYINT(1) NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    INDEX idx_user_id (user_id),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS password_reset_email_limits (
    email      VARCHAR(255) PRIMARY KEY,
    first_sent DATETIME NOT NULL,
    last_sent  DATETIME NOT NULL,
    total_sent INT UNSIGNED NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bmfa_tokens (
    token       VARCHAR(128) NOT NULL PRIMARY KEY,
    ip_address  VARCHAR(45)  DEFAULT NULL,
    user_agent  TEXT         DEFAULT NULL,
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at  DATETIME     NOT NULL,
    INDEX idx_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS schema_migrations (
    migration_id   VARCHAR(100) PRIMARY KEY,
    applied_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
