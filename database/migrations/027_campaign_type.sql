-- Separate Whisper (army) vs Brand (overt + ads) campaign types
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS campaign_type VARCHAR(50) DEFAULT 'whisper';

-- Backfill: brand-only track campaigns → brand; everything else stays whisper
UPDATE campaigns
SET campaign_type = 'brand'
WHERE COALESCE(whisper_enabled, true) = false
  AND (COALESCE(overt_enabled, false) = true OR COALESCE(ads_enabled, false) = true);

UPDATE campaigns
SET campaign_type = 'whisper'
WHERE campaign_type IS NULL OR campaign_type NOT IN ('whisper', 'brand');

-- Align track flags with type for clarity going forward
UPDATE campaigns
SET whisper_enabled = true,
    overt_enabled = false,
    ads_enabled = false
WHERE campaign_type = 'whisper';

UPDATE campaigns
SET whisper_enabled = false,
    overt_enabled = true,
    ads_enabled = true
WHERE campaign_type = 'brand';

CREATE INDEX IF NOT EXISTS idx_campaigns_type ON campaigns(campaign_type);
