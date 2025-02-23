-- First, add the persona_traits column if it doesn't exist
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                  WHERE table_name = 'social_accounts' 
                  AND column_name = 'persona_traits') 
    THEN
        ALTER TABLE social_accounts ADD COLUMN persona_traits JSONB;
    END IF;
END $$;

-- Then clear all existing persona traits
UPDATE social_accounts SET persona_traits = NULL; 