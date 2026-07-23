-- Durable cross-platform activity log for Social Accounts → Log tab
-- Sources: organic comments, follows, brain soft-skips / profile / session ops

CREATE TABLE IF NOT EXISTS activity_events (
  id BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  platform VARCHAR(32) NOT NULL,
  action VARCHAR(64) NOT NULL,
  account_id INTEGER REFERENCES social_accounts(id) ON DELETE SET NULL,
  username VARCHAR(255),
  result VARCHAR(32) NOT NULL DEFAULT 'success',
  link TEXT,
  detail TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  source VARCHAR(64),
  source_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_events_source_unique
  ON activity_events (source, source_id)
  WHERE source IS NOT NULL AND source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_activity_events_occurred
  ON activity_events (occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_events_platform_occurred
  ON activity_events (platform, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_events_action_occurred
  ON activity_events (action, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_events_account_occurred
  ON activity_events (account_id, occurred_at DESC);
