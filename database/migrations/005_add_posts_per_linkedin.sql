-- Add posts_per_linkedin column with default value of 1
ALTER TABLE campaigns ADD COLUMN posts_per_linkedin INTEGER NOT NULL DEFAULT 1; 