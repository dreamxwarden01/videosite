-- KMSI: cap each app session at the SSO session's absolute expiry (id_token
-- sess_exp). NULL = no cap known (pre-KMSI sessions).
ALTER TABLE sessions ADD COLUMN sso_expires_at DATETIME NULL;
