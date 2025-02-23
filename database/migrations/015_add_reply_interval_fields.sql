-- Add reply interval fields to campaigns table
ALTER TABLE campaigns 
ADD COLUMN min_reply_interval_hours INTEGER NOT NULL DEFAULT 1,
ADD COLUMN max_reply_interval_hours INTEGER NOT NULL DEFAULT 24; 