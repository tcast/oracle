-- First, create a new type with the desired values
CREATE TYPE social_network_type_new AS ENUM ('reddit', 'linkedin', 'x', 'tiktok');

-- Update the social_networks table to use the new type
ALTER TABLE social_networks 
  ALTER COLUMN network_type TYPE social_network_type_new 
  USING network_type::text::social_network_type_new;

-- Drop the old type
DROP TYPE social_network_type;

-- Rename the new type to the original name
ALTER TYPE social_network_type_new RENAME TO social_network_type; 