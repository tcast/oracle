-- Track profile build-out (photo/banner/headline) and job category per social account

ALTER TABLE social_accounts
  ADD COLUMN IF NOT EXISTS profile_enrichment JSONB DEFAULT NULL;

COMMENT ON COLUMN social_accounts.profile_enrichment IS
  'Profile build-out status: { photo, banner, headline, about, experience, category, built_out, source, updated_at }';

CREATE INDEX IF NOT EXISTS idx_social_accounts_enrichment_built_out
  ON social_accounts ((profile_enrichment->>'built_out'));

CREATE INDEX IF NOT EXISTS idx_social_accounts_enrichment_category
  ON social_accounts ((profile_enrichment->>'category'));
