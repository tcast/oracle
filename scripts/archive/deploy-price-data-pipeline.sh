#!/bin/bash

# Script to deploy the historical data loader and daily update pipeline
# This sets up the Timestream database, loads historical data, and configures Lambda for daily updates

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
  echo "AWS CLI is not installed. Please install it first."
  exit 1
fi

# Extract environment variables from .env file
if [ -f "backend/.env" ]; then
  echo "Extracting API keys from backend/.env file..."
  POLYGON_API_KEY=$(grep POLYGON_API_KEY backend/.env | cut -d '=' -f2)
  export POLYGON_API_KEY
  
  # Extract database credentials
  DB_USER=$(grep DB_USER backend/.env | cut -d '=' -f2)
  DB_PASSWORD=$(grep DB_PASSWORD backend/.env | cut -d '=' -f2)
  DB_HOST=$(grep DB_HOST backend/.env | cut -d '=' -f2)
  DB_NAME=$(grep DB_NAME backend/.env | cut -d '=' -f2)
  DB_PORT=$(grep DB_PORT backend/.env | cut -d '=' -f2)
  DB_REQUIRE_SSL=$(grep DB_REQUIRE_SSL backend/.env | cut -d '=' -f2)
  
  export DB_USER DB_PASSWORD DB_HOST DB_NAME DB_PORT DB_REQUIRE_SSL
  
  if [ -z "$POLYGON_API_KEY" ]; then
    echo "Warning: Could not find POLYGON_API_KEY in .env file"
    echo "Please set it manually: export POLYGON_API_KEY=your_key"
    exit 1
  else
    echo "Polygon API key found."
  fi
else
  echo "backend/.env file not found. Please provide the API keys manually:"
  echo "export POLYGON_API_KEY=your_key"
  echo "Then run this script again."
  
  if [ -z "$POLYGON_API_KEY" ]; then
    exit 1
  fi
fi

# Set variables
TIMESTREAM_DATABASE="oracle"
TIMESTREAM_TABLE="stock_prices"
LAMBDA_FUNCTION_NAME="oracle-price-updater"
ZIP_FILE="${LAMBDA_FUNCTION_NAME}.zip"
ROLE_ARN=$(aws iam get-role --role-name lambda-timestream-role --query 'Role.Arn' --output text 2>/dev/null || echo "arn:aws:iam::774237039587:role/lambda-timestream-role")

# Step 1: Ensure the Timestream database and table exist
echo "Setting up Timestream database and table..."

# Check if database exists
DB_EXISTS=$(aws timestream-write describe-database --database-name ${TIMESTREAM_DATABASE} 2>/dev/null || echo "not_exists")

if [[ "$DB_EXISTS" == "not_exists" ]]; then
  echo "Creating Timestream database '${TIMESTREAM_DATABASE}'..."
  aws timestream-write create-database \
    --database-name ${TIMESTREAM_DATABASE}
else
  echo "Database '${TIMESTREAM_DATABASE}' already exists."
fi

# Check if table exists
TABLE_EXISTS=$(aws timestream-write describe-table --database-name ${TIMESTREAM_DATABASE} --table-name ${TIMESTREAM_TABLE} 2>/dev/null || echo "not_exists")

if [[ "$TABLE_EXISTS" == "not_exists" ]]; then
  echo "Creating '${TIMESTREAM_TABLE}' table..."
  aws timestream-write create-table \
    --database-name ${TIMESTREAM_DATABASE} \
    --table-name ${TIMESTREAM_TABLE} \
    --retention-properties '{
      "MemoryStoreRetentionPeriodInHours": 24,
      "MagneticStoreRetentionPeriodInDays": 3650
    }'
else
  echo "Table '${TIMESTREAM_TABLE}' already exists."
fi

# Step 2: Install dependencies for historical data loader if needed
echo "Installing dependencies for historical data loader..."
npm install axios @aws-sdk/client-timestream-write pg dotenv fs-extra

# Step 3: Run the historical data loader (in background or as a separate process)
echo "Would you like to start loading historical data now? This may take several hours. (y/n)"
read -r start_loading

if [[ "$start_loading" == "y" || "$start_loading" == "Y" ]]; then
  echo "Starting historical data loading process. This will run in the background."
  echo "You can monitor progress in polygon_import_progress.json file."
  node polygon-historical-loader.js > historical_data_load.log 2>&1 &
  echo "Historical data load started in background. Process ID: $!"
  echo "Check historical_data_load.log for progress."
else
  echo "Skipping historical data load for now."
  echo "You can run it later with: node polygon-historical-loader.js"
fi

# Step 4: Create the daily update Lambda function
echo "Creating daily update Lambda function package..."

# Create a minimal Lambda function for daily updates
cat > daily-price-updater.js << 'EOF'
/**
 * Lambda function to fetch daily price updates from Polygon API
 * and store them in Amazon Timestream
 */

const axios = require('axios');
const { TimestreamWriteClient, WriteRecordsCommand } = require('@aws-sdk/client-timestream-write');
const { Pool } = require('pg');

// Configure AWS SDK
const REGION = process.env.AWS_REGION || 'us-east-1';
const TIMESTREAM_DB = process.env.TIMESTREAM_DATABASE || 'oracle';
const TIMESTREAM_TABLE = process.env.TIMESTREAM_TABLE || 'stock_prices';
const timestreamClient = new TimestreamWriteClient({ region: REGION });

// Polygon API configuration
const POLYGON_API_KEY = process.env.POLYGON_API_KEY;
const POLYGON_BASE_URL = 'https://api.polygon.io';

// Database configuration for retrieving symbols
let pool;

// Initialize PostgreSQL pool for getting stock symbols
const initializePool = () => {
  if (!pool) {
    pool = new Pool({
      user: process.env.DB_USER,
      host: process.env.DB_HOST,
      database: process.env.DB_NAME,
      password: process.env.DB_PASSWORD,
      port: process.env.DB_PORT || 5432,
      ssl: process.env.DB_REQUIRE_SSL === 'true' ? {
        rejectUnauthorized: false
      } : false
    });
    
    console.log('Database pool initialized');
  }
  return pool;
};

// Get active stock symbols from database
async function getStockSymbols() {
  const pool = await initializePool();
  const result = await pool.query(`
    SELECT symbol, type FROM stock_symbols 
    WHERE active = true 
    ORDER BY symbol
  `);
  
  return result.rows;
}

// Fetch previous trading day's data
async function fetchPreviousDayData(symbol) {
  try {
    // Get yesterday's date, considering weekends
    let date = new Date();
    date.setDate(date.getDate() - 1);
    
    // If yesterday was Sunday, use Friday's data
    if (date.getDay() === 0) {
      date.setDate(date.getDate() - 2);
    }
    // If yesterday was Saturday, use Friday's data
    else if (date.getDay() === 6) {
      date.setDate(date.getDate() - 1);
    }
    
    const formattedDate = date.toISOString().split('T')[0];
    
    console.log(`Fetching data for ${symbol} on ${formattedDate}`);
    
    const url = `${POLYGON_BASE_URL}/v1/open-close/${symbol}/${formattedDate}`;
    
    const response = await axios.get(url, {
      params: {
        adjusted: true,
        apiKey: POLYGON_API_KEY
      },
      timeout: 10000
    });
    
    if (response.data && response.data.status === 'OK') {
      console.log(`Successfully fetched data for ${symbol}`);
      return response.data;
    } else {
      console.log(`No data available for ${symbol} on ${formattedDate}`);
      return null;
    }
  } catch (error) {
    console.error(`Error fetching data for ${symbol}:`, error.message);
    return null;
  }
}

// Convert Polygon data to Timestream record
function convertToTimestreamRecord(symbol, data, assetType = 'stock') {
  // Convert timestamp to milliseconds
  const date = new Date(data.from);
  const timestamp = date.getTime().toString();
  
  // Create dimensions (attributes we want to filter/query by)
  const dimensions = [
    { Name: 'symbol', Value: symbol },
    { Name: 'asset_type', Value: assetType }
  ];
  
  return {
    Dimensions: dimensions,
    MeasureName: 'price_data',
    MeasureValues: [
      { Name: 'open', Value: data.open.toString(), Type: 'DOUBLE' },
      { Name: 'high', Value: data.high.toString(), Type: 'DOUBLE' },
      { Name: 'low', Value: data.low.toString(), Type: 'DOUBLE' },
      { Name: 'close', Value: data.close.toString(), Type: 'DOUBLE' },
      { Name: 'volume', Value: data.volume.toString(), Type: 'DOUBLE' },
    ],
    Time: timestamp,
    TimeUnit: 'MILLISECONDS'
  };
}

// Write record to Timestream
async function writeRecordToTimestream(record) {
  try {
    const params = {
      DatabaseName: TIMESTREAM_DB,
      TableName: TIMESTREAM_TABLE,
      Records: [record]
    };
    
    const command = new WriteRecordsCommand(params);
    await timestreamClient.send(command);
    
    return true;
  } catch (error) {
    console.error(`Error writing to Timestream:`, error);
    return false;
  }
}

// Sleep function for rate limiting
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Main Lambda handler
exports.handler = async (event, context) => {
  console.log('Starting daily price update process');
  context.callbackWaitsForEmptyEventLoop = false;
  
  try {
    // Get stock symbols from database
    const symbols = await getStockSymbols();
    console.log(`Found ${symbols.length} symbols to process`);
    
    let successCount = 0;
    let errorCount = 0;
    
    // Process each symbol
    for (const symbolData of symbols) {
      const symbol = symbolData.symbol;
      const assetType = symbolData.type || 'stock';
      
      const data = await fetchPreviousDayData(symbol);
      
      if (data) {
        const record = convertToTimestreamRecord(symbol, data, assetType);
        const success = await writeRecordToTimestream(record);
        
        if (success) {
          successCount++;
        } else {
          errorCount++;
        }
      }
      
      // Rate limiting - Polygon's free tier allows 5 calls per minute
      await sleep(12000); // 12 seconds between calls to stay well under the limit
    }
    
    console.log(`Completed with ${successCount} successful updates and ${errorCount} errors`);
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Processing complete',
        successCount,
        errorCount
      })
    };
  } catch (error) {
    console.error('Error in Lambda handler:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Error processing request',
        error: error.message
      })
    };
  } finally {
    // Close the database connection
    if (pool) await pool.end();
  }
};
EOF

# Create deployment package
echo "Creating Lambda deployment package..."
rm -f "$ZIP_FILE"
zip -j "$ZIP_FILE" daily-price-updater.js

# Check if dependencies should be included
echo "Installing dependencies for Lambda package..."
mkdir -p lambda_temp_dir
cd lambda_temp_dir
npm init -y
npm install axios @aws-sdk/client-timestream-write pg --save
cd ..
zip -r "$ZIP_FILE" lambda_temp_dir/node_modules

# Check if the Lambda function already exists
FUNCTION_EXISTS=$(aws lambda list-functions --query "Functions[?FunctionName=='$LAMBDA_FUNCTION_NAME'].FunctionName" --output text)

if [ -z "$FUNCTION_EXISTS" ]; then
  # Create new Lambda function
  echo "Creating new Lambda function: $LAMBDA_FUNCTION_NAME"
  
  aws lambda create-function \
    --function-name "$LAMBDA_FUNCTION_NAME" \
    --runtime nodejs18.x \
    --role "$ROLE_ARN" \
    --handler "daily-price-updater.handler" \
    --zip-file fileb://"$ZIP_FILE" \
    --timeout 900 \
    --memory-size 1024 \
    --environment "{\"Variables\":{\"POLYGON_API_KEY\":\"$POLYGON_API_KEY\",\"DB_USER\":\"$DB_USER\",\"DB_PASSWORD\":\"$DB_PASSWORD\",\"DB_HOST\":\"$DB_HOST\",\"DB_NAME\":\"$DB_NAME\",\"DB_PORT\":\"$DB_PORT\",\"DB_REQUIRE_SSL\":\"$DB_REQUIRE_SSL\",\"TIMESTREAM_DATABASE\":\"$TIMESTREAM_DATABASE\",\"TIMESTREAM_TABLE\":\"$TIMESTREAM_TABLE\"}}"
else
  # Update existing Lambda function
  echo "Updating existing Lambda function: $LAMBDA_FUNCTION_NAME"
  
  # Update function code
  aws lambda update-function-code \
    --function-name "$LAMBDA_FUNCTION_NAME" \
    --zip-file fileb://"$ZIP_FILE"
    
  # Update function configuration
  aws lambda update-function-configuration \
    --function-name "$LAMBDA_FUNCTION_NAME" \
    --runtime nodejs18.x \
    --handler "daily-price-updater.handler" \
    --timeout 900 \
    --memory-size 1024 \
    --environment "{\"Variables\":{\"POLYGON_API_KEY\":\"$POLYGON_API_KEY\",\"DB_USER\":\"$DB_USER\",\"DB_PASSWORD\":\"$DB_PASSWORD\",\"DB_HOST\":\"$DB_HOST\",\"DB_NAME\":\"$DB_NAME\",\"DB_PORT\":\"$DB_PORT\",\"DB_REQUIRE_SSL\":\"$DB_REQUIRE_SSL\",\"TIMESTREAM_DATABASE\":\"$TIMESTREAM_DATABASE\",\"TIMESTREAM_TABLE\":\"$TIMESTREAM_TABLE\"}}"
fi

# Create or update CloudWatch Events rule for daily trigger (runs at 9 PM UTC / 5 PM EST)
RULE_NAME="${LAMBDA_FUNCTION_NAME}-daily-trigger"

echo "Creating/updating CloudWatch Events rule: $RULE_NAME"
aws events put-rule \
  --name "$RULE_NAME" \
  --schedule-expression "cron(0 21 * * ? *)" \
  --state ENABLED

# Get the Lambda function ARN
FUNCTION_ARN=$(aws lambda get-function --function-name "$LAMBDA_FUNCTION_NAME" --query 'Configuration.FunctionArn' --output text)

# Set Lambda as target for the rule
if [ -n "$FUNCTION_ARN" ]; then
  echo "Setting Lambda as target for CloudWatch Events rule"
  aws events put-targets \
    --rule "$RULE_NAME" \
    --targets "Id=1,Arn=$FUNCTION_ARN"

  # Add permission for CloudWatch Events to invoke Lambda (will fail if already exists, which is okay)
  echo "Adding permission for CloudWatch Events to invoke Lambda"
  aws lambda add-permission \
    --function-name "$LAMBDA_FUNCTION_NAME" \
    --statement-id "${RULE_NAME}-permission" \
    --action lambda:InvokeFunction \
    --principal events.amazonaws.com \
    --source-arn $(aws events describe-rule --name "$RULE_NAME" --query 'Arn' --output text) 2>/dev/null || echo "Permission already exists"
else
  echo "Warning: Could not get Lambda function ARN. CloudWatch Events trigger not configured."
fi

# Clean up
rm -rf lambda_temp_dir
echo "Deployment complete!"
echo
echo "Summary:"
echo "--------"
echo "1. Timestream database '${TIMESTREAM_DATABASE}' and table '${TIMESTREAM_TABLE}' are set up"
echo "2. Historical data loader is available at: polygon-historical-loader.js"
if [[ "$start_loading" == "y" || "$start_loading" == "Y" ]]; then
  echo "   - Historical data loading process is running in background"
else
  echo "   - Run it manually with: node polygon-historical-loader.js"
fi
echo "3. Daily price update Lambda function '${LAMBDA_FUNCTION_NAME}' is deployed"
echo "   - Scheduled to run daily at 9 PM UTC / 5 PM EST"
echo
echo "You now have a complete price data pipeline in place!" 