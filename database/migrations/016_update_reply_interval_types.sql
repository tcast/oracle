-- Change reply interval fields to DECIMAL type
ALTER TABLE campaigns 
ALTER COLUMN min_reply_interval_hours TYPE DECIMAL(4,1),
ALTER COLUMN max_reply_interval_hours TYPE DECIMAL(4,1); 