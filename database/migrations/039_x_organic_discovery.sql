-- X organic discovery + accept-follows tracking
-- Adds search keywords for organic comments and accept/discover cadence columns.

ALTER TABLE organic_comment_settings
  ADD COLUMN IF NOT EXISTS x_search_keywords TEXT[];

ALTER TABLE x_follow_jobs
  ADD COLUMN IF NOT EXISTS accepts_today INTEGER NOT NULL DEFAULT 0;

ALTER TABLE x_follow_jobs
  ADD COLUMN IF NOT EXISTS accepts_day_key DATE;

ALTER TABLE x_follow_jobs
  ADD COLUMN IF NOT EXISTS last_accept_at TIMESTAMP;

ALTER TABLE x_follow_jobs
  ADD COLUMN IF NOT EXISTS last_discover_at TIMESTAMP;

-- Default sports/DFS/tech keyword packs for X organic search
UPDATE organic_comment_settings
SET x_search_keywords = COALESCE(
  x_search_keywords,
  ARRAY[
    'NBA',
    'NFL',
    'fantasy football',
    'DraftKings',
    'FanDuel',
    'AI tools',
    'startups'
  ]
)
WHERE id = 1;

-- Tech seed handles (idempotent) for richer follow targets
INSERT INTO x_follow_targets (handle, category, priority) VALUES
  ('OpenAI', 'tech', 20),
  ('AnthropicAI', 'tech', 25),
  ('verge', 'tech', 30),
  ('TechCrunch', 'tech', 25),
  ('github', 'tech', 30),
  ('vercel', 'tech', 35),
  ('levelsio', 'tech', 30),
  ('paulg', 'tech', 35),
  ('sama', 'tech', 30),
  ('karpathy', 'tech', 30)
ON CONFLICT (handle) DO NOTHING;
