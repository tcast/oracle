#!/bin/bash

# Extract ScrapeBee API key from .env file
if [ -f "backend/.env" ]; then
  echo "Extracting ScrapeBee API key from backend/.env file..."
  SCRAPEBEE_API_KEY=$(grep SCRAPEBEE_API_KEY backend/.env | cut -d '=' -f2)
  export SCRAPEBEE_API_KEY
  
  if [ -z "$SCRAPEBEE_API_KEY" ]; then
    echo "Warning: Could not find SCRAPEBEE_API_KEY in .env file"
    echo "Please set it manually: export SCRAPEBEE_API_KEY=your_key"
    exit 1
  else
    echo "ScrapeBee API key found."
  fi
else
  echo "backend/.env file not found. Please provide the ScrapeBee API key manually:"
  echo "export SCRAPEBEE_API_KEY=your_key"
  echo "Then run this script again."
  
  if [ -z "$SCRAPEBEE_API_KEY" ]; then
    exit 1
  fi
fi

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
  echo "AWS CLI is not installed. Please install it first."
  exit 1
fi

# Set variables
REDDIT_FUNCTION_NAME="oracle-reddit-scraper"
STOCKTWITS_FUNCTION_NAME="oracle-stocktwits-scraper"
ROLE_ARN=$(aws iam get-role --role-name lambda-timestream-role --query 'Role.Arn' --output text 2>/dev/null)

# Check if the role exists
if [ -z "$ROLE_ARN" ]; then
  echo "Lambda IAM role 'lambda-timestream-role' not found. Creating it..."
  
  # Create IAM policy for Timestream
  echo "Creating Timestream policy..."
  POLICY_ARN=$(aws iam create-policy \
    --policy-name TimeStreamFullAccessPolicy \
    --policy-document '{
      "Version": "2012-10-17",
      "Statement": [
        {
          "Effect": "Allow",
          "Action": [
            "timestream:*"
          ],
          "Resource": "*"
        }
      ]
    }' \
    --query 'Policy.Arn' \
    --output text)
  
  # Create IAM role for Lambda
  echo "Creating Lambda IAM role..."
  ROLE_ARN=$(aws iam create-role \
    --role-name lambda-timestream-role \
    --assume-role-policy-document '{
      "Version": "2012-10-17",
      "Statement": [
        {
          "Effect": "Allow",
          "Principal": {
            "Service": "lambda.amazonaws.com"
          },
          "Action": "sts:AssumeRole"
        }
      ]
    }' \
    --query 'Role.Arn' \
    --output text)
  
  # Attach policies to the role
  echo "Attaching policies to the role..."
  aws iam attach-role-policy --role-name lambda-timestream-role --policy-arn "$POLICY_ARN"
  aws iam attach-role-policy --role-name lambda-timestream-role --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
  
  # Wait for role to propagate
  echo "Waiting for IAM role to propagate..."
  sleep 15
fi

# Setup Timestream database and table
echo "Setting up Timestream database and table..."
bash setup-scraped-mentions-timestream.sh

# Install dependencies
echo "Installing dependencies..."
npm install --production

# Create Timestream Scrapers Lambda package
echo "Creating Lambda package for Timestream scrapers..."
ZIP_FILE="timestream-scrapers.zip"
rm -f "$ZIP_FILE"

# Create a temporary directory for packaging
TEMP_DIR=$(mktemp -d)
cp timestream-mentions.js "$TEMP_DIR/"
cp reddit-timestream-lambda.js "$TEMP_DIR/index-reddit.js"
cp stocktwits-timestream-lambda.js "$TEMP_DIR/index-stocktwits.js"

# Install dependencies in the temp directory
echo "Installing dependencies for Lambda package..."
cd "$TEMP_DIR"
npm init -y
npm install axios @aws-sdk/client-sns @aws-sdk/client-timestream-write @aws-sdk/client-timestream-query --save
cd -

# Create a common package first
echo "Creating common package..."
cd "$TEMP_DIR"
zip -r "../$ZIP_FILE" timestream-mentions.js node_modules
cd -

# Create Reddit Lambda package
echo "Creating Reddit Lambda package..."
cd "$TEMP_DIR"
cp index-reddit.js index.js
zip -g "../$ZIP_FILE" index.js
cd -

# Deploy Reddit Lambda function
echo "Deploying Reddit Lambda function..."
REDDIT_FUNCTION_EXISTS=$(aws lambda list-functions --query "Functions[?FunctionName=='$REDDIT_FUNCTION_NAME'].FunctionName" --output text)

if [ -z "$REDDIT_FUNCTION_EXISTS" ]; then
  # Create new Reddit Lambda function
  echo "Creating new Reddit Lambda function: $REDDIT_FUNCTION_NAME"
  aws lambda create-function \
    --function-name "$REDDIT_FUNCTION_NAME" \
    --runtime nodejs18.x \
    --role "$ROLE_ARN" \
    --handler index.handler \
    --zip-file fileb://"$ZIP_FILE" \
    --timeout 300 \
    --memory-size 512 \
    --environment "{\"Variables\":{\"SCRAPEBEE_API_KEY\":\"$SCRAPEBEE_API_KEY\"}}"
else
  # Update existing Reddit Lambda function
  echo "Updating existing Reddit Lambda function: $REDDIT_FUNCTION_NAME"
  aws lambda update-function-code \
    --function-name "$REDDIT_FUNCTION_NAME" \
    --zip-file fileb://"$ZIP_FILE"
    
  # Update environment variables
  aws lambda update-function-configuration \
    --function-name "$REDDIT_FUNCTION_NAME" \
    --environment "{\"Variables\":{\"SCRAPEBEE_API_KEY\":\"$SCRAPEBEE_API_KEY\"}}"
fi

# Create StockTwits Lambda package
echo "Creating StockTwits Lambda package..."
cd "$TEMP_DIR"
cp index-stocktwits.js index.js
zip -g "../$ZIP_FILE" index.js
cd -

# Deploy StockTwits Lambda function
echo "Deploying StockTwits Lambda function..."
STOCKTWITS_FUNCTION_EXISTS=$(aws lambda list-functions --query "Functions[?FunctionName=='$STOCKTWITS_FUNCTION_NAME'].FunctionName" --output text)

if [ -z "$STOCKTWITS_FUNCTION_EXISTS" ]; then
  # Create new StockTwits Lambda function
  echo "Creating new StockTwits Lambda function: $STOCKTWITS_FUNCTION_NAME"
  aws lambda create-function \
    --function-name "$STOCKTWITS_FUNCTION_NAME" \
    --runtime nodejs18.x \
    --role "$ROLE_ARN" \
    --handler index.handler \
    --zip-file fileb://"$ZIP_FILE" \
    --timeout 300 \
    --memory-size 512 \
    --environment "{\"Variables\":{\"SCRAPEBEE_API_KEY\":\"$SCRAPEBEE_API_KEY\"}}"
else
  # Update existing StockTwits Lambda function
  echo "Updating existing StockTwits Lambda function: $STOCKTWITS_FUNCTION_NAME"
  aws lambda update-function-code \
    --function-name "$STOCKTWITS_FUNCTION_NAME" \
    --zip-file fileb://"$ZIP_FILE"
    
  # Update environment variables
  aws lambda update-function-configuration \
    --function-name "$STOCKTWITS_FUNCTION_NAME" \
    --environment "{\"Variables\":{\"SCRAPEBEE_API_KEY\":\"$SCRAPEBEE_API_KEY\"}}"
fi

# Clean up
rm -rf "$TEMP_DIR"

echo "Deployment complete!" 