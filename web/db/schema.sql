-- videosite schema — GENERATED. Do not hand-edit.
--
-- This is a dump of a database at the BASELINE migration recorded in db/baseline.json
-- (`through`), and db/seed.sql marks exactly those migrations applied. A fresh install
-- lays this down and then runs every migration ADDED SINCE, which is the same code
-- path an existing install takes at boot.
--
-- So: adding a migration means appending it to db/migrations.js and touching NEITHER
-- this file NOR seed.sql. There is nothing to keep in sync, which is the whole point.
-- `npm run check:db` enforces it; lib/dbBaseline.js explains it.
--
-- To collapse a long migration tail, re-dump this file from a fully-migrated database
-- and run `npm run db:bless` — that moves seed.sql's list and baseline.json with it,
-- in one step, so they cannot drift.
--
-- They drifted once and fresh installs broke: this file had grown post-024 columns
-- while seed.sql still claimed only 001..024 were applied, so the installer replayed
-- two dozen migrations onto a schema that already had their changes and died on
-- "Duplicate column name 'video_type'". It also still created six tables migration 042
-- deletes.

SET FOREIGN_KEY_CHECKS = 0;

/*M!999999\- enable the sandbox mode */ 
CREATE TABLE IF NOT EXISTS `bmfa_tokens` (
  `token` varchar(128) NOT NULL,
  `ip_address` varchar(45) DEFAULT NULL,
  `user_agent` text DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `expires_at` datetime NOT NULL,
  PRIMARY KEY (`token`),
  KEY `idx_expires` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS `course_materials` (
  `material_id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `course_id` int(10) unsigned NOT NULL,
  `object_key` varchar(255) NOT NULL,
  `filename` varchar(255) NOT NULL,
  `file_size` bigint(20) unsigned NOT NULL DEFAULT 0,
  `content_type` varchar(100) NOT NULL DEFAULT 'application/octet-stream',
  `module_number` varchar(20) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `uploaded_by` binary(16) NOT NULL,
  PRIMARY KEY (`material_id`),
  KEY `idx_course_materials_course` (`course_id`),
  KEY `uploaded_by` (`uploaded_by`),
  CONSTRAINT `course_materials_ibfk_1` FOREIGN KEY (`course_id`) REFERENCES `courses` (`course_id`) ON DELETE CASCADE,
  CONSTRAINT `course_materials_ibfk_2` FOREIGN KEY (`uploaded_by`) REFERENCES `users` (`user_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS `courses` (
  `course_id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `course_code` varchar(15) NOT NULL,
  `course_name` varchar(300) DEFAULT NULL,
  `use_custom_profiles` tinyint(1) NOT NULL DEFAULT 0,
  `use_enhanced_profiles` tinyint(1) NOT NULL DEFAULT 0,
  `audio_normalization` tinyint(1) NOT NULL DEFAULT 1,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `created_by` binary(16) DEFAULT NULL,
  `module_label` varchar(20) DEFAULT NULL,
  PRIMARY KEY (`course_id`),
  KEY `created_by` (`created_by`),
  CONSTRAINT `courses_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`user_id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS `enrollments` (
  `enrollment_id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `course_id` int(10) unsigned NOT NULL,
  `enrolled_at` datetime NOT NULL DEFAULT current_timestamp(),
  `user_id` binary(16) NOT NULL,
  PRIMARY KEY (`enrollment_id`),
  UNIQUE KEY `uq_enrollment` (`user_id`,`course_id`),
  KEY `course_id` (`course_id`),
  CONSTRAINT `enrollments_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE,
  CONSTRAINT `enrollments_ibfk_2` FOREIGN KEY (`course_id`) REFERENCES `courses` (`course_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS `mfa_challenges` (
  `id` varchar(64) NOT NULL,
  `context_type` enum('sid','preauth','bmfa') NOT NULL,
  `context_id` varchar(128) NOT NULL,
  `approved_endpoint` varchar(255) DEFAULT NULL,
  `allowed_methods` varchar(100) NOT NULL DEFAULT 'email,authenticator,passkey',
  `mfa_level` tinyint(3) unsigned NOT NULL DEFAULT 0,
  `message_type` enum('login','password_reset','mfa_change','admin_operation','email_verification') NOT NULL,
  `message_operation` varchar(255) DEFAULT NULL,
  `status` enum('pending','verified','consumed','expired') NOT NULL DEFAULT 'pending',
  `can_reuse` tinyint(1) NOT NULL DEFAULT 0,
  `used_count` int(10) unsigned NOT NULL DEFAULT 0,
  `otp_value` varchar(255) DEFAULT NULL,
  `otp_generated_at` datetime DEFAULT NULL,
  `otp_attempts` int(10) unsigned NOT NULL DEFAULT 0,
  `otp_sent_at` datetime DEFAULT NULL,
  `webauthn_challenge` varchar(255) DEFAULT NULL,
  `verified_method` enum('email','authenticator','passkey') DEFAULT NULL,
  `verified_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `expires_at` datetime NOT NULL,
  `user_id` binary(16) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_status_expires` (`status`,`expires_at`),
  KEY `idx_user_context` (`user_id`,`context_type`,`context_id`),
  CONSTRAINT `mfa_challenges_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS `mfa_totp_rate_limits` (
  `attempt_count` int(10) unsigned NOT NULL DEFAULT 0,
  `first_attempt_at` datetime NOT NULL,
  `user_id` binary(16) NOT NULL,
  PRIMARY KEY (`user_id`),
  CONSTRAINT `mfa_totp_rate_limits_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS `pending_deletes` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `mode` enum('key','prefix') NOT NULL,
  `target` varchar(512) NOT NULL,
  `hashed_video_id` varchar(64) DEFAULT NULL,
  `execute_at` datetime NOT NULL,
  `attempts` int(10) unsigned NOT NULL DEFAULT 0,
  `last_attempt_at` datetime DEFAULT NULL,
  `last_error` text DEFAULT NULL,
  `source` varchar(32) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_pending_deletes_execute_at` (`execute_at`),
  KEY `idx_pending_deletes_hashed_video_id` (`hashed_video_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS `processing_queue` (
  `task_id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `video_id` int(10) unsigned NOT NULL,
  `status` enum('queued','pending','leased','processing','completed','error','aborted') NOT NULL DEFAULT 'queued',
  `job_id` varchar(64) DEFAULT NULL,
  `worker_key_id` varchar(64) DEFAULT NULL,
  `leased_at` datetime DEFAULT NULL,
  `last_heartbeat` datetime DEFAULT NULL,
  `pending_until` datetime DEFAULT NULL,
  `cleared` tinyint(1) NOT NULL DEFAULT 0,
  `error_at` datetime DEFAULT NULL,
  `progress` tinyint(3) unsigned DEFAULT 0,
  `error_message` text DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`task_id`),
  UNIQUE KEY `video_id` (`video_id`),
  CONSTRAINT `processing_queue_ibfk_1` FOREIGN KEY (`video_id`) REFERENCES `videos` (`video_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS `role_permissions` (
  `role_id` int(10) unsigned NOT NULL,
  `permission_key` varchar(50) NOT NULL,
  `granted` tinyint(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (`role_id`,`permission_key`),
  CONSTRAINT `role_permissions_ibfk_1` FOREIGN KEY (`role_id`) REFERENCES `roles` (`role_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS `roles` (
  `role_id` int(10) unsigned NOT NULL,
  `role_name` varchar(50) NOT NULL,
  `permission_level` int(10) unsigned NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `is_system` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`role_id`),
  UNIQUE KEY `role_name` (`role_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS `schema_migrations` (
  `migration_id` varchar(100) NOT NULL,
  `applied_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`migration_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS `sessions` (
  `session_id` varchar(128) NOT NULL,
  `last_seen` datetime NOT NULL,
  `last_sign_in` datetime NOT NULL,
  `user_agent` varchar(255) DEFAULT NULL,
  `ip_address` varchar(45) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `user_id` binary(16) NOT NULL,
  `sso_sid` varchar(64) DEFAULT NULL,
  `sso_expires_at` datetime DEFAULT NULL,
  `stepup_at` datetime DEFAULT NULL,
  `stepup_method` varchar(16) DEFAULT NULL,
  PRIMARY KEY (`session_id`),
  KEY `user_id` (`user_id`),
  KEY `idx_sso_sid` (`sso_sid`),
  CONSTRAINT `sessions_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS `site_settings` (
  `setting_key` varchar(50) NOT NULL,
  `setting_value` text NOT NULL,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`setting_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS `sso_event_outbox` (
  `id` char(36) NOT NULL,
  `kind` varchar(64) NOT NULL,
  `payload` longtext NOT NULL,
  `status` enum('delivered','dead') NOT NULL,
  `attempts` int(11) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `delivered_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `transcoding_profiles` (
  `profile_id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `course_id` int(10) unsigned DEFAULT NULL,
  `is_system_profile` tinyint(1) NOT NULL DEFAULT 0,
  `is_enhanced_profile` tinyint(1) DEFAULT NULL,
  `name` varchar(100) NOT NULL,
  `width` int(10) unsigned NOT NULL,
  `height` int(10) unsigned NOT NULL,
  `video_bitrate_kbps` int(10) unsigned NOT NULL,
  `fps_limit` int(10) unsigned NOT NULL DEFAULT 60,
  `codec` varchar(20) NOT NULL DEFAULT 'h264',
  `profile` varchar(20) NOT NULL DEFAULT 'high',
  `preset` varchar(20) NOT NULL DEFAULT 'medium',
  `segment_duration` int(10) unsigned NOT NULL DEFAULT 6,
  `gop_seconds` decimal(4,2) unsigned NOT NULL DEFAULT 2.00,
  `sort_order` tinyint(3) unsigned NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`profile_id`),
  KEY `idx_course` (`course_id`),
  CONSTRAINT `transcoding_profiles_ibfk_1` FOREIGN KEY (`course_id`) REFERENCES `courses` (`course_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS `upload_sessions` (
  `upload_id` varchar(12) NOT NULL,
  `video_id` int(10) unsigned DEFAULT NULL,
  `course_id` int(10) unsigned NOT NULL,
  `title` varchar(255) DEFAULT NULL,
  `module_number` varchar(20) DEFAULT NULL,
  `lecture_date` date DEFAULT NULL,
  `description` text DEFAULT NULL,
  `r2_upload_id` varchar(1024) DEFAULT NULL,
  `object_key` varchar(500) NOT NULL,
  `content_type` varchar(100) DEFAULT NULL,
  `original_filename` varchar(255) NOT NULL,
  `file_size_bytes` bigint(20) unsigned NOT NULL,
  `total_parts` int(10) unsigned DEFAULT NULL,
  `status` enum('active','completing','completed','aborted') NOT NULL DEFAULT 'active',
  `last_heartbeat` datetime NOT NULL DEFAULT current_timestamp(),
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `completed_at` datetime DEFAULT NULL,
  `type` enum('video','attachment') NOT NULL DEFAULT 'video',
  `created_by` binary(16) NOT NULL,
  PRIMARY KEY (`upload_id`),
  KEY `idx_video_active` (`video_id`,`status`),
  KEY `idx_heartbeat` (`status`,`last_heartbeat`),
  KEY `course_id` (`course_id`),
  KEY `created_by` (`created_by`),
  CONSTRAINT `upload_sessions_ibfk_2` FOREIGN KEY (`created_by`) REFERENCES `users` (`user_id`) ON DELETE CASCADE,
  CONSTRAINT `upload_sessions_ibfk_3` FOREIGN KEY (`course_id`) REFERENCES `courses` (`course_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS `user_mfa_methods` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `method_type` enum('email','authenticator','passkey') NOT NULL,
  `label` varchar(100) DEFAULT NULL,
  `totp_secret_encrypted` varchar(512) DEFAULT NULL,
  `credential_id` varchar(512) DEFAULT NULL,
  `public_key` text DEFAULT NULL,
  `sign_count` int(10) unsigned DEFAULT 0,
  `transports` text DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `last_used_at` datetime DEFAULT NULL,
  `user_id` binary(16) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_credential` (`credential_id`),
  KEY `idx_user_method` (`user_id`,`method_type`),
  CONSTRAINT `user_mfa_methods_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS `user_permission_overrides` (
  `permission_key` varchar(50) NOT NULL,
  `override_value` tinyint(4) NOT NULL,
  `user_id` binary(16) NOT NULL,
  PRIMARY KEY (`user_id`,`permission_key`),
  CONSTRAINT `user_permission_overrides_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS `users` (
  `user_id` binary(16) NOT NULL,
  `username` varchar(50) NOT NULL,
  `display_name` varchar(100) NOT NULL,
  `sso_avatar` varchar(80) DEFAULT NULL,
  `email` varchar(255) DEFAULT NULL,
  `mfa_enabled` tinyint(1) NOT NULL DEFAULT 0,
  `role_id` int(10) unsigned NOT NULL DEFAULT 2,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`user_id`),
  UNIQUE KEY `username` (`username`),
  UNIQUE KEY `uq_users_email` (`email`),
  KEY `role_id` (`role_id`),
  CONSTRAINT `users_ibfk_1` FOREIGN KEY (`role_id`) REFERENCES `roles` (`role_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS `videos` (
  `video_id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `course_id` int(10) unsigned NOT NULL,
  `title` varchar(255) NOT NULL,
  `description` text DEFAULT NULL,
  `module_number` varchar(50) DEFAULT NULL,
  `lecture_date` date DEFAULT NULL,
  `hashed_video_id` varchar(64) NOT NULL,
  `duration_seconds` int(10) unsigned DEFAULT NULL,
  `original_filename` varchar(255) DEFAULT NULL,
  `file_size_bytes` bigint(20) unsigned DEFAULT NULL,
  `status` enum('queued','worker_downloading','processing','worker_uploading','finished','error') NOT NULL DEFAULT 'queued',
  `processing_job_id` varchar(64) DEFAULT NULL,
  `processing_progress` tinyint(3) unsigned DEFAULT 0,
  `processing_error` text DEFAULT NULL,
  `r2_source_key` varchar(500) DEFAULT NULL,
  `encryption_key` varbinary(16) DEFAULT NULL,
  `video_type` enum('ts','cmaf') NOT NULL DEFAULT 'ts',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `has_poster` tinyint(1) NOT NULL DEFAULT 0,
  `uploaded_by` binary(16) DEFAULT NULL,
  PRIMARY KEY (`video_id`),
  UNIQUE KEY `hashed_video_id` (`hashed_video_id`),
  KEY `course_id` (`course_id`),
  KEY `uploaded_by` (`uploaded_by`),
  CONSTRAINT `videos_ibfk_2` FOREIGN KEY (`uploaded_by`) REFERENCES `users` (`user_id`) ON DELETE SET NULL,
  CONSTRAINT `videos_ibfk_3` FOREIGN KEY (`course_id`) REFERENCES `courses` (`course_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS `watch_progress` (
  `video_id` int(10) unsigned NOT NULL,
  `watch_seconds` decimal(10,2) NOT NULL DEFAULT 0.00,
  `last_position` float NOT NULL DEFAULT 0,
  `last_watch_at` datetime NOT NULL DEFAULT current_timestamp(),
  `user_id` binary(16) NOT NULL,
  PRIMARY KEY (`user_id`,`video_id`),
  KEY `video_id` (`video_id`),
  CONSTRAINT `watch_progress_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE,
  CONSTRAINT `watch_progress_ibfk_2` FOREIGN KEY (`video_id`) REFERENCES `videos` (`video_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS `worker_access_keys` (
  `key_id` varchar(64) NOT NULL,
  `key_secret` varchar(255) NOT NULL,
  `label` varchar(100) DEFAULT NULL,
  `status` varchar(16) NOT NULL DEFAULT 'active',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `last_used_at` datetime DEFAULT NULL,
  `created_by` binary(16) DEFAULT NULL,
  PRIMARY KEY (`key_id`),
  KEY `created_by` (`created_by`),
  CONSTRAINT `worker_access_keys_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`user_id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS `worker_sessions` (
  `session_id` varchar(32) NOT NULL,
  `worker_key_id` varchar(64) NOT NULL,
  `bearer_token` varchar(128) NOT NULL,
  `ip_address` varchar(64) NOT NULL,
  `last_seen` datetime NOT NULL DEFAULT current_timestamp(),
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`session_id`),
  UNIQUE KEY `bearer_token` (`bearer_token`),
  KEY `idx_worker_sessions_key` (`worker_key_id`),
  KEY `idx_worker_sessions_last_seen` (`last_seen`),
  CONSTRAINT `worker_sessions_ibfk_1` FOREIGN KEY (`worker_key_id`) REFERENCES `worker_access_keys` (`key_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

SET FOREIGN_KEY_CHECKS = 1;
