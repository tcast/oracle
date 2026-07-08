# Stock Price Data Pipeline

This project implements a serverless data pipeline for fetching, processing, and storing historical and daily stock price data from the Polygon.io API to Amazon Timestream.

## Components

### 1. Historical Data Loader (`polygon-historical-loader-lambda.js`)

A Lambda function that loads historical stock price data from Polygon.io API into Amazon Timestream. Features:

- Fetches historical data for specified stock symbols and date ranges
- Processes data in batches to handle API rate limits
- Transforms data into the appropriate format for Timestream
- Handles error cases and retries

### 2. Daily Updater (`polygon-daily-updater.js`)

A Lambda function that runs daily to fetch the previous day's stock price data. Features:

- Automatically determines the previous trading day
- Fetches daily data for a configurable list of stock symbols
- Transforms and writes data to Timestream
- Scheduled to run automatically via CloudWatch Events

### 3. Utility Scripts

- `trigger-daily-updater.js`: Manually trigger the daily updater Lambda function
- `check-timestream-data.js`: Query Timestream to check stored data
- `load-multiple-symbols.js`: Load historical data for multiple symbols

## Setup and Deployment

### Prerequisites

- AWS CLI configured with appropriate permissions
- Node.js and npm installed
- Polygon.io API key

### Deployment Steps

1. Create the required IAM roles and policies:
   ```
   aws iam create-role --role-name lambda-timestream-role --assume-role-policy-document file://lambda-role-trust-policy.json
   aws iam put-role-policy --role-name lambda-timestream-role --policy-name timestream-write-policy --policy-document file://timestream-policy.json
   ```

2. Deploy the Lambda functions:
   ```
   # Deploy historical loader
   mkdir -p lambda-pkg && cp polygon-historical-loader-lambda.js lambda-pkg/index.js
   cd lambda-pkg && npm init -y && npm install @aws-sdk/client-timestream-write axios
   zip -r ../lambda-pkg.zip .
   cd ..
   aws lambda create-function --function-name polygon-historical-loader --runtime nodejs18.x --role arn:aws:iam::ACCOUNT_ID:role/lambda-timestream-role --handler index.handler --zip-file fileb://lambda-pkg.zip --timeout 300 --memory-size 256 --environment "Variables={TIMESTREAM_DATABASE=oracle,TIMESTREAM_TABLE=stock_prices,POLYGON_API_KEY=YOUR_API_KEY}"

   # Deploy daily updater
   mkdir -p daily-updater-pkg && cp polygon-daily-updater.js daily-updater-pkg/index.js
   cd daily-updater-pkg && npm init -y && npm install @aws-sdk/client-timestream-write axios
   zip -r ../daily-updater-pkg.zip .
   cd ..
   aws lambda create-function --function-name polygon-daily-updater --runtime nodejs18.x --role arn:aws:iam::ACCOUNT_ID:role/lambda-timestream-role --handler index.handler --zip-file fileb://daily-updater-pkg.zip --timeout 60 --memory-size 128 --environment "Variables={TIMESTREAM_DATABASE=oracle,TIMESTREAM_TABLE=stock_prices,POLYGON_API_KEY=YOUR_API_KEY}"
   ```

3. Set up CloudWatch Events for daily updates:
   ```
   aws events put-rule --name DailyPolygonUpdate --schedule-expression "cron(0 1 * * ? *)" --state ENABLED
   aws lambda add-permission --function-name polygon-daily-updater --statement-id DailyPolygonUpdate --action lambda:InvokeFunction --principal events.amazonaws.com --source-arn arn:aws:events:REGION:ACCOUNT_ID:rule/DailyPolygonUpdate
   aws events put-targets --rule DailyPolygonUpdate --targets '[{"Id":"1","Arn":"arn:aws:lambda:REGION:ACCOUNT_ID:function:polygon-daily-updater","Input":"{\"date\":\"auto\",\"symbols\":[\"AAPL\",\"MSFT\",\"GOOGL\",\"AMZN\",\"META\"]}"}]'
   ```

## Usage

### Loading Historical Data

To load historical data for multiple symbols:

```javascript
node load-multiple-symbols.js
```

### Triggering Daily Updates Manually

To manually trigger the daily updater:

```javascript
node trigger-daily-updater.js [YYYY-MM-DD]
```

If no date is provided, it will use yesterday's date.

### Checking Data in Timestream

To check the data stored in Timestream:

```javascript
node check-timestream-data.js
```

## Data Schema

The data is stored in Timestream with the following schema:

- **Dimensions**:
  - `symbol`: Stock symbol (e.g., AAPL)
  - `date`: Trading date (YYYY-MM-DD)
  - `original_timestamp`: Original timestamp from Polygon
  - `asset_type`: Type of asset (e.g., stock)

- **Measures**:
  - `open`: Opening price
  - `high`: Highest price
  - `low`: Lowest price
  - `close`: Closing price
  - `volume`: Trading volume

## Troubleshooting

- **Lambda Timeouts**: If the Lambda function times out, consider increasing the timeout value or breaking the data into smaller batches.
- **API Rate Limits**: The Polygon API has rate limits. The code includes delays between requests, but you may need to adjust these based on your API tier.
- **Timestream Errors**: Check the IAM permissions if you encounter errors writing to Timestream.

## License

MIT 