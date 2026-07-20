-- Link social_accounts to email_accounts pool (idempotent)
ALTER TABLE social_accounts
  ADD COLUMN IF NOT EXISTS email_account_id INTEGER REFERENCES email_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_social_accounts_email_account
  ON social_accounts(email_account_id);

-- Support banned/disabled statuses used by warm/organic skip filters
COMMENT ON COLUMN social_accounts.status IS
  'active | inactive | pending_setup | banned | disabled | locked';
