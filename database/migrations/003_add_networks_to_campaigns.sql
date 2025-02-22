-- Add networks array column to campaigns table
ALTER TABLE campaigns ADD COLUMN networks TEXT[] DEFAULT '{}';

-- Migrate existing data from campaign_networks table
UPDATE campaigns c
SET networks = ARRAY(
  SELECT network_type 
  FROM campaign_networks cn 
  WHERE cn.campaign_id = c.id
);

-- First drop the dependent campaign_subreddits table
DROP TABLE campaign_subreddits;

-- Now we can drop the campaign_networks table
DROP TABLE campaign_networks;