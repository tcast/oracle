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
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_running BOOLEAN DEFAULT false,
  simulation_mode BOOLEAN DEFAULT true,
  posts_per_subreddit INTEGER DEFAULT 3,
  status VARCHAR(50) DEFAULT 'draft',
  schedule JSONB DEFAULT '{}'
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
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS posts (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
  social_account_id INTEGER REFERENCES social_accounts(id) ON DELETE SET NULL,
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
