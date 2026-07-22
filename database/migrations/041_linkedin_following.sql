-- LinkedIn following / connect campaign — mirrors x_follow_* cadence

CREATE TABLE IF NOT EXISTS linkedin_follow_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT false,
  min_per_day INTEGER NOT NULL DEFAULT 2,
  max_per_day INTEGER NOT NULL DEFAULT 5,
  quiet_hours_start INTEGER DEFAULT 1,
  quiet_hours_end INTEGER DEFAULT 8,
  max_concurrent INTEGER NOT NULL DEFAULT 2,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO linkedin_follow_settings (id, enabled)
VALUES (1, false)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS linkedin_follow_targets (
  id SERIAL PRIMARY KEY,
  handle VARCHAR(150) NOT NULL,
  category VARCHAR(50) NOT NULL DEFAULT 'hr_talent',
  target_type VARCHAR(20) NOT NULL DEFAULT 'person',
  enabled BOOLEAN NOT NULL DEFAULT true,
  priority INTEGER NOT NULL DEFAULT 100,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (handle)
);

CREATE INDEX IF NOT EXISTS idx_linkedin_follow_targets_enabled
  ON linkedin_follow_targets (enabled, category)
  WHERE enabled = true;

CREATE TABLE IF NOT EXISTS linkedin_follow_jobs (
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
  accepts_today INTEGER NOT NULL DEFAULT 0,
  accepts_day_key DATE,
  last_accept_at TIMESTAMP,
  last_discover_at TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (social_account_id)
);

CREATE INDEX IF NOT EXISTS idx_linkedin_follow_jobs_due
  ON linkedin_follow_jobs (next_due_at)
  WHERE enabled = true;

CREATE TABLE IF NOT EXISTS linkedin_follows (
  id SERIAL PRIMARY KEY,
  social_account_id INTEGER NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  proxy_id INTEGER REFERENCES proxies(id) ON DELETE SET NULL,
  handle VARCHAR(150) NOT NULL,
  category VARCHAR(50),
  status VARCHAR(50) NOT NULL DEFAULT 'followed',
  profile_url TEXT,
  error TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (social_account_id, handle)
);

CREATE INDEX IF NOT EXISTS idx_linkedin_follows_account_created
  ON linkedin_follows (social_account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_linkedin_follows_handle
  ON linkedin_follows (handle);

-- Seed HR / talent / recruiting people + companies (idempotent)
INSERT INTO linkedin_follow_targets (handle, category, target_type, priority) VALUES
  ('williamhgates', 'thought_leader', 'person', 20),
  ('satyanadella', 'thought_leader', 'person', 25),
  ('jeffweiner08', 'hr_talent', 'person', 15),
  ('reidhoffman', 'hr_talent', 'person', 20),
  ('adamgrant', 'hr_talent', 'person', 20),
  ('laszlo-bock', 'hr_talent', 'person', 20),
  ('joshbersin', 'hr_talent', 'person', 15),
  ('lizryan', 'hr_talent', 'person', 25),
  ('louadler', 'hr_talent', 'person', 25),
  ('shannonpritchard', 'hr_talent', 'person', 30),
  ('hungle', 'hr_talent', 'person', 30),
  ('stacyzapar', 'hr_talent', 'person', 25),
  ('glenngow', 'hr_talent', 'person', 35),
  ('katrina-Collier', 'hr_talent', 'person', 30),
  ('timsackett', 'hr_talent', 'person', 30),
  ('cywakeman', 'hr_talent', 'person', 35),
  ('simon-sineck', 'thought_leader', 'person', 30),
  ('brenebrown', 'thought_leader', 'person', 40),
  ('linkedin', 'company', 'company', 10),
  ('google', 'company', 'company', 15),
  ('microsoft', 'company', 'company', 15),
  ('amazon', 'company', 'company', 20),
  ('meta', 'company', 'company', 20),
  ('salesforce', 'company', 'company', 20),
  ('workday', 'company', 'company', 15),
  ('greenhouse-software', 'company', 'company', 15),
  ('lever', 'company', 'company', 20),
  ('ashbyhq', 'company', 'company', 20),
  ('rippling', 'company', 'company', 25),
  ('gusto', 'company', 'company', 25),
  ('indeed', 'company', 'company', 15),
  ('glassdoor', 'company', 'company', 25),
  ('shrm', 'company', 'company', 20),
  ('society-for-human-resource-management', 'company', 'company', 25),
  ('y-combinator', 'company', 'company', 25),
  ('andreessen-horowitz', 'company', 'company', 30)
ON CONFLICT (handle) DO NOTHING;
