-- Sim learnings + run history columns
ALTER TABLE campaign_sim_runs
  ADD COLUMN IF NOT EXISTS findings JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS overall_score NUMERIC,
  ADD COLUMN IF NOT EXISTS grade VARCHAR(2),
  ADD COLUMN IF NOT EXISTS drafts_rewritten_at TIMESTAMP;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS active_learnings JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS active_learnings_run_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_campaign_sim_runs_campaign_started
  ON campaign_sim_runs(campaign_id, started_at DESC);
