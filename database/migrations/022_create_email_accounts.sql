-- Migration: Create email_accounts table for managing email account pools
-- This allows creating email accounts independently and assigning them to social accounts later

CREATE TABLE IF NOT EXISTS email_accounts (
  id SERIAL PRIMARY KEY,
  provider VARCHAR(50) NOT NULL,           -- 'yandex', 'gmx', 'mail.com'
  email VARCHAR(255) NOT NULL UNIQUE,
  username VARCHAR(100) NOT NULL,
  password VARCHAR(255) NOT NULL,
  recovery_email VARCHAR(255),             -- Backup email if used during signup
  phone_number VARCHAR(50),                -- Verification phone number used
  phone_provider VARCHAR(50),              -- 'smsman', '5sim', etc.
  status VARCHAR(20) DEFAULT 'active',     -- 'active', 'inactive', 'banned', 'locked'
  is_verified BOOLEAN DEFAULT false,       -- Email verified successfully
  verification_date TIMESTAMP,             -- When verification completed
  last_used_at TIMESTAMP,                  -- Last time email was used
  last_login_test TIMESTAMP,               -- Last time login was tested
  login_test_success BOOLEAN,              -- Last login test result
  metadata JSONB DEFAULT '{}',             -- Provider-specific data, browser fingerprints, etc.
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_email_accounts_provider ON email_accounts(provider);
CREATE INDEX idx_email_accounts_status ON email_accounts(status);
CREATE INDEX idx_email_accounts_email ON email_accounts(email);
CREATE INDEX idx_email_accounts_is_verified ON email_accounts(is_verified);
CREATE INDEX idx_email_accounts_created_at ON email_accounts(created_at DESC);

-- Link email accounts to social accounts (optional foreign key)
ALTER TABLE social_accounts
ADD COLUMN IF NOT EXISTS email_account_id INTEGER REFERENCES email_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_social_accounts_email_account ON social_accounts(email_account_id);

-- Update trigger for updated_at
CREATE OR REPLACE FUNCTION update_email_accounts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_email_accounts_updated_at
  BEFORE UPDATE ON email_accounts
  FOR EACH ROW
  EXECUTE FUNCTION update_email_accounts_updated_at();

-- Comments for documentation
COMMENT ON TABLE email_accounts IS 'Stores email accounts created for use with social media accounts';
COMMENT ON COLUMN email_accounts.provider IS 'Email provider: yandex, gmx, mail.com, etc.';
COMMENT ON COLUMN email_accounts.metadata IS 'JSON field for provider-specific data, cookies, session info';
COMMENT ON COLUMN email_accounts.phone_number IS 'Phone number used for verification (from SMS service)';
COMMENT ON COLUMN email_accounts.phone_provider IS 'SMS verification service used (smsman, 5sim, etc.)';
