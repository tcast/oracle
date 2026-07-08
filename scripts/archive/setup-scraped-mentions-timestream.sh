#!/bin/bash

# Check if the database exists
echo "Checking if Timestream database 'oracle' exists..."
DB_EXISTS=$(aws timestream-write describe-database --database-name oracle 2>/dev/null || echo "not_exists")

if [[ "$DB_EXISTS" == "not_exists" ]]; then
  echo "Creating Timestream database 'oracle'..."
  aws timestream-write create-database \
      --database-name oracle
else
  echo "Database 'oracle' already exists."
fi

# Check if the table exists
echo "Checking if 'scraped_mentions' table exists..."
TABLE_EXISTS=$(aws timestream-write describe-table --database-name oracle --table-name scraped_mentions 2>/dev/null || echo "not_exists")

if [[ "$TABLE_EXISTS" == "not_exists" ]]; then
  # Create scraped_mentions table with appropriate retention settings
  echo "Creating 'scraped_mentions' table..."
  aws timestream-write create-table \
      --database-name oracle \
      --table-name scraped_mentions \
      --retention-properties '{
          "MemoryStoreRetentionPeriodInHours": 24,
          "MagneticStoreRetentionPeriodInDays": 730
      }'
else
  echo "Table 'scraped_mentions' already exists."
fi

echo "Timestream scraped_mentions setup complete!" 