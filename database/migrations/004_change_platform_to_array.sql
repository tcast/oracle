-- First drop the default constraint
ALTER TABLE campaigns ALTER COLUMN platform DROP DEFAULT;

-- Then change the type to text array, converting existing values
ALTER TABLE campaigns ALTER COLUMN platform TYPE TEXT[] USING ARRAY[platform];

-- Finally set the new default
ALTER TABLE campaigns ALTER COLUMN platform SET DEFAULT '{}'::text[];