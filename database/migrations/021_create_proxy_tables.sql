-- Create proxies table to store all proxy configurations
CREATE TABLE IF NOT EXISTS proxies (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL DEFAULT 'http', -- http, https, socks5
    server VARCHAR(255) NOT NULL, -- proxy server address with port
    username VARCHAR(255),
    password VARCHAR(255),
    country VARCHAR(2), -- ISO country code
    city VARCHAR(100),
    provider VARCHAR(100), -- proxy provider name
    is_residential BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    last_used_at TIMESTAMP,
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    metadata JSONB DEFAULT '{}', -- additional proxy-specific data
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Create junction table for many-to-many relationship
CREATE TABLE IF NOT EXISTS social_account_proxies (
    id SERIAL PRIMARY KEY,
    social_account_id INTEGER NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
    proxy_id INTEGER NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
    priority INTEGER DEFAULT 1, -- priority for proxy rotation (1 = highest)
    is_active BOOLEAN DEFAULT true,
    last_used_at TIMESTAMP,
    use_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(social_account_id, proxy_id)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_proxies_active ON proxies(is_active);
CREATE INDEX IF NOT EXISTS idx_proxies_type ON proxies(type);
CREATE INDEX IF NOT EXISTS idx_proxies_country ON proxies(country);
CREATE INDEX IF NOT EXISTS idx_proxies_provider ON proxies(provider);
CREATE INDEX IF NOT EXISTS idx_social_account_proxies_account ON social_account_proxies(social_account_id);
CREATE INDEX IF NOT EXISTS idx_social_account_proxies_proxy ON social_account_proxies(proxy_id);
CREATE INDEX IF NOT EXISTS idx_social_account_proxies_active ON social_account_proxies(is_active);

-- Add comments
COMMENT ON TABLE proxies IS 'Stores proxy server configurations';
COMMENT ON TABLE social_account_proxies IS 'Links social accounts to their assigned proxies';
COMMENT ON COLUMN proxies.type IS 'Proxy protocol type: http, https, or socks5';
COMMENT ON COLUMN proxies.is_residential IS 'Whether this is a residential proxy (better for social media)';
COMMENT ON COLUMN social_account_proxies.priority IS 'Priority for proxy rotation, lower number = higher priority';

-- Remove the old proxy_config column from social_accounts if you want to migrate
-- ALTER TABLE social_accounts DROP COLUMN IF EXISTS proxy_config;
