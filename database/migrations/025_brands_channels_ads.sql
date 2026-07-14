-- Brands, official channels, ad accounts, campaign track flags

CREATE TABLE IF NOT EXISTS brands (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  logo_url TEXT,
  website TEXT,
  brand_voice TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS brand_members (
  id SERIAL PRIMARY KEY,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(50) NOT NULL DEFAULT 'owner',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(brand_id, user_id)
);

CREATE TABLE IF NOT EXISTS brand_channels (
  id SERIAL PRIMARY KEY,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL,
  channel_type VARCHAR(50) NOT NULL DEFAULT 'page',
  external_id VARCHAR(255),
  display_name VARCHAR(255),
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TIMESTAMP,
  scopes TEXT,
  meta JSONB DEFAULT '{}',
  status VARCHAR(50) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(brand_id, platform, external_id)
);

CREATE TABLE IF NOT EXISTS ad_accounts (
  id SERIAL PRIMARY KEY,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL,
  external_account_id VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  currency VARCHAR(10) DEFAULT 'USD',
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TIMESTAMP,
  meta JSONB DEFAULT '{}',
  status VARCHAR(50) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(brand_id, platform, external_account_id)
);

CREATE TABLE IF NOT EXISTS ad_campaigns (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  ad_account_id INTEGER NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL,
  external_campaign_id VARCHAR(255),
  name VARCHAR(255) NOT NULL,
  objective VARCHAR(100),
  status VARCHAR(50) DEFAULT 'draft',
  budget_daily_cents INTEGER,
  budget_total_cents INTEGER,
  targeting JSONB DEFAULT '{}',
  creative JSONB DEFAULT '{}',
  metrics JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seed brands
INSERT INTO brands (name, slug, website, brand_voice) VALUES
  ('Authio', 'authio', 'https://authio.com', 'Professional B2B auth/security voice. Clear, trustworthy, technical but accessible. Emphasize identity, compliance, and developer experience.'),
  ('JockBroker', 'jockbroker', 'https://jockbroker.com', 'Sports betting / athlete marketplace energy. Bold, competitive, fan-first. Direct CTAs without sounding spammy.'),
  ('InsightHire', 'insighthire', 'https://insighthire.com', 'HR / recruiting SaaS voice. Empathetic toward hiring managers and candidates. Data-backed, practical, outcome-focused.'),
  ('Mentor', 'mentor', 'https://mentor.com', 'Career growth and coaching. Warm, aspirational, supportive. Focus on skill building and opportunity.')
ON CONFLICT (slug) DO NOTHING;

-- Attach all existing users as brand owners
INSERT INTO brand_members (brand_id, user_id, role)
SELECT b.id, u.id, 'owner'
FROM brands b
CROSS JOIN users u
ON CONFLICT (brand_id, user_id) DO NOTHING;

-- Campaign brand + track flags
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS brand_id INTEGER REFERENCES brands(id);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS whisper_enabled BOOLEAN DEFAULT true;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS overt_enabled BOOLEAN DEFAULT false;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS ads_enabled BOOLEAN DEFAULT false;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS overt_platforms TEXT[] DEFAULT '{}';

-- Backfill existing campaigns to JockBroker (or first brand)
UPDATE campaigns
SET brand_id = (SELECT id FROM brands WHERE slug = 'jockbroker' LIMIT 1)
WHERE brand_id IS NULL;

-- Posts: overt channel linkage
ALTER TABLE posts ADD COLUMN IF NOT EXISTS brand_channel_id INTEGER REFERENCES brand_channels(id) ON DELETE SET NULL;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS posting_track VARCHAR(50) DEFAULT 'whisper';

CREATE INDEX IF NOT EXISTS idx_campaigns_brand_id ON campaigns(brand_id);
CREATE INDEX IF NOT EXISTS idx_brand_channels_brand ON brand_channels(brand_id);
CREATE INDEX IF NOT EXISTS idx_ad_accounts_brand ON ad_accounts(brand_id);
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_campaign ON ad_campaigns(campaign_id);
CREATE INDEX IF NOT EXISTS idx_brand_members_user ON brand_members(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_posting_track ON posts(campaign_id, posting_track);
