#!/bin/bash

# Create Timestream database
echo "Creating Timestream database 'financial_data'..."
aws timestream-write create-database \
    --database-name financial_data

# Create stock_prices table with appropriate retention settings
echo "Creating 'stock_prices' table..."
aws timestream-write create-table \
    --database-name financial_data \
    --table-name stock_prices \
    --retention-properties '{
        "MemoryStoreRetentionPeriodInHours": 24,
        "MagneticStoreRetentionPeriodInDays": 730
    }'

echo "Timestream setup complete!" 