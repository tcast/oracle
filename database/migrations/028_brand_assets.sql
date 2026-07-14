-- Brand media library (logos, screenshots, product shots, etc.)
CREATE TABLE IF NOT EXISTS brand_assets (
  id SERIAL PRIMARY KEY,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  kind VARCHAR(50) NOT NULL DEFAULT 'other',
  label VARCHAR(255),
  url TEXT NOT NULL,
  mime_type VARCHAR(100),
  meta JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_brand_assets_brand ON brand_assets(brand_id);
CREATE INDEX IF NOT EXISTS idx_brand_assets_kind ON brand_assets(brand_id, kind);
