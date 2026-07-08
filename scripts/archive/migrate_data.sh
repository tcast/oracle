#!/bin/bash
set -e

# Color codes for terminal output
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}==================================================${NC}"
echo -e "${BLUE}    Oracle Investment Screener - DB Migration      ${NC}"
echo -e "${BLUE}==================================================${NC}\n"

# Set RDS connection details
RDS_ENDPOINT="oracle-db.cyruxuioaadm.us-east-1.rds.amazonaws.com"
DB_USERNAME="postgres"
read -sp "Enter your RDS database password: " DB_PASSWORD
echo ""
DB_NAME="oracle"

# Create a directory for migration
MIGRATION_DIR="$HOME/db_migration"
mkdir -p "$MIGRATION_DIR"
DUMP_FILE="$MIGRATION_DIR/oracle_full_dump.sql"

# Export local database
echo -e "\n${YELLOW}Exporting local database...${NC}"
pg_dump -h localhost -U postgres -d oracle > "$DUMP_FILE"
echo -e "${GREEN}✓ Local database exported to $DUMP_FILE${NC}\n"

# Drop all tables in RDS
echo -e "${YELLOW}Dropping all existing tables in RDS database...${NC}"
cat > "$MIGRATION_DIR/drop_all_tables.sql" << 'EOL'
DO $$ DECLARE
    r RECORD;
BEGIN
    -- Disable triggers
    FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'ALTER TABLE public.' || quote_ident(r.tablename) || ' DISABLE TRIGGER ALL';
    END LOOP;

    -- Drop all tables
    FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
    END LOOP;
END $$;
EOL

PGPASSWORD="$DB_PASSWORD" psql -h "$RDS_ENDPOINT" -U "$DB_USERNAME" -d "$DB_NAME" -f "$MIGRATION_DIR/drop_all_tables.sql"
echo -e "${GREEN}✓ All existing tables dropped from RDS database${NC}\n"

# Import database to RDS
echo -e "${YELLOW}Importing database to RDS...${NC}"
PGPASSWORD="$DB_PASSWORD" psql -h "$RDS_ENDPOINT" -U "$DB_USERNAME" -d "$DB_NAME" -f "$DUMP_FILE"
echo -e "${GREEN}✓ Database successfully imported to RDS${NC}\n"

# Create scraped_mentions table
echo -e "${YELLOW}Creating scraped_mentions table...${NC}"
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

PGPASSWORD="$DB_PASSWORD" psql -h "$RDS_ENDPOINT" -U "$DB_USERNAME" -d "$DB_NAME" -f "$MIGRATION_DIR/create_scraped_mentions.sql"
echo -e "${GREEN}✓ Scraped_mentions table created in RDS database${NC}\n"

# Update local environment
echo -e "${YELLOW}Updating .env file to use RDS...${NC}"
ENV_FILE="/Users/tcast/Documents/Sites/oracle/backend/.env"
cp "$ENV_FILE" "$ENV_FILE.local_backup"
NEW_DB_URL="postgresql://$DB_USERNAME:$DB_PASSWORD@$RDS_ENDPOINT:5432/$DB_NAME"
sed -i '' "s|DATABASE_URL=.*|DATABASE_URL=$NEW_DB_URL|g" "$ENV_FILE"
echo -e "${GREEN}✓ Updated .env file to use RDS database${NC}\n"

# Verify migration
echo -e "${YELLOW}Verifying migration...${NC}"
TABLE_COUNT=$(PGPASSWORD="$DB_PASSWORD" psql -h "$RDS_ENDPOINT" -U "$DB_USERNAME" -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public'")
TABLE_COUNT=$(echo $TABLE_COUNT | tr -d '[:space:]')
echo -e "Number of tables in RDS database: ${GREEN}$TABLE_COUNT${NC}"

SCRAPED_TABLE=$(PGPASSWORD="$DB_PASSWORD" psql -h "$RDS_ENDPOINT" -U "$DB_USERNAME" -d "$DB_NAME" -t -c "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'scraped_mentions')")
SCRAPED_TABLE=$(echo $SCRAPED_TABLE | tr -d '[:space:]')
echo -e "Scraped_mentions table exists: ${GREEN}$SCRAPED_TABLE${NC}\n"

echo -e "${BLUE}==================================================${NC}"
echo -e "${BLUE}             Migration Complete!                  ${NC}"
echo -e "${BLUE}==================================================${NC}\n"

echo -e "${GREEN}Your application is now configured to use RDS at:${NC}"
echo "$RDS_ENDPOINT"