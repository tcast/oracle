-- Anti-detection hardening: cooldowns, failure class, sticky device profiles

ALTER TABLE organic_comment_jobs
  ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMP,
  ADD COLUMN IF NOT EXISTS failure_class VARCHAR(50),
  ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_organic_jobs_cooldown
  ON organic_comment_jobs (cooldown_until)
  WHERE cooldown_until IS NOT NULL;

ALTER TABLE proxies
  ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMP,
  ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_proxies_cooldown
  ON proxies (cooldown_until)
  WHERE cooldown_until IS NOT NULL AND is_active = true;

ALTER TABLE social_accounts
  ADD COLUMN IF NOT EXISTS device_profile JSONB;

COMMENT ON COLUMN social_accounts.device_profile IS
  'Sticky Playwright fingerprint (UA, viewport, mobile/desktop) — stable per account';
