-- Add campaign_overview column
ALTER TABLE campaigns ADD COLUMN campaign_overview TEXT;

-- Update column descriptions to clarify their roles
COMMENT ON COLUMN campaigns.campaign_overview IS 'Detailed description of what is being promoted (theory, product, news, etc.)';
COMMENT ON COLUMN campaigns.campaign_goal IS 'Strategic objectives for the campaign (e.g., mass adoption, awareness)';
COMMENT ON COLUMN campaigns.post_goal IS 'Specific goals for individual posts (e.g., drive engagement, speculation)';
COMMENT ON COLUMN campaigns.comment_goal IS 'Goals for comment behavior (e.g., validation, support)';

-- Set default values for existing campaigns
UPDATE campaigns 
SET campaign_overview = campaign_goal 
WHERE campaign_overview IS NULL; 