-- X (Twitter) following campaign — mirrors organic commenting cadence

CREATE TABLE IF NOT EXISTS x_follow_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT false,
  min_per_day INTEGER NOT NULL DEFAULT 2,
  max_per_day INTEGER NOT NULL DEFAULT 5,
  quiet_hours_start INTEGER DEFAULT 1,
  quiet_hours_end INTEGER DEFAULT 8,
  max_concurrent INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO x_follow_settings (id, enabled)
VALUES (1, false)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS x_follow_targets (
  id SERIAL PRIMARY KEY,
  handle VARCHAR(100) NOT NULL,
  category VARCHAR(50) NOT NULL DEFAULT 'sports',
  enabled BOOLEAN NOT NULL DEFAULT true,
  priority INTEGER NOT NULL DEFAULT 100,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (handle)
);

CREATE INDEX IF NOT EXISTS idx_x_follow_targets_enabled
  ON x_follow_targets (enabled, category)
  WHERE enabled = true;

CREATE TABLE IF NOT EXISTS x_follow_jobs (
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
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (social_account_id)
);

CREATE INDEX IF NOT EXISTS idx_x_follow_jobs_due
  ON x_follow_jobs (next_due_at)
  WHERE enabled = true;

CREATE TABLE IF NOT EXISTS x_follows (
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

CREATE INDEX IF NOT EXISTS idx_x_follows_account_created
  ON x_follows (social_account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_x_follows_handle
  ON x_follows (handle);

-- Seed sports / DFS / celeb handles (idempotent)
INSERT INTO x_follow_targets (handle, category, priority) VALUES
  -- leagues / media
  ('NBA', 'sports', 10),
  ('NFL', 'sports', 10),
  ('MLB', 'sports', 20),
  ('NHL', 'sports', 20),
  ('UFC', 'sports', 20),
  ('ESPN', 'sports', 10),
  ('SportsCenter', 'sports', 10),
  ('BleacherReport', 'sports', 15),
  ('FOXSports', 'sports', 25),
  ('CBSSports', 'sports', 25),
  ('NBATV', 'sports', 30),
  ('NFLNetwork', 'sports', 20),
  ('TheAthletic', 'sports', 25),
  ('YahooSports', 'sports', 30),
  ('Overtime', 'sports', 30),
  ('BarstoolSports', 'sports', 20),
  ('PatMcAfeeShow', 'sports', 20),
  ('FirstTake', 'sports', 30),
  ('PardonMyTake', 'sports', 25),
  ('RichEisenShow', 'sports', 35),
  ('TheRinger', 'sports', 35),
  ('MinaKimes', 'sports', 25),
  ('AdamSchefter', 'sports', 15),
  ('RapoportNFL', 'sports', 15),
  ('ShamsCharania', 'sports', 15),
  ('wojespn', 'sports', 15),
  ('ZachLowe_NBA', 'sports', 30),
  ('WindhorstESPN', 'sports', 30),
  ('JeffPassan', 'sports', 35),
  ('FieldYates', 'sports', 25),
  ('MatthewBerryTMR', 'sports', 25),
  -- DFS / fantasy
  ('DraftKings', 'dfs', 10),
  ('FanDuel', 'dfs', 10),
  ('PrizePicks', 'dfs', 15),
  ('UnderdogFantasy', 'dfs', 15),
  ('RotoGrinders', 'dfs', 15),
  ('EstablishTheRun', 'dfs', 15),
  ('FantasyPros', 'dfs', 20),
  ('SleeperHQ', 'dfs', 20),
  ('DFSArmy', 'dfs', 20),
  ('StokasticDFS', 'dfs', 25),
  ('BalesFootball', 'dfs', 25),
  ('NumberFire', 'dfs', 30),
  ('RotoWire', 'dfs', 30),
  ('FantasyLabs', 'dfs', 30),
  ('Sabersim', 'dfs', 35),
  ('Awesemo_com', 'dfs', 35),
  ('ESPNFantasy', 'dfs', 20),
  ('JJZachariason', 'dfs', 30),
  ('ChrisRaybon', 'dfs', 30),
  ('AdamLevitan', 'dfs', 30),
  ('BigCat', 'dfs', 25),
  -- athletes / celebs (sports-adjacent)
  ('StephenCurry30', 'celeb', 20),
  ('KDTrey5', 'celeb', 25),
  ('KingJames', 'celeb', 20),
  ('JHarden13', 'celeb', 30),
  ('luka7doncic', 'celeb', 25),
  ('JoelEmbiid', 'celeb', 30),
  ('JaMorant', 'celeb', 30),
  ('TraeYoung', 'celeb', 30),
  ('Giannis_An34', 'celeb', 25),
  ('PatMahomes', 'celeb', 20),
  ('JoshAllenQB', 'celeb', 25),
  ('JoeBurrow', 'celeb', 25),
  ('JustinJefferson', 'celeb', 25),
  ('TyreekHill', 'celeb', 30),
  ('DavanteAdams', 'celeb', 30),
  ('tkelce', 'celeb', 20),
  ('Cristiano', 'celeb', 20),
  ('SerenaWilliams', 'celeb', 30),
  ('SLAMMagazine', 'celeb', 35),
  ('ComplexSports', 'celeb', 35),
  ('Ballislife', 'celeb', 35),
  ('MrBeast', 'celeb', 40),
  ('iShowSpeed', 'celeb', 40),
  ('KaiCenat', 'celeb', 40)
ON CONFLICT (handle) DO NOTHING;
