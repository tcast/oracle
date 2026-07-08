#!/bin/bash

# Script to run the migration from PostgreSQL to Timestream
# Make sure your .env file is configured with proper credentials

echo "Starting PostgreSQL to Timestream migration process..."

# Check if .env file exists
if [ ! -f ".env" ]; then
  echo "Error: .env file not found. Please create one with database credentials."
  exit 1
fi

# Load environment variables from .env file
export $(grep -v '^#' .env | xargs)

# Validate environment variables
if [ -z "$PG_HOST" ] || [ -z "$PG_DATABASE" ] || [ -z "$PG_USER" ] || [ -z "$PG_PASSWORD" ]; then
  echo "Error: Database connection variables missing in .env file."
  echo "Please ensure PG_HOST, PG_DATABASE, PG_USER, and PG_PASSWORD are set."
  exit 1
fi

if [ -z "$AWS_REGION" ]; then
  echo "AWS_REGION not set, using default us-east-1"
  export AWS_REGION="us-east-1"
fi

echo "Running migration script..."
node migrate-to-timestream.js

# Check if the script executed successfully
if [ $? -eq 0 ]; then
  echo "Migration completed successfully."
  
  echo "Would you like to run a test query to verify the migration? (y/n)"
  read -r response
  
  if [[ "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
    echo "Running test query..."
    node query-timestream.js
  fi
else
  echo "Migration failed. See error messages above."
fi 