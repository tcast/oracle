-- Nightly Reddit account stats audit

ALTER TABLE social_accounts
  ADD COLUMN IF NOT EXISTS total_karma INTEGER,
  ADD COLUMN IF NOT EXISTS post_karma INTEGER,
  ADD COLUMN IF NOT EXISTS comment_karma INTEGER,
  ADD COLUMN IF NOT EXISTS post_count INTEGER,
  ADD COLUMN IF NOT EXISTS comment_count INTEGER,
  ADD COLUMN IF NOT EXISTS likes_count INTEGER,
  ADD COLUMN IF NOT EXISTS dislikes_count INTEGER,
  ADD COLUMN IF NOT EXISTS stats_audited_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS stats_audit_error TEXT;

CREATE TABLE IF NOT EXISTS social_account_stats_audits (
  id SERIAL PRIMARY KEY,
  social_account_id INTEGER NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  audited_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  total_karma INTEGER,
  post_karma INTEGER,
  comment_karma INTEGER,
  post_count INTEGER,
  comment_count INTEGER,
  likes_count INTEGER,
  dislikes_count INTEGER,
  status VARCHAR(50) NOT NULL DEFAULT 'ok',
  error TEXT,
  raw JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_account_stats_audits_account_time
  ON social_account_stats_audits (social_account_id, audited_at DESC);

CREATE TABLE IF NOT EXISTS account_stats_audit_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT true,
  run_hour_local INTEGER NOT NULL DEFAULT 3,
  timezone VARCHAR(64) NOT NULL DEFAULT 'America/New_York',
  last_run_date DATE,
  last_run_at TIMESTAMP,
  last_run_summary JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO account_stats_audit_settings (id, enabled, run_hour_local, timezone)
VALUES (1, true, 3, 'America/New_York')
ON CONFLICT (id) DO NOTHING;
