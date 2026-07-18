-- Instagram + TikTok warming (browse / follow / like) — mirrors x_follow_* shape

CREATE TABLE IF NOT EXISTS social_warm_settings (
  platform VARCHAR(50) PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  min_per_day INTEGER NOT NULL DEFAULT 2,
  max_per_day INTEGER NOT NULL DEFAULT 4,
  quiet_hours_start INTEGER DEFAULT 1,
  quiet_hours_end INTEGER DEFAULT 8,
  max_concurrent INTEGER NOT NULL DEFAULT 1,
  do_follow BOOLEAN NOT NULL DEFAULT true,
  do_like BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO social_warm_settings (platform, enabled) VALUES
  ('instagram', false),
  ('tiktok', false)
ON CONFLICT (platform) DO NOTHING;

CREATE TABLE IF NOT EXISTS social_warm_targets (
  id SERIAL PRIMARY KEY,
  platform VARCHAR(50) NOT NULL,
  handle VARCHAR(100) NOT NULL,
  category VARCHAR(50) NOT NULL DEFAULT 'sports',
  enabled BOOLEAN NOT NULL DEFAULT true,
  priority INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (platform, handle)
);

CREATE INDEX IF NOT EXISTS idx_social_warm_targets_enabled
  ON social_warm_targets (platform, enabled)
  WHERE enabled = true;

CREATE TABLE IF NOT EXISTS social_warm_jobs (
  id SERIAL PRIMARY KEY,
  social_account_id INTEGER NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  next_due_at TIMESTAMP,
  actions_today INTEGER NOT NULL DEFAULT 0,
  day_key DATE,
  daily_target INTEGER,
  status VARCHAR(50) NOT NULL DEFAULT 'idle',
  last_error TEXT,
  cooldown_until TIMESTAMP,
  failure_class VARCHAR(50),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (social_account_id)
);

CREATE INDEX IF NOT EXISTS idx_social_warm_jobs_due
  ON social_warm_jobs (next_due_at)
  WHERE enabled = true;

CREATE TABLE IF NOT EXISTS social_warm_actions (
  id SERIAL PRIMARY KEY,
  social_account_id INTEGER NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL,
  proxy_id INTEGER REFERENCES proxies(id) ON DELETE SET NULL,
  handle VARCHAR(100),
  category VARCHAR(50),
  action_type VARCHAR(50) NOT NULL DEFAULT 'warm',
  status VARCHAR(50) NOT NULL DEFAULT 'ok',
  detail JSONB DEFAULT '{}',
  error TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_social_warm_actions_account
  ON social_warm_actions (social_account_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_social_warm_actions_follow_once
  ON social_warm_actions (social_account_id, lower(handle))
  WHERE action_type = 'follow' AND status IN ('followed', 'already') AND handle IS NOT NULL;

INSERT INTO social_warm_targets (platform, handle, category, priority) VALUES
  ('instagram', 'nba', 'sports', 10),
  ('instagram', 'nfl', 'sports', 10),
  ('instagram', 'mlb', 'sports', 20),
  ('instagram', 'nhl', 'sports', 25),
  ('instagram', 'ufc', 'sports', 20),
  ('instagram', 'espn', 'sports', 10),
  ('instagram', 'sportscenter', 'sports', 15),
  ('instagram', 'bleacherreport', 'sports', 15),
  ('instagram', 'foxsports', 'sports', 25),
  ('instagram', 'overtime', 'sports', 25),
  ('instagram', 'barstoolsports', 'sports', 20),
  ('instagram', 'draftkings', 'dfs', 10),
  ('instagram', 'fanduel', 'dfs', 10),
  ('instagram', 'prizepicks', 'dfs', 15),
  ('instagram', 'underdogfantasy', 'dfs', 20),
  ('instagram', 'fantasypros', 'dfs', 25),
  ('instagram', 'rotowire', 'dfs', 30),
  ('instagram', 'stephencurry30', 'celeb', 20),
  ('instagram', 'kingjames', 'celeb', 20),
  ('instagram', 'cristiano', 'celeb', 15),
  ('instagram', 'traviskelce', 'celeb', 25),
  ('instagram', 'patrickmahomes', 'celeb', 25),
  ('instagram', 'complexsports', 'celeb', 30),
  ('instagram', 'slam', 'celeb', 30),
  ('instagram', 'ballislife', 'celeb', 30),
  ('tiktok', 'nba', 'sports', 10),
  ('tiktok', 'nfl', 'sports', 10),
  ('tiktok', 'espn', 'sports', 10),
  ('tiktok', 'sportscenter', 'sports', 15),
  ('tiktok', 'bleacherreport', 'sports', 15),
  ('tiktok', 'overtime', 'sports', 20),
  ('tiktok', 'barstoolsports', 'sports', 20),
  ('tiktok', 'draftkings', 'dfs', 10),
  ('tiktok', 'fanduel', 'dfs', 10),
  ('tiktok', 'prizepicks', 'dfs', 15),
  ('tiktok', 'underdogfantasy', 'dfs', 20),
  ('tiktok', 'stephencurry30', 'celeb', 25),
  ('tiktok', 'kingjames', 'celeb', 25),
  ('tiktok', 'cristiano', 'celeb', 15),
  ('tiktok', 'complex', 'celeb', 30),
  ('tiktok', 'ballislife', 'celeb', 30),
  ('tiktok', 'houseofhighlights', 'sports', 20),
  ('tiktok', 'slamonline', 'celeb', 30)
ON CONFLICT (platform, handle) DO NOTHING;
