-- Per-brand OAuth app credentials (many brands / many apps)
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

CREATE INDEX IF NOT EXISTS idx_brand_oauth_apps_brand ON brand_oauth_apps(brand_id);

COMMENT ON TABLE brand_oauth_apps IS 'OAuth app credentials per brand. provider: linkedin | x | meta | google_ads';
COMMENT ON COLUMN brand_oauth_apps.extra IS 'Provider-specific fields e.g. developer_token, login_customer_id for Google Ads';
