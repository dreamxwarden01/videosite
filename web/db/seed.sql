-- Default Roles
INSERT INTO roles (role_id, role_name, permission_level, description, is_system) VALUES
    (0, 'superadmin', 0, 'Full system access', 1),
    (1, 'admin',      1, 'Course and user management', 1),
    (2, 'user',       10, 'Standard user', 1);

-- Superadmin permissions (all)
INSERT INTO role_permissions (role_id, permission_key, granted) VALUES
    (0, 'allowPlayback', 1),
    (0, 'changeOwnPassword', 1),
    (0, 'allCourseAccess', 1),
    (0, 'manageCourse', 1),
    (0, 'addCourse', 1),
    (0, 'changeCourse', 1),
    (0, 'deleteCourse', 1),
    (0, 'manageEnrolment', 1),
    (0, 'uploadVideo', 1),
    (0, 'changeVideo', 1),
    (0, 'deleteVideo', 1),
    (0, 'manageUser', 1),
    (0, 'addUser', 1),
    (0, 'changeUser', 1),
    (0, 'deleteUser', 1),
    (0, 'viewPlaybackStat', 1),
    (0, 'changeUserPermission', 1),
    (0, 'manageSite', 1),
    (0, 'manageRoles', 1),
    (0, 'inviteUser', 1),
    (0, 'requireMFA', 1),
    (0, 'accessAttachments', 1),
    (0, 'uploadAttachments', 1),
    (0, 'deleteAttachments', 1);

-- Admin permissions (no delete, no superadmin-level perms)
INSERT INTO role_permissions (role_id, permission_key, granted) VALUES
    (1, 'allowPlayback', 1),
    (1, 'changeOwnPassword', 1),
    (1, 'allCourseAccess', 1),
    (1, 'manageCourse', 1),
    (1, 'addCourse', 1),
    (1, 'changeCourse', 1),
    (1, 'manageEnrolment', 1),
    (1, 'uploadVideo', 1),
    (1, 'changeVideo', 1),
    (1, 'manageUser', 1),
    (1, 'addUser', 1),
    (1, 'changeUser', 1),
    (1, 'viewPlaybackStat', 1),
    (1, 'inviteUser', 1),
    (1, 'requireMFA', 1),
    (1, 'accessAttachments', 1),
    (1, 'uploadAttachments', 1),
    (1, 'deleteAttachments', 1);

-- User permissions (basic)
INSERT INTO role_permissions (role_id, permission_key, granted) VALUES
    (2, 'allowPlayback', 1),
    (2, 'changeOwnPassword', 1),
    (2, 'accessAttachments', 1);

-- Default site settings
INSERT INTO site_settings (setting_key, setting_value) VALUES
    ('site_name', 'VideoSite'),
    ('session_inactivity_days', '3'),
    ('session_max_days', '15'),
    ('enable_registration', 'false'),
    ('require_invitation_code', 'true'),
    ('emailed_link_validity_minutes', '30'),
    ('registration_default_role', '2'),
    ('hmac_enabled', 'false'),
    ('hmac_token_validity', '600');

-- The migrations schema.sql ALREADY CONTAINS — the baseline it was dumped at.
--
-- DO NOT hand-edit this list, and do not add a new migration to it: append the
-- migration to db/migrations.js only, and a fresh install will run it just like an
-- existing install does. This list moves solely via `npm run db:bless`, which
-- re-snapshots schema.sql and rewrites db/baseline.json in the same step so the two
-- cannot drift. `npm run check:db` enforces it. See lib/dbBaseline.js.
INSERT INTO schema_migrations (migration_id) VALUES
    ('001_fix_worker_key_column_sizes'),
    ('002_worker_pending_abort_transcoding'),
    ('003_add_encryption_key'),
    ('004_drop_abort_requested'),
    ('005_registration_tables'),
    ('006_mfa_system'),
    ('007_mfa_email_verification_type'),
    ('008_webauthn_challenge_column'),
    ('009_mfa_methods_last_used'),
    ('010_mfa_totp_rate_limits'),
    ('011_unique_user_email'),
    ('012_password_reset'),
    ('013_user_role_permission_level_10'),
    ('014_bmfa_tokens'),
    ('015_mfa_reuse_session_to_persistent'),
    ('016_remove_hashed_course_id'),
    ('017_upload_sessions'),
    ('018_widen_r2_upload_id'),
    ('020_remove_r2_turnstile_from_settings'),
    ('021_mfa_onetime_challenge_timeout'),
    ('019_course_id_to_int'),
    ('022_transcoding_profiles'),
    ('023_course_materials'),
    ('024_drop_material_original_filename'),
    ('025_worker_sessions'),
    ('026_watch_seconds_decimal'),
    ('027_cmaf_support'),
    ('028_mfa_otp_encrypt'),
    ('029_rename_session_last_activity_to_last_seen'),
    ('030_cloudflare_turnstile_worker_gate'),
    ('031_pending_deletes'),
    ('032_stateful_attachment_uploads'),
    ('033_enhanced_transcoding_profiles'),
    ('034_toggle_own_mfa'),
    ('035_encrypt_settings_secrets'),
    ('036_rename_hmac_enabled'),
    ('037_rename_hmac_token_validity'),
    ('038_worker_access_keys_status'),
    ('039_videos_has_poster'),
    ('040_copy_posters_to_per_course_layout'),
    ('041_sso_avatar'),
    ('042_sso_identity_cleanup'),
    ('043_course_code_name_rename'),
    ('044_module_number_and_label'),
    ('045_drop_course_mfa_policy'),
    ('046_drop_clear_playback_stat_perm'),
    ('047_drop_manage_site_mfa_perm'),
    ('048_session_stepup'),
    ('049_drop_password_columns');
