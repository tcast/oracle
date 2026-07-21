-- Separate in-session password rotate schedule (not forgot-password email).
-- Default OFF — enable only after pilots prove rotate+verify.

ALTER TABLE reddit_password_reset_settings
  ADD COLUMN IF NOT EXISTS in_session_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS in_session_max_per_day INTEGER NOT NULL DEFAULT 3;

COMMENT ON COLUMN reddit_password_reset_settings.in_session_enabled IS
  'When true, durable queue runs logged-in /api/update_password rotates. Independent of enabled (forgot-password).';
COMMENT ON COLUMN reddit_password_reset_settings.in_session_max_per_day IS
  'Global cap for in-session rotates per calendar day across all accounts.';
