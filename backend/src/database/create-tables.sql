CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  first_name VARCHAR(255),
  last_name VARCHAR(255),
  role VARCHAR(50) DEFAULT 'user',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

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

CREATE TABLE IF NOT EXISTS campaigns (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  target_audience TEXT,
  goals TEXT,
  campaign_goal TEXT,
  campaign_overview TEXT,
  post_goal INTEGER DEFAULT 5,
  comment_goal INTEGER DEFAULT 3,
  target_sentiment NUMERIC DEFAULT 0.5,
  is_live BOOLEAN DEFAULT false,
  platform TEXT[] DEFAULT '{}',
  target_url TEXT,
  media_assets JSONB DEFAULT '[]',
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  brand_id INTEGER REFERENCES brands(id),
  campaign_type VARCHAR(50) DEFAULT 'whisper',
  whisper_enabled BOOLEAN DEFAULT true,
  overt_enabled BOOLEAN DEFAULT false,
  ads_enabled BOOLEAN DEFAULT false,
  overt_platforms TEXT[] DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_running BOOLEAN DEFAULT false,
  simulation_mode BOOLEAN DEFAULT true,
  posts_per_subreddit INTEGER DEFAULT 3,
  status VARCHAR(50) DEFAULT 'draft',
  schedule JSONB DEFAULT '{}',
  active_learnings JSONB DEFAULT NULL,
  active_learnings_run_id INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  refresh_token TEXT,
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS subreddit_suggestions (
  id SERIAL PRIMARY KEY,
  subreddit_name VARCHAR(255) NOT NULL,
  reason TEXT,
  subscriber_count INTEGER,
  content_guidelines JSONB DEFAULT '[]',
  status VARCHAR(50) DEFAULT 'pending',
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS social_accounts (
  id SERIAL PRIMARY KEY,
  platform VARCHAR(50) NOT NULL,
  username VARCHAR(255),
  email VARCHAR(255),
  credentials JSONB DEFAULT '{}',
  persona_traits JSONB DEFAULT '{}',
  status VARCHAR(50) DEFAULT 'active',
  is_simulated BOOLEAN DEFAULT false,
  proxy_config JSONB DEFAULT NULL,
  last_used_at TIMESTAMP,
  warmed_up_at TIMESTAMP,
  warmup_status VARCHAR(50) DEFAULT 'new',
  total_karma INTEGER,
  post_karma INTEGER,
  comment_karma INTEGER,
  post_count INTEGER,
  comment_count INTEGER,
  likes_count INTEGER,
  dislikes_count INTEGER,
  stats_audited_at TIMESTAMP,
  stats_audit_error TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS brand_oauth_apps (
  id SERIAL PRIMARY KEY,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  provider VARCHAR(50) NOT NULL,
  client_id TEXT,
  client_secret TEXT,
  extra JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(brand_id, provider)
);

CREATE TABLE IF NOT EXISTS brand_assets (
  id SERIAL PRIMARY KEY,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  kind VARCHAR(50) NOT NULL DEFAULT 'other',
  label VARCHAR(255),
  url TEXT NOT NULL,
  mime_type VARCHAR(100),
  meta JSONB DEFAULT '{}',
  original_filename VARCHAR(500),
  byte_size BIGINT,
  parse_status VARCHAR(50) NOT NULL DEFAULT 'pending',
  extracted_text TEXT,
  ai_summary TEXT,
  ai_data JSONB DEFAULT '{}',
  parse_error TEXT,
  parsed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE brand_assets
  ADD COLUMN IF NOT EXISTS original_filename VARCHAR(500),
  ADD COLUMN IF NOT EXISTS byte_size BIGINT,
  ADD COLUMN IF NOT EXISTS parse_status VARCHAR(50) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS extracted_text TEXT,
  ADD COLUMN IF NOT EXISTS ai_summary TEXT,
  ADD COLUMN IF NOT EXISTS ai_data JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS parse_error TEXT,
  ADD COLUMN IF NOT EXISTS parsed_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_brand_assets_brand ON brand_assets(brand_id);
CREATE INDEX IF NOT EXISTS idx_brand_assets_kind ON brand_assets(brand_id, kind);

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

CREATE TABLE IF NOT EXISTS ad_creatives (
  id SERIAL PRIMARY KEY,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  format VARCHAR(50) NOT NULL DEFAULT 'social',
  status VARCHAR(50) NOT NULL DEFAULT 'draft',
  brief TEXT,
  content JSONB NOT NULL DEFAULT '{}',
  image_url TEXT,
  generation_meta JSONB NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ad_creatives_brand ON ad_creatives(brand_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ad_creative_assets (
  ad_creative_id INTEGER NOT NULL REFERENCES ad_creatives(id) ON DELETE CASCADE,
  brand_asset_id INTEGER NOT NULL REFERENCES brand_assets(id) ON DELETE CASCADE,
  role VARCHAR(50) NOT NULL DEFAULT 'reference',
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ad_creative_id, brand_asset_id, role)
);

CREATE TABLE IF NOT EXISTS campaign_ad_creatives (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  ad_creative_id INTEGER NOT NULL REFERENCES ad_creatives(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (campaign_id, ad_creative_id)
);

ALTER TABLE ad_campaigns
  ADD COLUMN IF NOT EXISTS ad_creative_id INTEGER REFERENCES ad_creatives(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS posts (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
  social_account_id INTEGER REFERENCES social_accounts(id) ON DELETE SET NULL,
  brand_channel_id INTEGER REFERENCES brand_channels(id) ON DELETE SET NULL,
  posting_track VARCHAR(50) DEFAULT 'whisper',
  platform VARCHAR(50),
  platform_post_id VARCHAR(255),
  content TEXT,
  subreddit VARCHAR(255),
  video_url TEXT,
  caption TEXT,
  status VARCHAR(50) DEFAULT 'simulated',
  engagement_metrics JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  posted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS comments (
  id SERIAL PRIMARY KEY,
  post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  social_account_id INTEGER REFERENCES social_accounts(id) ON DELETE SET NULL,
  parent_comment_id INTEGER DEFAULT NULL,
  platform_comment_id VARCHAR(255),
  content TEXT,
  status VARCHAR(50) DEFAULT 'simulated',
  sentiment_score NUMERIC DEFAULT 0,
  engagement_metrics JSONB DEFAULT '{}',
  posted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS email_accounts (
  id SERIAL PRIMARY KEY,
  provider VARCHAR(50),
  email VARCHAR(255),
  username VARCHAR(255),
  password VARCHAR(255),
  phone_number VARCHAR(50),
  phone_provider VARCHAR(50),
  status VARCHAR(50) DEFAULT 'active',
  is_verified BOOLEAN DEFAULT false,
  verification_date TIMESTAMP,
  last_login_test TIMESTAMP,
  login_test_success BOOLEAN DEFAULT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS proxies (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255),
  type VARCHAR(50),
  server TEXT,
  username VARCHAR(255),
  password VARCHAR(255),
  country VARCHAR(100),
  city VARCHAR(100),
  provider VARCHAR(100),
  is_residential BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  last_tested_at TIMESTAMP,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS social_account_proxies (
  id SERIAL PRIMARY KEY,
  social_account_id INTEGER REFERENCES social_accounts(id) ON DELETE CASCADE,
  proxy_id INTEGER REFERENCES proxies(id) ON DELETE CASCADE,
  priority INTEGER DEFAULT 1,
  is_active BOOLEAN DEFAULT true,
  assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS network_content_styles (
  id SERIAL PRIMARY KEY,
  network_type VARCHAR(50),
  content_type VARCHAR(50),
  style_guide TEXT,
  prompt_template TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS browser_sessions (
  id SERIAL PRIMARY KEY,
  account_id INTEGER REFERENCES social_accounts(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL,
  cookies JSONB,
  session_data JSONB,
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(account_id, platform)
);

CREATE TABLE IF NOT EXISTS social_networks (
  id SERIAL PRIMARY KEY,
  network_type VARCHAR(50) UNIQUE,
  name VARCHAR(255),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS campaign_accounts (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  social_account_id INTEGER NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  role VARCHAR(50) DEFAULT 'both',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(campaign_id, social_account_id)
);

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

CREATE TABLE IF NOT EXISTS campaign_sim_runs (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ended_at TIMESTAMP,
  status VARCHAR(50) DEFAULT 'running',
  objectives_snapshot JSONB DEFAULT '{}',
  scorecard JSONB DEFAULT NULL,
  findings JSONB DEFAULT NULL,
  overall_score NUMERIC,
  grade VARCHAR(2),
  drafts_rewritten_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS organic_comment_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT false,
  min_per_day INTEGER NOT NULL DEFAULT 1,
  max_per_day INTEGER NOT NULL DEFAULT 3,
  quiet_hours_start INTEGER DEFAULT 1,
  quiet_hours_end INTEGER DEFAULT 7,
  max_concurrent INTEGER NOT NULL DEFAULT 2,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS organic_comment_jobs (
  id SERIAL PRIMARY KEY,
  social_account_id INTEGER NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  next_due_at TIMESTAMP,
  comments_today INTEGER NOT NULL DEFAULT 0,
  day_key DATE,
  daily_target INTEGER,
  status VARCHAR(50) NOT NULL DEFAULT 'idle',
  last_error TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (social_account_id)
);

CREATE TABLE IF NOT EXISTS organic_comments (
  id SERIAL PRIMARY KEY,
  social_account_id INTEGER NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  proxy_id INTEGER REFERENCES proxies(id) ON DELETE SET NULL,
  subreddit VARCHAR(255) NOT NULL,
  post_url TEXT NOT NULL,
  post_title TEXT,
  content TEXT NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  ai_likeness REAL,
  spam_score REAL,
  platform_comment_id VARCHAR(255),
  error TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS social_account_stats_audits (
  id SERIAL PRIMARY KEY,
  social_account_id INTEGER NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  audited_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  total_karma INTEGER,
  post_karma INTEGER,
  comment_karma INTEGER,
  post_count INTEGER,
  comment_count INTEGER,
  likes_count INTEGER,
  dislikes_count INTEGER,
  status VARCHAR(50) NOT NULL DEFAULT 'ok',
  error TEXT,
  raw JSONB DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS account_stats_audit_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT true,
  run_hour_local INTEGER NOT NULL DEFAULT 3,
  timezone VARCHAR(64) NOT NULL DEFAULT 'America/New_York',
  last_run_date DATE,
  last_run_at TIMESTAMP,
  last_run_summary JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
