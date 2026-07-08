-- Add email column to social_accounts table
ALTER TABLE social_accounts 
ADD COLUMN email TEXT;

-- Update existing simulated accounts with generated emails
UPDATE social_accounts 
SET email = username || '@simulated.com'
WHERE email IS NULL AND credentials->>'password' = 'default_password';

-- Update any remaining accounts without emails (non-simulated)
UPDATE social_accounts
SET email = username || '@placeholder.com'
WHERE email IS NULL;

-- Add constraint to ensure email is present for non-simulated accounts
ALTER TABLE social_accounts
ADD CONSTRAINT email_required_for_real_accounts
CHECK (
  (credentials->>'password' = 'default_password') OR 
  (email IS NOT NULL)
); 