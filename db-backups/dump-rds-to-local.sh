#!/bin/bash

# Database dump and restore script
# This script dumps the production RDS database and restores it to local PostgreSQL

# RDS Connection Details
RDS_HOST="oracle-db.cyruxuioaadm.us-east-1.rds.amazonaws.com"
RDS_DB="oracle"
RDS_USER="postgres"
RDS_PORT="5432"

# Local Connection Details
LOCAL_HOST="localhost"
LOCAL_DB="oracle"
LOCAL_USER="postgres"
LOCAL_PASSWORD="password"
LOCAL_PORT="5432"

# Backup file
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DUMP_FILE="oracle_rds_dump_${TIMESTAMP}.sql"

echo "🔵 Oracle Database Migration Script"
echo "===================================="
echo "From: RDS ($RDS_HOST)"
echo "To: Local PostgreSQL ($LOCAL_HOST)"
echo ""

# Check if RDS password is provided
if [ -z "$RDS_PASSWORD" ]; then
    echo "❌ Error: RDS_PASSWORD environment variable not set"
    echo "Usage: RDS_PASSWORD='your_password' ./dump-rds-to-local.sh"
    exit 1
fi

echo "📥 Step 1: Dumping RDS database..."
echo "This may take several minutes depending on database size..."

# Create dump from RDS
PGPASSWORD="$RDS_PASSWORD" pg_dump \
    -h "$RDS_HOST" \
    -p "$RDS_PORT" \
    -U "$RDS_USER" \
    -d "$RDS_DB" \
    --no-owner \
    --no-privileges \
    --verbose \
    -f "$DUMP_FILE"

if [ $? -ne 0 ]; then
    echo "❌ Error: Failed to dump RDS database"
    exit 1
fi

echo "✅ Database dumped successfully to: $DUMP_FILE"
echo "📊 Dump file size: $(du -h $DUMP_FILE | cut -f1)"
echo ""

echo "📤 Step 2: Restoring to local PostgreSQL..."

# First, drop and recreate the local database
echo "Dropping existing local database (if exists)..."
PGPASSWORD="$LOCAL_PASSWORD" psql \
    -h "$LOCAL_HOST" \
    -p "$LOCAL_PORT" \
    -U "$LOCAL_USER" \
    -d postgres \
    -c "DROP DATABASE IF EXISTS $LOCAL_DB;"

echo "Creating fresh local database..."
PGPASSWORD="$LOCAL_PASSWORD" psql \
    -h "$LOCAL_HOST" \
    -p "$LOCAL_PORT" \
    -U "$LOCAL_USER" \
    -d postgres \
    -c "CREATE DATABASE $LOCAL_DB;"

# Restore the dump to local database
echo "Restoring data to local database..."
PGPASSWORD="$LOCAL_PASSWORD" psql \
    -h "$LOCAL_HOST" \
    -p "$LOCAL_PORT" \
    -U "$LOCAL_USER" \
    -d "$LOCAL_DB" \
    -f "$DUMP_FILE"

if [ $? -ne 0 ]; then
    echo "❌ Error: Failed to restore to local database"
    exit 1
fi

echo "✅ Database restored successfully!"
echo ""

echo "📊 Step 3: Verifying restore..."

# Get table count
TABLE_COUNT=$(PGPASSWORD="$LOCAL_PASSWORD" psql \
    -h "$LOCAL_HOST" \
    -p "$LOCAL_PORT" \
    -U "$LOCAL_USER" \
    -d "$LOCAL_DB" \
    -t \
    -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';")

echo "Tables in local database: $TABLE_COUNT"

# Show some key tables
echo ""
echo "Key tables and row counts:"
PGPASSWORD="$LOCAL_PASSWORD" psql \
    -h "$LOCAL_HOST" \
    -p "$LOCAL_PORT" \
    -U "$LOCAL_USER" \
    -d "$LOCAL_DB" \
    -c "SELECT 
        schemaname,
        tablename,
        n_live_tup as row_count
    FROM pg_stat_user_tables 
    WHERE schemaname = 'public'
    ORDER BY n_live_tup DESC
    LIMIT 10;"

echo ""
echo "✅ Migration completed successfully!"
echo ""
echo "📝 Notes:"
echo "- Dump file saved as: $DUMP_FILE"
echo "- You can delete this file after verification"
echo "- Local database connection: postgresql://$LOCAL_USER:$LOCAL_PASSWORD@$LOCAL_HOST:$LOCAL_PORT/$LOCAL_DB"
echo ""
echo "🚀 Your local database is now a copy of production!"
