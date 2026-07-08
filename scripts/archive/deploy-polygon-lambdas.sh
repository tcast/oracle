#!/bin/bash

# Script to deploy Polygon data processing Lambda functions
# 1. polygon-historical-loader - One-time job to load all historical data
# 2. polygon-daily-updater - Daily job to fetch latest price data

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
  echo "backend/.env file not found. Please provide the API keys manually."
  exit 1
fi

# Set variables
TIMESTREAM_DATABASE="oracle"
TIMESTREAM_TABLE="stock_prices"
HISTORICAL_FUNCTION_NAME="polygon-historical-loader"
DAILY_FUNCTION_NAME="polygon-daily-updater"
HISTORICAL_ZIP_FILE="${HISTORICAL_FUNCTION_NAME}.zip"
DAILY_ZIP_FILE="${DAILY_FUNCTION_NAME}.zip"
ROLE_ARN=$(aws iam get-role --role-name lambda-timestream-role --query 'Role.Arn' --output text 2>/dev/null || echo "arn:aws:iam::774237039587:role/lambda-timestream-role")

# Polygon Flat File credentials - for use with historical data loading
POLYGON_S3_ACCESS_KEY="18972b38-e2dd-40cf-bb10-f3eede60c8c4"
POLYGON_S3_SECRET_KEY="GamH9ewSNWT6BeUM19cdtlCzyNCfVHWx"

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

# Step 2: Create deployment packages
echo "Creating Lambda deployment packages..."

# Create temp directory for node modules
mkdir -p lambda_package

# Install dependencies for both Lambda functions
echo "Installing dependencies..."
cd lambda_package
npm init -y
npm install axios @aws-sdk/client-timestream-write @aws-sdk/client-s3 pg --save
cd ..

# Create Historical Loader Lambda package
echo "Creating historical loader Lambda package..."
rm -f "$HISTORICAL_ZIP_FILE"
cp polygon-historical-loader-lambda.js lambda_package/index.js
cd lambda_package
zip -r "../$HISTORICAL_ZIP_FILE" .
cd ..

# Create Daily Updater Lambda package
echo "Creating daily updater Lambda package..."
rm -f "$DAILY_ZIP_FILE"
cp polygon-daily-updater-lambda.js lambda_package/index.js
cd lambda_package
zip -r "../$DAILY_ZIP_FILE" .
cd ..

# Step 3: Deploy Historical Loader Lambda
echo "Deploying historical loader Lambda function..."

# Check if the function already exists
HISTORICAL_EXISTS=$(aws lambda list-functions --query "Functions[?FunctionName=='$HISTORICAL_FUNCTION_NAME'].FunctionName" --output text)

if [ -z "$HISTORICAL_EXISTS" ]; then
  # Create new function
  echo "Creating new Lambda function: $HISTORICAL_FUNCTION_NAME"
  
  aws lambda create-function \
    --function-name "$HISTORICAL_FUNCTION_NAME" \
    --runtime nodejs18.x \
    --role "$ROLE_ARN" \
    --handler "index.handler" \
    --zip-file fileb://"$HISTORICAL_ZIP_FILE" \
    --timeout 900 \
    --memory-size 2048 \
    --environment "{\"Variables\":{\"POLYGON_API_KEY\":\"$POLYGON_API_KEY\",\"POLYGON_S3_ACCESS_KEY\":\"$POLYGON_S3_ACCESS_KEY\",\"POLYGON_S3_SECRET_KEY\":\"$POLYGON_S3_SECRET_KEY\",\"DB_USER\":\"$DB_USER\",\"DB_PASSWORD\":\"$DB_PASSWORD\",\"DB_HOST\":\"$DB_HOST\",\"DB_NAME\":\"$DB_NAME\",\"DB_PORT\":\"$DB_PORT\",\"DB_REQUIRE_SSL\":\"$DB_REQUIRE_SSL\",\"TIMESTREAM_DATABASE\":\"$TIMESTREAM_DATABASE\",\"TIMESTREAM_TABLE\":\"$TIMESTREAM_TABLE\"}}"
else
  # Update existing function
  echo "Updating existing Lambda function: $HISTORICAL_FUNCTION_NAME"
  
  aws lambda update-function-code \
    --function-name "$HISTORICAL_FUNCTION_NAME" \
    --zip-file fileb://"$HISTORICAL_ZIP_FILE"
    
  aws lambda update-function-configuration \
    --function-name "$HISTORICAL_FUNCTION_NAME" \
    --runtime nodejs18.x \
    --handler "index.handler" \
    --timeout 900 \
    --memory-size 2048 \
    --environment "{\"Variables\":{\"POLYGON_API_KEY\":\"$POLYGON_API_KEY\",\"POLYGON_S3_ACCESS_KEY\":\"$POLYGON_S3_ACCESS_KEY\",\"POLYGON_S3_SECRET_KEY\":\"$POLYGON_S3_SECRET_KEY\",\"DB_USER\":\"$DB_USER\",\"DB_PASSWORD\":\"$DB_PASSWORD\",\"DB_HOST\":\"$DB_HOST\",\"DB_NAME\":\"$DB_NAME\",\"DB_PORT\":\"$DB_PORT\",\"DB_REQUIRE_SSL\":\"$DB_REQUIRE_SSL\",\"TIMESTREAM_DATABASE\":\"$TIMESTREAM_DATABASE\",\"TIMESTREAM_TABLE\":\"$TIMESTREAM_TABLE\"}}"
fi

# Step 4: Deploy Daily Updater Lambda
echo "Deploying daily updater Lambda function..."

# Check if the function already exists
DAILY_EXISTS=$(aws lambda list-functions --query "Functions[?FunctionName=='$DAILY_FUNCTION_NAME'].FunctionName" --output text)

if [ -z "$DAILY_EXISTS" ]; then
  # Create new function
  echo "Creating new Lambda function: $DAILY_FUNCTION_NAME"
  
  aws lambda create-function \
    --function-name "$DAILY_FUNCTION_NAME" \
    --runtime nodejs18.x \
    --role "$ROLE_ARN" \
    --handler "index.handler" \
    --zip-file fileb://"$DAILY_ZIP_FILE" \
    --timeout 900 \
    --memory-size 1024 \
    --environment "{\"Variables\":{\"POLYGON_API_KEY\":\"$POLYGON_API_KEY\",\"DB_USER\":\"$DB_USER\",\"DB_PASSWORD\":\"$DB_PASSWORD\",\"DB_HOST\":\"$DB_HOST\",\"DB_NAME\":\"$DB_NAME\",\"DB_PORT\":\"$DB_PORT\",\"DB_REQUIRE_SSL\":\"$DB_REQUIRE_SSL\",\"TIMESTREAM_DATABASE\":\"$TIMESTREAM_DATABASE\",\"TIMESTREAM_TABLE\":\"$TIMESTREAM_TABLE\"}}"
else
  # Update existing function
  echo "Updating existing Lambda function: $DAILY_FUNCTION_NAME"
  
  aws lambda update-function-code \
    --function-name "$DAILY_FUNCTION_NAME" \
    --zip-file fileb://"$DAILY_ZIP_FILE"
    
  aws lambda update-function-configuration \
    --function-name "$DAILY_FUNCTION_NAME" \
    --runtime nodejs18.x \
    --handler "index.handler" \
    --timeout 900 \
    --memory-size 1024 \
    --environment "{\"Variables\":{\"POLYGON_API_KEY\":\"$POLYGON_API_KEY\",\"DB_USER\":\"$DB_USER\",\"DB_PASSWORD\":\"$DB_PASSWORD\",\"DB_HOST\":\"$DB_HOST\",\"DB_NAME\":\"$DB_NAME\",\"DB_PORT\":\"$DB_PORT\",\"DB_REQUIRE_SSL\":\"$DB_REQUIRE_SSL\",\"TIMESTREAM_DATABASE\":\"$TIMESTREAM_DATABASE\",\"TIMESTREAM_TABLE\":\"$TIMESTREAM_TABLE\"}}"
fi

# Step 5: Set up daily scheduler using CloudWatch Events
echo "Setting up CloudWatch Events rule for daily updates..."

RULE_NAME="${DAILY_FUNCTION_NAME}-daily-trigger"

echo "Creating/updating CloudWatch Events rule: $RULE_NAME"
aws events put-rule \
  --name "$RULE_NAME" \
  --schedule-expression "cron(0 21 * * ? *)" \
  --state ENABLED

# Get the Lambda function ARN
DAILY_FUNCTION_ARN=$(aws lambda get-function --function-name "$DAILY_FUNCTION_NAME" --query 'Configuration.FunctionArn' --output text)

# Set Lambda as target for the rule
echo "Setting Lambda as target for CloudWatch Events rule"
aws events put-targets \
  --rule "$RULE_NAME" \
  --targets "Id=1,Arn=$DAILY_FUNCTION_ARN"

# Add permission for CloudWatch Events to invoke Lambda
echo "Adding permission for CloudWatch Events to invoke Lambda"
aws lambda add-permission \
  --function-name "$DAILY_FUNCTION_NAME" \
  --statement-id "${RULE_NAME}-permission" \
  --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn $(aws events describe-rule --name "$RULE_NAME" --query 'Arn' --output text) 2>/dev/null || echo "Permission already exists"

# Step 6: Create a Step Function to orchestrate the historical data loader
echo "Creating a Step Function state machine for historical data loading..."

# Create Step Function definition
cat > stepfunction_definition.json << EOF
{
  "Comment": "State machine to orchestrate loading historical stock price data",
  "StartAt": "Initialize",
  "States": {
    "Initialize": {
      "Type": "Pass",
      "Result": {
        "startYear": 2003,
        "endYear": $(date +%Y),
        "startSymbolIndex": 0,
        "batchSize": 5
      },
      "Next": "ProcessBatch"
    },
    "ProcessBatch": {
      "Type": "Task",
      "Resource": "${HISTORICAL_FUNCTION_ARN}",
      "Next": "CheckMoreSymbols"
    },
    "CheckMoreSymbols": {
      "Type": "Choice",
      "Choices": [
        {
          "Variable": "$.body.remainingSymbols",
          "NumericGreaterThan": 0,
          "Next": "PrepareNextBatch"
        }
      ],
      "Default": "FinishSuccessfully"
    },
    "PrepareNextBatch": {
      "Type": "Pass",
      "Result": {
        "startYear": 2003,
        "endYear": $(date +%Y)
      },
      "ResultPath": "$.nextInput",
      "Next": "SetupNextBatch"
    },
    "SetupNextBatch": {
      "Type": "Pass",
      "Parameters": {
        "startYear.$": "$.nextInput.startYear",
        "endYear.$": "$.nextInput.endYear",
        "startSymbolIndex.$": "$.body.nextSymbolIndex",
        "batchSize.$": "$.body.batchProcessed"
      },
      "Next": "Wait"
    },
    "Wait": {
      "Type": "Wait",
      "Seconds": 2,
      "Next": "ProcessBatch"
    },
    "FinishSuccessfully": {
      "Type": "Succeed"
    }
  }
}
EOF

# Create or update Step Function state machine
STEP_FUNCTION_NAME="PolygonHistoricalDataLoader"
STEP_FUNCTION_ARN=$(aws stepfunctions list-state-machines --query "stateMachines[?name=='$STEP_FUNCTION_NAME'].stateMachineArn" --output text)

if [ -z "$STEP_FUNCTION_ARN" ]; then
  # Create new state machine
  echo "Creating new Step Function state machine: $STEP_FUNCTION_NAME"
  
  STEP_FUNCTION_ROLE_ARN=$(aws iam get-role --role-name StepFunctionsExecutionRole --query 'Role.Arn' --output text 2>/dev/null)
  
  if [ -z "$STEP_FUNCTION_ROLE_ARN" ]; then
    echo "Creating IAM role for Step Functions..."
    
    # Create policy document for trust relationship
    cat > trust-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "states.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF
    
    # Create role
    STEP_FUNCTION_ROLE_ARN=$(aws iam create-role \
      --role-name StepFunctionsExecutionRole \
      --assume-role-policy-document file://trust-policy.json \
      --query 'Role.Arn' --output text)
    
    # Attach policies
    aws iam attach-role-policy \
      --role-name StepFunctionsExecutionRole \
      --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaRole
    
    # Wait for role propagation
    echo "Waiting for role propagation..."
    sleep 10
  fi
  
  aws stepfunctions create-state-machine \
    --name "$STEP_FUNCTION_NAME" \
    --definition file://stepfunction_definition.json \
    --role-arn "$STEP_FUNCTION_ROLE_ARN"
else
  # Update existing state machine
  echo "Updating existing Step Function state machine: $STEP_FUNCTION_NAME"
  
  aws stepfunctions update-state-machine \
    --state-machine-arn "$STEP_FUNCTION_ARN" \
    --definition file://stepfunction_definition.json
fi

# Clean up
rm -rf lambda_package
rm -f stepfunction_definition.json trust-policy.json
rm -f "$HISTORICAL_ZIP_FILE" "$DAILY_ZIP_FILE"

echo "Deployment complete!"
echo
echo "Summary:"
echo "--------"
echo "1. Historical Loader Lambda ($HISTORICAL_FUNCTION_NAME) has been deployed"
echo "   - Used to load all historical data from 2003 to present"
echo "   - Orchestrated by Step Function for handling large datasets"
echo
echo "2. Daily Updater Lambda ($DAILY_FUNCTION_NAME) has been deployed"
echo "   - Scheduled to run daily at 9 PM UTC to fetch the latest data"
echo
echo "To start the historical data loading process, run:"
echo "aws stepfunctions start-execution --state-machine-arn \$STEP_FUNCTION_ARN"
echo
echo "You now have a complete price data pipeline in place!"