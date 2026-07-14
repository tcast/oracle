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

UPDATE brand_assets
SET original_filename = COALESCE(original_filename, meta->>'original_name'),
    byte_size = COALESCE(byte_size, NULLIF(meta->>'size', '')::BIGINT),
    parse_status = CASE
      WHEN parse_status = 'pending' AND mime_type LIKE 'image/%' THEN 'pending'
      WHEN parse_status = 'pending' THEN 'pending'
      ELSE parse_status
    END;

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
