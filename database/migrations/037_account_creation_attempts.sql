-- Account creation attempt telemetry for NOC (created vs attempted)

CREATE TABLE IF NOT EXISTS account_creation_attempts (
  id SERIAL PRIMARY KEY,
  platform VARCHAR(50) NOT NULL,
  status VARCHAR(50) NOT NULL,
  -- created | attempt_failed | skipped | blocked
  error_class VARCHAR(50),
  error_message TEXT,
  proxy_id INTEGER REFERENCES proxies(id) ON DELETE SET NULL,
  email_account_id INTEGER REFERENCES email_accounts(id) ON DELETE SET NULL,
  social_account_id INTEGER REFERENCES social_accounts(id) ON DELETE SET NULL,
  username VARCHAR(255),
  email VARCHAR(255),
  source VARCHAR(80) DEFAULT 'api',
  detail JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_account_creation_attempts_created
  ON account_creation_attempts (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_account_creation_attempts_platform_day
  ON account_creation_attempts (platform, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_account_creation_attempts_status
  ON account_creation_attempts (status, created_at DESC);
