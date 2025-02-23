-- Add TikTok-specific fields to campaigns table
ALTER TABLE campaigns 
ADD COLUMN IF NOT EXISTS posts_per_tiktok INTEGER NOT NULL DEFAULT 1,
ADD COLUMN IF NOT EXISTS total_tiktok_posts INTEGER NOT NULL DEFAULT 5; 