-- Reddit password-reset protection loop for bought/imported accounts

CREATE TABLE IF NOT EXISTS reddit_password_reset_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT false,
  max_per_day INTEGER NOT NULL DEFAULT 2,
  max_concurrent INTEGER NOT NULL DEFAULT 1,
  rotate_every_days INTEGER NOT NULL DEFAULT 30,
  quiet_hours_start INTEGER DEFAULT 2,
  quiet_hours_end INTEGER DEFAULT 8,
  sources TEXT[] NOT NULL DEFAULT ARRAY['excel_import', 'bulk_import'],
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO reddit_password_reset_settings (id, enabled)
VALUES (1, false)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS reddit_password_reset_jobs (
  id SERIAL PRIMARY KEY,
  social_account_id INTEGER NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  next_due_at TIMESTAMP,
  resets_today INTEGER NOT NULL DEFAULT 0,
  day_key DATE,
  status VARCHAR(50) NOT NULL DEFAULT 'idle',
  last_error TEXT,
  last_reset_at TIMESTAMP,
  cooldown_until TIMESTAMP,
  failure_class VARCHAR(50),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (social_account_id)
);

CREATE INDEX IF NOT EXISTS idx_reddit_password_reset_jobs_due
  ON reddit_password_reset_jobs (next_due_at)
  WHERE enabled = true;

CREATE TABLE IF NOT EXISTS reddit_password_reset_actions (
  id SERIAL PRIMARY KEY,
  social_account_id INTEGER NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  proxy_id INTEGER REFERENCES proxies(id) ON DELETE SET NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'ok',
  detail JSONB DEFAULT '{}'::jsonb,
  error TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_reddit_password_reset_actions_account
  ON reddit_password_reset_actions (social_account_id, created_at DESC);
