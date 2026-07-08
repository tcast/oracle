-- Add proxy_config column to social_accounts table for VPN/proxy support
ALTER TABLE social_accounts 
ADD COLUMN IF NOT EXISTS proxy_config JSONB DEFAULT NULL;

-- Add index for accounts with proxy configuration
CREATE INDEX IF NOT EXISTS idx_social_accounts_proxy_config 
ON social_accounts ((proxy_config IS NOT NULL));

-- Comment on the column
COMMENT ON COLUMN social_accounts.proxy_config IS 'Proxy configuration for the account including server, username, and password';
