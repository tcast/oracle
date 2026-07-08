# Amazon Timestream Integration for Oracle

This project implements a migration from PostgreSQL to Amazon Timestream for time-series financial data. Timestream provides better performance, scalability, and cost optimization for large time-series datasets like stock prices.

## Setup Instructions

### 1. Prerequisites

- AWS CLI installed and configured
- Node.js 18.x or later
- PostgreSQL database with stock_prices table (for migration)
- Polygon.io subscription with flat file access

### 2. Environment Configuration

Create a `.env` file in the project root with the following variables:

```
# AWS Configuration
AWS_REGION=us-east-1
AWS_ACCOUNT_ID=your-account-id

# Polygon.io Credentials
POLYGON_ACCESS_KEY=your-polygon-access-key
POLYGON_SECRET_KEY=your-polygon-secret-key

# Lambda IAM Role
LAMBDA_ROLE_ARN=arn:aws:iam::your-account-id:role/lambda-timestream-role

# PostgreSQL Database (for migration)
PG_HOST=your-postgres-host
PG_DATABASE=your-database-name
PG_USER=your-username
PG_PASSWORD=your-password
PG_PORT=5432
```

### 3. Create Timestream Resources

Run the setup script to create the Timestream database and table:

```bash
bash setup-timestream.sh
```

### 4. Migrate Existing Data (Optional)

If you have existing data in PostgreSQL, run the migration script:

```bash
bash run-migration.sh
```

### 5. Deploy Lambda Function

Deploy the Lambda function that will fetch data from Polygon.io flat files and store it in Timestream:

```bash
bash deploy-lambda.sh
```

This will:
- Package the Lambda function
- Deploy it to AWS
- Set up a CloudWatch Events rule to trigger it daily at 1:00 AM UTC

## Components

### Scripts and Files

- `setup-timestream.sh`: Creates Timestream database and table
- `migrate-to-timestream.js`: Migrates data from PostgreSQL to Timestream
- `polygon-to-timestream-lambda.js`: Lambda function to fetch data from Polygon.io and store in Timestream
- `query-timestream.js`: Example of querying data from Timestream
- `timestream-integration.js`: Example of integrating Timestream queries into your application
- `deploy-lambda.sh`: Deploys the Lambda function to AWS

### Lambda Function

The Lambda function `polygon-to-timestream` runs daily and:

1. Downloads the previous day's stock data from Polygon.io flat files
2. Processes the data
3. Stores it in Timestream

### Query Examples

See `query-timestream.js` for examples of querying Timestream data:

- `getStockPrices(symbol, startDate, endDate)`: Get historical data for a specific symbol
- `getLatestPrices(symbols)`: Get the most recent prices for multiple symbols

## Integration with Existing Applications

See `timestream-integration.js` for examples of how to replace PostgreSQL queries with Timestream queries in your application.

## Maintenance

### Handling Backfills

To backfill data for a specific date, you can trigger the Lambda function with a specific date:

```bash
aws lambda invoke \
  --function-name polygon-to-timestream \
  --payload '{"date": "2023-01-01"}' \
  response.json
```

### Monitoring

Monitor the Lambda function's execution through CloudWatch Logs:

```bash
aws logs describe-log-groups \
  --log-group-name-prefix /aws/lambda/polygon-to-timestream
```

## Troubleshooting

### Common Issues

1. **Missing Data**: Check the CloudWatch Logs for the Lambda function to see if there were any errors during data ingestion.

2. **Performance Issues**: If queries are slow, ensure your query patterns match Timestream's strengths. Time-based queries should be efficient.

3. **Lambda Timeouts**: If the Lambda function times out, consider breaking the data processing into smaller batches or increasing the function's timeout setting.

## Next Steps

After migrating stock_prices data, consider:

1. Migrating other time-series data like scraped_mentions
2. Optimizing your application for Timestream queries
3. Setting up monitoring and alerting for the Lambda function 