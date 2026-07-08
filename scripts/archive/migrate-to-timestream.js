/**
 * Script to migrate data from PostgreSQL stock_prices table to Amazon Timestream
 * 
 * Prerequisites:
 * - npm install pg aws-sdk dotenv
 * - Create .env file with your database credentials
 */

require('dotenv').config();
const { Pool } = require('pg');
const AWS = require('aws-sdk');

// Configure AWS SDK
AWS.config.update({ region: process.env.AWS_REGION || 'us-east-1' });

// Initialize database connection
const pgPool = new Pool({
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  port: process.env.PG_PORT || 5432
});

// Initialize Timestream client
const timestream = new AWS.TimestreamWrite();

// Constants
const DATABASE_NAME = 'financial_data';
const TABLE_NAME = 'stock_prices';
const BATCH_SIZE = 100; // Timestream API limit is 100 records per request
const QUERY_BATCH_SIZE = 1000; // Number of records to fetch from PostgreSQL at once

// Convert PostgreSQL record to Timestream record format
function convertToTimestreamRecord(row) {
  // Convert timestamp to epoch milliseconds
  const timestamp = new Date(row.date).getTime();
  
  return {
    Dimensions: [
      { Name: 'symbol', Value: row.symbol },
      { Name: 'exchange', Value: row.exchange || 'UNKNOWN' }
    ],
    MeasureName: 'price_data',
    MeasureValues: [
      { Name: 'open', Value: row.open.toString(), Type: 'DOUBLE' },
      { Name: 'high', Value: row.high.toString(), Type: 'DOUBLE' },
      { Name: 'low', Value: row.low.toString(), Type: 'DOUBLE' },
      { Name: 'close', Value: row.close.toString(), Type: 'DOUBLE' },
      { Name: 'volume', Value: row.volume.toString(), Type: 'BIGINT' }
    ],
    Time: timestamp.toString(),
    TimeUnit: 'MILLISECONDS'
  };
}

// Write batch of records to Timestream
async function writeBatchToTimestream(records) {
  try {
    const params = {
      DatabaseName: DATABASE_NAME,
      TableName: TABLE_NAME,
      Records: records
    };
    
    await timestream.writeRecords(params).promise();
    return true;
  } catch (error) {
    console.error('Error writing to Timestream:', error);
    return false;
  }
}

// Main migration function
async function migrateData() {
  console.log('Starting migration from PostgreSQL to Timestream...');
  
  try {
    // Get total count for progress tracking
    const countResult = await pgPool.query('SELECT COUNT(*) FROM stock_prices');
    const totalRows = parseInt(countResult.rows[0].count);
    console.log(`Total rows to migrate: ${totalRows}`);
    
    // Variables for tracking progress
    let processedRows = 0;
    let timestreamBatch = [];
    let offset = 0;
    
    // Process in batches to avoid memory issues
    while (offset < totalRows) {
      console.log(`Fetching rows ${offset} to ${offset + QUERY_BATCH_SIZE}...`);
      
      const queryResult = await pgPool.query(
        'SELECT * FROM stock_prices ORDER BY date, symbol LIMIT $1 OFFSET $2',
        [QUERY_BATCH_SIZE, offset]
      );
      
      // Process each row
      for (const row of queryResult.rows) {
        // Convert to Timestream format
        const timestreamRecord = convertToTimestreamRecord(row);
        timestreamBatch.push(timestreamRecord);
        
        // If we've reached Timestream batch size, write to Timestream
        if (timestreamBatch.length >= BATCH_SIZE) {
          const success = await writeBatchToTimestream(timestreamBatch);
          if (success) {
            processedRows += timestreamBatch.length;
            console.log(`Migrated ${processedRows}/${totalRows} rows (${(processedRows / totalRows * 100).toFixed(2)}%)`);
          }
          timestreamBatch = [];
        }
      }
      
      // Update offset for next batch
      offset += QUERY_BATCH_SIZE;
    }
    
    // Write any remaining records
    if (timestreamBatch.length > 0) {
      const success = await writeBatchToTimestream(timestreamBatch);
      if (success) {
        processedRows += timestreamBatch.length;
      }
    }
    
    console.log(`Migration complete! Migrated ${processedRows}/${totalRows} rows.`);
  } catch (error) {
    console.error('Migration failed:', error);
  } finally {
    // Close PostgreSQL connection
    await pgPool.end();
  }
}

// Run the migration
migrateData(); 