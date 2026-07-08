#!/bin/bash

# Script to add the Polygon S3 access policy to the existing IAM role

ROLE_NAME="lambda-timestream-role"
POLICY_NAME="PolygonS3AccessPolicy"

echo "Adding S3 access policy for Polygon data to role '$ROLE_NAME'..."

# Create policy document
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

# Try to create the policy, or get its ARN if it already exists
echo "Creating or finding policy '$POLICY_NAME'..."

# First check if the policy already exists
POLICY_ARN=$(aws iam list-policies --scope Local --query "Policies[?PolicyName=='$POLICY_NAME'].Arn" --output text)

if [ -z "$POLICY_ARN" ]; then
  # Policy doesn't exist, create it
  echo "Creating new policy '$POLICY_NAME'..."
  POLICY_ARN=$(aws iam create-policy \
    --policy-name "$POLICY_NAME" \
    --policy-document file://polygon-s3-policy.json \
    --query 'Policy.Arn' \
    --output text)
  
  if [ -z "$POLICY_ARN" ]; then
    echo "Failed to create policy. Check your IAM permissions."
    exit 1
  fi
  
  echo "Created policy with ARN: $POLICY_ARN"
else
  echo "Policy already exists with ARN: $POLICY_ARN"
fi

# Attach the policy to the role
echo "Attaching policy to role..."
aws iam attach-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-arn "$POLICY_ARN"

# Clean up
rm -f polygon-s3-policy.json

echo "S3 policy attachment complete!" 