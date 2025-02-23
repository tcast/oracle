-- Remove unused columns from social_accounts and social_networks tables

-- First check if personality_traits column exists and drop it
DO $$ 
BEGIN 
    IF EXISTS (SELECT 1 FROM information_schema.columns 
               WHERE table_name = 'social_accounts' 
               AND column_name = 'personality_traits') 
    THEN
        ALTER TABLE social_accounts DROP COLUMN personality_traits;
    END IF;
END $$;

-- Then check if default_settings column exists and drop it
DO $$ 
BEGIN 
    IF EXISTS (SELECT 1 FROM information_schema.columns 
               WHERE table_name = 'social_networks' 
               AND column_name = 'default_settings') 
    THEN
        ALTER TABLE social_networks DROP COLUMN default_settings;
    END IF;
END $$; 