-- Reddit following campaign — mirrors x_follow_* shape (outbound only; no request inbox)

CREATE TABLE IF NOT EXISTS reddit_follow_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT false,
  min_per_day INTEGER NOT NULL DEFAULT 2,
  max_per_day INTEGER NOT NULL DEFAULT 5,
  quiet_hours_start INTEGER DEFAULT 1,
  quiet_hours_end INTEGER DEFAULT 8,
  max_concurrent INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO reddit_follow_settings (id, enabled)
VALUES (1, false)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS reddit_follow_targets (
  id SERIAL PRIMARY KEY,
  handle VARCHAR(100) NOT NULL,
  category VARCHAR(50) NOT NULL DEFAULT 'sports',
  enabled BOOLEAN NOT NULL DEFAULT true,
  priority INTEGER NOT NULL DEFAULT 100,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (handle)
);

CREATE INDEX IF NOT EXISTS idx_reddit_follow_targets_enabled
  ON reddit_follow_targets (enabled, category)
  WHERE enabled = true;

CREATE TABLE IF NOT EXISTS reddit_follow_jobs (
  id SERIAL PRIMARY KEY,
  social_account_id INTEGER NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  next_due_at TIMESTAMP,
  follows_today INTEGER NOT NULL DEFAULT 0,
  day_key DATE,
  daily_target INTEGER,
  status VARCHAR(50) NOT NULL DEFAULT 'idle',
  last_error TEXT,
  cooldown_until TIMESTAMP,
  failure_class VARCHAR(50),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_discover_at TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (social_account_id)
);

CREATE INDEX IF NOT EXISTS idx_reddit_follow_jobs_due
  ON reddit_follow_jobs (next_due_at)
  WHERE enabled = true;

CREATE TABLE IF NOT EXISTS reddit_follows (
  id SERIAL PRIMARY KEY,
  social_account_id INTEGER NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  proxy_id INTEGER REFERENCES proxies(id) ON DELETE SET NULL,
  handle VARCHAR(100) NOT NULL,
  category VARCHAR(50),
  status VARCHAR(50) NOT NULL DEFAULT 'followed',
  profile_url TEXT,
  error TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (social_account_id, handle)
);

CREATE INDEX IF NOT EXISTS idx_reddit_follows_account_created
  ON reddit_follows (social_account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reddit_follows_handle
  ON reddit_follows (handle);

-- Seed sports / DFS / tech Reddit usernames (idempotent). Handles are case-insensitive on Reddit.
INSERT INTO reddit_follow_targets (handle, category, priority) VALUES
  ('NBA', 'sports', 20),
  ('nfl', 'sports', 20),
  ('MLB', 'sports', 30),
  ('NHL', 'sports', 30),
  ('ufc', 'sports', 30),
  ('espn', 'sports', 25),
  ('BleacherReport', 'sports', 30),
  ('DraftKings', 'dfs', 15),
  ('FanDuel', 'dfs', 15),
  ('PrizePicks', 'dfs', 20),
  ('EstablishTheRun', 'dfs', 25),
  ('rotogrinders', 'dfs', 25),
  ('fantasyfootball', 'dfs', 20),
  ('OpenAI', 'tech', 30),
  ('anthropic', 'tech', 35),
  ('github', 'tech', 35),
  ('verge', 'tech', 40),
  ('spez', 'tech', 40)
ON CONFLICT (handle) DO NOTHING;
