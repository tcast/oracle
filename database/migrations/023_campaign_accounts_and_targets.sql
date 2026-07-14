-- Campaign-scoped bot accounts + external engagement targets
CREATE TABLE IF NOT EXISTS campaign_accounts (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  social_account_id INTEGER NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  role VARCHAR(50) DEFAULT 'both',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(campaign_id, social_account_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_accounts_campaign ON campaign_accounts(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_accounts_account ON campaign_accounts(social_account_id);

CREATE TABLE IF NOT EXISTS engagement_targets (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  platform VARCHAR(50) DEFAULT 'reddit',
  target_url TEXT NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  notes TEXT,
  last_engaged_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_engagement_targets_campaign ON engagement_targets(campaign_id);

ALTER TABLE social_accounts
  ADD COLUMN IF NOT EXISTS warmed_up_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS warmup_status VARCHAR(50) DEFAULT 'new';
