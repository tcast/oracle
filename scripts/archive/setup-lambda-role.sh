#!/bin/bash

# Script to set up the IAM role for Lambda to access Timestream
# This script will create the role if it doesn't exist and attach the necessary policies

ROLE_NAME="lambda-timestream-role"
ROLE_DESCRIPTION="Role for Lambda function to access Timestream"

echo "Checking if IAM role '$ROLE_NAME' exists..."

# Check if the role exists
aws iam get-role --role-name "$ROLE_NAME" > /dev/null 2>&1
ROLE_EXISTS=$?

if [ $ROLE_EXISTS -eq 0 ]; then
  echo "Role '$ROLE_NAME' already exists."
  ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)
else
  echo "Role '$ROLE_NAME' does not exist. Creating it..."
  
  # Create a trust policy document to allow Lambda to assume this role
  cat > trust-policy.json << EOF
{
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
}
EOF

  # Create the role
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document file://trust-policy.json \
    --description "$ROLE_DESCRIPTION"

  # Get the ARN of the newly created role
  ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)
  
  echo "Role created with ARN: $ROLE_ARN"
  
  # Clean up
  rm trust-policy.json
fi

# Attach policies to the role for Lambda and Timestream access
echo "Attaching policies to the role..."

# AWS managed policy for Lambda basic execution (CloudWatch Logs)
aws iam attach-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"

# AWS managed policy for Timestream full access
aws iam attach-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-arn "arn:aws:iam::aws:policy/AmazonTimestreamFullAccess"

# Add policy for accessing S3 to download Polygon files
cat > polygon-s3-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::polygon-io-data*",
        "arn:aws:s3:::polygon-io-data*/*"
      ]
    }
  ]
}
EOF

# Create a policy for Polygon S3 access
POLICY_NAME="PolygonS3AccessPolicy"
POLICY_ARN=$(aws iam create-policy \
  --policy-name "$POLICY_NAME" \
  --policy-document file://polygon-s3-policy.json \
  --query 'Policy.Arn' \
  --output text 2>/dev/null || \
  aws iam list-policies --query "Policies[?PolicyName=='$POLICY_NAME'].Arn" --output text)

# Attach the Polygon S3 access policy
aws iam attach-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-arn "$POLICY_ARN"

# Clean up
rm -f polygon-s3-policy.json

echo "Waiting for role to propagate... (30 seconds)"
sleep 30

echo "IAM role setup complete. Role ARN: $ROLE_ARN"
echo "You can now use this role ARN in your deploy-lambda.sh script." 