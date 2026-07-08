#!/bin/bash
set -e

# =====================================================================
# Oracle Investment Screener - RDS Setup and Migration Script
# =====================================================================

# Color codes for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Print a formatted header
echo -e "${BLUE}==================================================${NC}"
echo -e "${BLUE}   Oracle Investment Screener - RDS Setup Script   ${NC}"
echo -e "${BLUE}==================================================${NC}\n"

# ---------------------------------------------------------------------
# PART 1: AWS Authentication
# ---------------------------------------------------------------------
echo -e "${YELLOW}STEP 1: Checking AWS credentials${NC}"

# Check for AWS CLI installation
if ! command -v aws &> /dev/null; then
    echo -e "${RED}AWS CLI is not installed. Please install it first:${NC}"
    echo "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
    exit 1
fi

# Check AWS credentials
if ! aws sts get-caller-identity &> /dev/null; then
    echo -e "${RED}AWS credentials not configured or invalid.${NC}"
    echo "Please run 'aws configure' first to set up your credentials."
    exit 1
fi

# Get AWS account details
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
AWS_REGION=$(aws configure get region)
if [ -z "$AWS_REGION" ]; then
    echo -e "${YELLOW}AWS region not set. Using us-east-1 as default.${NC}"
    AWS_REGION="us-east-1"
fi

echo -e "${GREEN}✓ Authenticated with AWS Account: ${AWS_ACCOUNT_ID} in region: ${AWS_REGION}${NC}\n"

# ---------------------------------------------------------------------
# PART 2: Database Configuration
# ---------------------------------------------------------------------
echo -e "${YELLOW}STEP 2: Setting up database configuration${NC}"

# Database configuration
DB_INSTANCE_ID="oracle-db"
DB_USERNAME="postgres"
read -sp "Enter a password for the RDS PostgreSQL database: " DB_PASSWORD
echo ""
DB_NAME="oracle"
DB_CLASS="db.m5.large"  # 2 vCPU, 8 GB RAM - good balance for scraping workloads
STORAGE_SIZE=100  # 100 GB

echo "Using the following configuration:"
echo " - Instance Type: $DB_CLASS (2 vCPU, 8 GB RAM)"
echo " - Storage: $STORAGE_SIZE GB"
echo " - Database Name: $DB_NAME"
echo " - Username: $DB_USERNAME"
echo -e " - Region: $AWS_REGION\n"

# ---------------------------------------------------------------------
# PART 3: Create RDS Instance
# ---------------------------------------------------------------------
echo -e "${YELLOW}STEP 3: Creating RDS PostgreSQL instance${NC}"

# Create the RDS instance (using default VPC and subnet group)
aws rds create-db-instance \
    --db-instance-identifier "$DB_INSTANCE_ID" \
    --db-instance-class "$DB_CLASS" \
    --engine postgres \
    --engine-version 14.12 \
    --allocated-storage "$STORAGE_SIZE" \
    --master-username "$DB_USERNAME" \
    --master-user-password "$DB_PASSWORD" \
    --db-name "$DB_NAME" \
    --publicly-accessible \
    --backup-retention-period 7 \
    --port 5432 \
    --no-multi-az \
    --storage-type gp2

echo -e "${YELLOW}RDS instance creation initiated. Waiting for the instance to be available...${NC}"
echo "This will take 5-10 minutes. You'll see progress updates."

# Wait for the RDS instance to be available with progress updates
while true; do
    STATUS=$(aws rds describe-db-instances \
        --db-instance-identifier "$DB_INSTANCE_ID" \
        --query "DBInstances[0].DBInstanceStatus" \
        --output text)
    
    PERCENT=$(aws rds describe-db-instances \
        --db-instance-identifier "$DB_INSTANCE_ID" \
        --query "DBInstances[0].PercentProgress" \
        --output text)
    
    echo -e "\rCurrent status: $STATUS - Progress: $PERCENT%" 
    
    if [ "$STATUS" == "available" ]; then
        break
    fi
    
    sleep 30
done

# Get the RDS endpoint
RDS_ENDPOINT=$(aws rds describe-db-instances \
    --db-instance-identifier "$DB_INSTANCE_ID" \
    --query "DBInstances[0].Endpoint.Address" \
    --output text)

echo -e "\n${GREEN}✓ RDS instance is now available at: $RDS_ENDPOINT${NC}\n"

# ---------------------------------------------------------------------
# PART 4: Configure RDS Security Group for Access
# ---------------------------------------------------------------------
echo -e "${YELLOW}STEP 4: Getting RDS security group information${NC}"

# Get the security group ID of the RDS instance
SG_ID=$(aws rds describe-db-instances \
    --db-instance-identifier "$DB_INSTANCE_ID" \
    --query "DBInstances[0].VpcSecurityGroups[0].VpcSecurityGroupId" \
    --output text)

echo "RDS instance is using security group: $SG_ID"
echo -e "${YELLOW}You will need to ask your AWS administrator to add an inbound rule to this security group${NC}"
echo -e "${YELLOW}to allow PostgreSQL access (port 5432) from your IP address.${NC}\n"

# Get current IP for access
MY_IP=$(curl -s https://checkip.amazonaws.com)
echo -e "Your current IP address is: ${GREEN}$MY_IP${NC}"
echo -e "Ask your administrator to add: ${GREEN}PostgreSQL (5432) from $MY_IP/32${NC}\n"

# ---------------------------------------------------------------------
# PART 5: Export Local Database
# ---------------------------------------------------------------------
echo -e "${YELLOW}STEP 5: Exporting local database${NC}"

# Create a directory for the database dump
MIGRATION_DIR="$HOME/db_migration"
mkdir -p "$MIGRATION_DIR"

# Check if pg_dump is installed
if ! command -v pg_dump &> /dev/null; then
    echo -e "${RED}pg_dump command not found. Please install PostgreSQL client tools.${NC}"
    exit 1
fi

# Export the database schema and data
echo "Exporting local database to $MIGRATION_DIR/oracle_dump.sql..."
pg_dump -h localhost -U postgres -d oracle -F c -f "$MIGRATION_DIR/oracle_dump.sql"

echo -e "${GREEN}✓ Local database exported to $MIGRATION_DIR/oracle_dump.sql${NC}\n"

# ---------------------------------------------------------------------
# PART 6: Import Database to RDS
# ---------------------------------------------------------------------
echo -e "${YELLOW}STEP 6: Importing database to RDS${NC}"

# Check if pg_restore is installed
if ! command -v pg_restore &> /dev/null; then
    echo -e "${RED}pg_restore command not found. Please install PostgreSQL client tools.${NC}"
    exit 1
fi

echo -e "${YELLOW}IMPORTANT: Before proceeding, ensure your AWS administrator has added the security group rule.${NC}"
read -p "Has the security group been updated to allow access from your IP? (y/n): " SG_UPDATED

if [ "$SG_UPDATED" != "y" ]; then
    echo -e "${RED}Please have your AWS administrator update the security group before continuing.${NC}"
    echo "Security Group ID: $SG_ID"
    echo "Your IP: $MY_IP"
    exit 1
fi

echo "Restoring database to RDS. This may take a few minutes..."
PGPASSWORD="$DB_PASSWORD" pg_restore -h "$RDS_ENDPOINT" -U "$DB_USERNAME" -d "$DB_NAME" -v "$MIGRATION_DIR/oracle_dump.sql"

echo -e "${GREEN}✓ Database successfully imported to RDS${NC}\n"

# ---------------------------------------------------------------------
# PART 7: Create Scraped_Mentions Table
# ---------------------------------------------------------------------
echo -e "${YELLOW}STEP 7: Creating scraped_mentions table${NC}"

# Create a temporary SQL file
cat > "$MIGRATION_DIR/create_scraped_mentions.sql" << 'EOL'
CREATE TABLE IF NOT EXISTS scraped_mentions (
  id SERIAL PRIMARY KEY,
  symbol VARCHAR(10) NOT NULL,
  type VARCHAR(30) NOT NULL,
  platform VARCHAR(30) NOT NULL,
  url TEXT,
  title TEXT,
  content TEXT NOT NULL,
  sentiment FLOAT,
  author VARCHAR(100),
  follower_count INTEGER,
  upvotes INTEGER,
  source_created_at TIMESTAMP,
  source_id VARCHAR(100),
  scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform, source_id)
);

CREATE INDEX IF NOT EXISTS idx_mentions_symbol ON scraped_mentions(symbol);
CREATE INDEX IF NOT EXISTS idx_mentions_platform ON scraped_mentions(platform);
CREATE INDEX IF NOT EXISTS idx_mentions_scrape_date ON scraped_mentions(scraped_at);
EOL

# Execute the SQL
PGPASSWORD="$DB_PASSWORD" psql -h "$RDS_ENDPOINT" -U "$DB_USERNAME" -d "$DB_NAME" -f "$MIGRATION_DIR/create_scraped_mentions.sql"

echo -e "${GREEN}✓ Scraped_mentions table created in RDS database${NC}\n"

# ---------------------------------------------------------------------
# PART 8: Update Local Environment
# ---------------------------------------------------------------------
echo -e "${YELLOW}STEP 8: Updating local environment to use RDS${NC}"

# Path to the .env file
ENV_FILE="/Users/tcast/Documents/Sites/oracle/backend/.env"

# Backup current .env file
cp "$ENV_FILE" "$ENV_FILE.local_backup"
echo "Created backup of .env file at: $ENV_FILE.local_backup"

# Update DATABASE_URL in .env file
NEW_DB_URL="postgresql://$DB_USERNAME:$DB_PASSWORD@$RDS_ENDPOINT:5432/$DB_NAME"
sed -i '' "s|DATABASE_URL=.*|DATABASE_URL=$NEW_DB_URL|g" "$ENV_FILE"

echo -e "${GREEN}✓ Updated .env file to use RDS database${NC}\n"

# ---------------------------------------------------------------------
# PART 9: Test Connection
# ---------------------------------------------------------------------
echo -e "${YELLOW}STEP 9: Testing connection to RDS${NC}"

# Create a temporary test script
cat > "$MIGRATION_DIR/test_rds_connection.js" << EOL
const { Pool } = require('pg');
require('dotenv').config({ path: '$ENV_FILE' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
});

async function testConnection() {
  try {
    const client = await pool.connect();
    console.log('Connected to RDS successfully!');
    
    const timeResult = await client.query('SELECT NOW()');
    console.log('Current time on server:', timeResult.rows[0].now);
    
    const tableCountResult = await client.query("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public'");
    console.log('Number of tables in database:', tableCountResult.rows[0].count);
    
    client.release();
  } catch (err) {
    console.error('Error connecting to RDS:', err);
  } finally {
    await pool.end();
  }
}

testConnection();
EOL

# Run the test script
cd /Users/tcast/Documents/Sites/oracle/backend
node "$MIGRATION_DIR/test_rds_connection.js"

# ---------------------------------------------------------------------
# PART 10: Summary
# ---------------------------------------------------------------------
echo -e "\n${BLUE}==================================================${NC}"
echo -e "${BLUE}                 Setup Complete!                  ${NC}"
echo -e "${BLUE}==================================================${NC}\n"

echo -e "${GREEN}RDS Instance Details:${NC}"
echo " - Endpoint: $RDS_ENDPOINT"
echo " - Database: $DB_NAME"
echo " - Username: $DB_USERNAME"
echo " - Instance Class: $DB_CLASS"
echo " - Storage: $STORAGE_SIZE GB"
echo " - Security Group ID: $SG_ID"

echo -e "\n${YELLOW}Next Steps:${NC}"
echo " 1. Setup AWS Lambda with appropriate IAM roles to access this RDS instance"
echo " 2. Run the Lambda setup script"
echo " 3. Test the Lambda functions by invoking the coordinator function"
echo " 4. Check the RDS database for scraped data"

echo -e "\n${YELLOW}Clean Up (if needed):${NC}"
echo " - To delete the RDS instance: aws rds delete-db-instance --db-instance-identifier $DB_INSTANCE_ID --skip-final-snapshot"

echo -e "\n${GREEN}Migration completed successfully!${NC}"