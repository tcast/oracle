-- Organic daily commenting + strict 1:1 proxy assignments

CREATE TABLE IF NOT EXISTS organic_comment_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT false,
  min_per_day INTEGER NOT NULL DEFAULT 1,
  max_per_day INTEGER NOT NULL DEFAULT 3,
  quiet_hours_start INTEGER DEFAULT 1,
  quiet_hours_end INTEGER DEFAULT 7,
  max_concurrent INTEGER NOT NULL DEFAULT 2,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO organic_comment_settings (id, enabled)
VALUES (1, false)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS organic_comment_jobs (
  id SERIAL PRIMARY KEY,
  social_account_id INTEGER NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  next_due_at TIMESTAMP,
  comments_today INTEGER NOT NULL DEFAULT 0,
  day_key DATE,
  daily_target INTEGER,
  status VARCHAR(50) NOT NULL DEFAULT 'idle',
  last_error TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (social_account_id)
);

CREATE TABLE IF NOT EXISTS organic_comments (
  id SERIAL PRIMARY KEY,
  social_account_id INTEGER NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  proxy_id INTEGER REFERENCES proxies(id) ON DELETE SET NULL,
  subreddit VARCHAR(255) NOT NULL,
  post_url TEXT NOT NULL,
  post_title TEXT,
  content TEXT NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  ai_likeness REAL,
  spam_score REAL,
  platform_comment_id VARCHAR(255),
  error TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_organic_comments_post_url
  ON organic_comments (post_url)
  WHERE status IN ('posted', 'pending', 'simulated');

CREATE INDEX IF NOT EXISTS idx_organic_comments_account_created
  ON organic_comments (social_account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_organic_comment_jobs_due
  ON organic_comment_jobs (next_due_at)
  WHERE enabled = true;

-- One active proxy per account, one active account per proxy
CREATE UNIQUE INDEX IF NOT EXISTS idx_sap_one_active_per_account
  ON social_account_proxies (social_account_id)
  WHERE is_active = true;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sap_one_active_per_proxy
  ON social_account_proxies (proxy_id)
  WHERE is_active = true;
