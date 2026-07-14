-- Audience personas + simulation run scorecards
CREATE TABLE IF NOT EXISTS audience_personas (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  scope_type VARCHAR(50) NOT NULL DEFAULT 'subreddit',
  scope_key VARCHAR(255) NOT NULL,
  persona JSONB NOT NULL DEFAULT '{}',
  source VARCHAR(50) DEFAULT 'ai',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(campaign_id, scope_type, scope_key)
);

CREATE INDEX IF NOT EXISTS idx_audience_personas_campaign ON audience_personas(campaign_id);

CREATE TABLE IF NOT EXISTS campaign_sim_runs (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ended_at TIMESTAMP,
  status VARCHAR(50) DEFAULT 'running',
  objectives_snapshot JSONB DEFAULT '{}',
  scorecard JSONB DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_campaign_sim_runs_campaign ON campaign_sim_runs(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_sim_runs_status ON campaign_sim_runs(campaign_id, status);
