#!/bin/bash

# Script to deploy the Polygon to Timestream Lambda function
# Make sure AWS CLI is configured and you have appropriate permissions

# Set variables
FUNCTION_NAME="polygon-to-timestream"
ZIP_FILE="${FUNCTION_NAME}.zip"
ROLE_ARN=$(aws iam get-role --role-name lambda-timestream-role --query 'Role.Arn' --output text 2>/dev/null || echo "arn:aws:iam::774237039587:role/lambda-timestream-role")

# Accept command line arguments for API keys
if [ "$1" != "" ]; then
  POLYGON_ACCESS_KEY="$1"
else
  # Check for Polygon credentials
  if [ -z "$POLYGON_ACCESS_KEY" ]; then
    echo "POLYGON_ACCESS_KEY environment variable not set."
    read -p "Enter your Polygon Access Key (or leave empty to use placeholder): " POLYGON_ACCESS_KEY
    POLYGON_ACCESS_KEY=${POLYGON_ACCESS_KEY:-"YOUR_POLYGON_ACCESS_KEY"}
  fi
fi

if [ "$2" != "" ]; then
  POLYGON_SECRET_KEY="$2"
else
  if [ -z "$POLYGON_SECRET_KEY" ]; then
    echo "POLYGON_SECRET_KEY environment variable not set."
    read -p "Enter your Polygon Secret Key (or leave empty to use placeholder): " POLYGON_SECRET_KEY
    POLYGON_SECRET_KEY=${POLYGON_SECRET_KEY:-"YOUR_POLYGON_SECRET_KEY"}
  fi
fi

echo "Starting Lambda deployment process with role ARN: $ROLE_ARN"

# Create deployment package
echo "Creating deployment package..."
rm -f "$ZIP_FILE"
zip -r "$ZIP_FILE" index.js node_modules package.json package-lock.json -x "*.git*" "*.DS_Store"

# Check if the Lambda function already exists
FUNCTION_EXISTS=$(aws lambda list-functions --query "Functions[?FunctionName=='$FUNCTION_NAME'].FunctionName" --output text)

if [ -z "$FUNCTION_EXISTS" ]; then
  # Create new Lambda function
  echo "Creating new Lambda function: $FUNCTION_NAME"
  
  aws lambda create-function \
    --function-name "$FUNCTION_NAME" \
    --runtime nodejs18.x \
    --role "$ROLE_ARN" \
    --handler index.handler \
    --zip-file fileb://"$ZIP_FILE" \
    --timeout 900 \
    --memory-size 1024 \
    --environment "{\"Variables\":{\"POLYGON_ACCESS_KEY\":\"$POLYGON_ACCESS_KEY\",\"POLYGON_SECRET_KEY\":\"$POLYGON_SECRET_KEY\",\"TIMESTREAM_DATABASE\":\"oracle\",\"TIMESTREAM_TABLE\":\"stock_prices\"}}"
else
  # Update existing Lambda function
  echo "Updating existing Lambda function: $FUNCTION_NAME"
  
  # Update function code
  aws lambda update-function-code \
    --function-name "$FUNCTION_NAME" \
    --zip-file fileb://"$ZIP_FILE"
    
  # Update function configuration
  aws lambda update-function-configuration \
    --function-name "$FUNCTION_NAME" \
    --runtime nodejs18.x \
    --handler index.handler \
    --timeout 900 \
    --memory-size 1024 \
    --environment "{\"Variables\":{\"POLYGON_ACCESS_KEY\":\"$POLYGON_ACCESS_KEY\",\"POLYGON_SECRET_KEY\":\"$POLYGON_SECRET_KEY\",\"TIMESTREAM_DATABASE\":\"oracle\",\"TIMESTREAM_TABLE\":\"stock_prices\"}}"
fi

# Create or update CloudWatch Events rule for daily trigger
RULE_NAME="${FUNCTION_NAME}-daily-trigger"

echo "Creating/updating CloudWatch Events rule: $RULE_NAME"
aws events put-rule \
  --name "$RULE_NAME" \
  --schedule-expression "cron(0 1 * * ? *)" \
  --state ENABLED

# Get the Lambda function ARN
FUNCTION_ARN=$(aws lambda get-function --function-name "$FUNCTION_NAME" --query 'Configuration.FunctionArn' --output text)

# Set Lambda as target for the rule
if [ -n "$FUNCTION_ARN" ]; then
  echo "Setting Lambda as target for CloudWatch Events rule"
  aws events put-targets \
    --rule "$RULE_NAME" \
    --targets "Id=1,Arn=$FUNCTION_ARN"

  # Add permission for CloudWatch Events to invoke Lambda (will fail if already exists, which is okay)
  echo "Adding permission for CloudWatch Events to invoke Lambda"
  aws lambda add-permission \
    --function-name "$FUNCTION_NAME" \
    --statement-id "${RULE_NAME}-permission" \
    --action lambda:InvokeFunction \
    --principal events.amazonaws.com \
    --source-arn $(aws events describe-rule --name "$RULE_NAME" --query 'Arn' --output text) 2>/dev/null || echo "Permission already exists"
else
  echo "Warning: Could not get Lambda function ARN. CloudWatch Events trigger not configured."
fi

echo "Deployment complete!" 