/**
 * Script to load historical stock data from Polygon flat files
 * and import it into Amazon Timestream
 */

const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { TimestreamWriteClient, WriteRecordsCommand } = require('@aws-sdk/client-timestream-write');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const stream = require('stream');

// Configure AWS Timestream SDK
const REGION = process.env.AWS_REGION || 'us-east-1';
const TIMESTREAM_DB = process.env.TIMESTREAM_DATABASE || 'oracle';
const TIMESTREAM_TABLE = process.env.TIMESTREAM_TABLE || 'stock_prices';
const timestreamClient = new TimestreamWriteClient({ region: REGION });

// Polygon Flat File S3 configuration
const POLYGON_S3_CONFIG = {
  region: 'us-east-1', // Default region
  endpoint: 'https://files.polygon.io',
  credentials: {
    accessKeyId: '18972b38-e2dd-40cf-bb10-f3eede60c8c4',
    secretAccessKey: 'GamH9ewSNWT6BeUM19cdtlCzyNCfVHWx'
  },
  forcePathStyle: true // Required for some S3-compatible services
};

const BUCKET_NAME = 'flatfiles';
const s3Client = new S3Client(POLYGON_S3_CONFIG);

// Progress tracking
const PROGRESS_FILE = 'polygon_flatfile_progress.json';

// Database configuration for retrieving symbols
let pool;

// Initialize PostgreSQL pool for getting stock symbols
const initializePool = () => {
  if (!pool) {
    pool = new Pool({
      user: process.env.DB_USER || 'postgres',
      host: process.env.DB_HOST || 'oracle-db.cyruxuioaadm.us-east-1.rds.amazonaws.com',
      database: process.env.DB_NAME || 'oracle',
      password: process.env.DB_PASSWORD || 'QnEv5TgRxC3LbH7Wd9Kp',
      port: process.env.DB_PORT || 5432,
      ssl: process.env.DB_REQUIRE_SSL === 'true' ? {
        rejectUnauthorized: false
      } : false
    });
    
    console.log('Database pool initialized');
  }
  return pool;
};

// Get active stock symbols from database
async function getStockSymbols() {
  const pool = await initializePool();
  const result = await pool.query(`
    SELECT symbol, type FROM stock_symbols 
    WHERE active = true 
    ORDER BY symbol
  `);
  
  return result.rows;
}

// Load progress from file if exists
function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const data = fs.readFileSync(PROGRESS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.warn('Could not load progress file:', error.message);
  }
  return { processedFiles: [], lastFileIndex: 0 };
}

// Save progress to file
function saveProgress(progress) {
  try {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), 'utf8');
  } catch (error) {
    console.error('Error saving progress:', error.message);
  }
}

// List available OHLC files in the bucket
async function listOHLCFiles(prefix = 'stocks/ohlc') {
  try {
    const command = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: prefix
    });
    
    const response = await s3Client.send(command);
    
    if (response.Contents && response.Contents.length > 0) {
      // Sort by last modified date to process older data first
      return response.Contents
        .filter(item => item.Key.endsWith('.csv')) // Only process CSV files
        .sort((a, b) => a.LastModified - b.LastModified)
        .map(item => item.Key);
    } else {
      console.log('No files found in the specified prefix');
      return [];
    }
  } catch (error) {
    console.error('Error listing files from S3:', error);
    return [];
  }
}

// Process a single file from S3
async function processFile(fileKey) {
  try {
    console.log(`Processing file: ${fileKey}`);
    
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileKey
    });
    
    const response = await s3Client.send(command);
    
    // We need to convert the ReadableStream to a stream we can process
    const streamToString = (stream) => {
      const chunks = [];
      return new Promise((resolve, reject) => {
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
    };
    
    const fileContent = await streamToString(response.Body);
    
    // Process the CSV content
    const lines = fileContent.split('\\n');
    const header = lines[0].split(',');
    
    // Columns we need to extract
    const dateIndex = header.indexOf('t');
    const openIndex = header.indexOf('o');
    const highIndex = header.indexOf('h');
    const lowIndex = header.indexOf('l');
    const closeIndex = header.indexOf('c');
    const volumeIndex = header.indexOf('v');
    const symbolIndex = header.indexOf('T');
    
    if (dateIndex === -1 || openIndex === -1 || highIndex === -1 ||
        lowIndex === -1 || closeIndex === -1 || volumeIndex === -1 || symbolIndex === -1) {
      console.error('Required columns missing in CSV file');
      return 0;
    }
    
    let records = [];
    let processedCount = 0;
    
    // Process data rows in batches
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i] || lines[i].trim() === '') continue;
      
      const values = lines[i].split(',');
      
      // Skip if we don't have enough columns
      if (values.length < Math.max(dateIndex, openIndex, highIndex, lowIndex, closeIndex, volumeIndex, symbolIndex) + 1) {
        continue;
      }
      
      const symbol = values[symbolIndex];
      const timestamp = values[dateIndex];
      
      // Convert to timestamp in milliseconds if needed (sometimes Polygon provides timestamps in different formats)
      let timeMs = timestamp;
      if (timestamp.length === 10) { // Seconds format
        timeMs = parseInt(timestamp) * 1000;
      } else if (timestamp.includes('-')) { // ISO format
        timeMs = new Date(timestamp).getTime();
      }
      
      // Create record for Timestream
      const record = {
        Dimensions: [
          { Name: 'symbol', Value: symbol },
          { Name: 'asset_type', Value: 'stock' }
        ],
        MeasureName: 'price_data',
        MeasureValues: [
          { Name: 'open', Value: values[openIndex], Type: 'DOUBLE' },
          { Name: 'high', Value: values[highIndex], Type: 'DOUBLE' },
          { Name: 'low', Value: values[lowIndex], Type: 'DOUBLE' },
          { Name: 'close', Value: values[closeIndex], Type: 'DOUBLE' },
          { Name: 'volume', Value: values[volumeIndex], Type: 'DOUBLE' },
        ],
        Time: timeMs.toString(),
        TimeUnit: 'MILLISECONDS'
      };
      
      records.push(record);
      
      // Write in batches of 100 (Timestream limit)
      if (records.length >= 100) {
        const result = await writeRecordsToTimestream(records);
        processedCount += result.processedCount;
        records = [];
      }
    }
    
    // Write any remaining records
    if (records.length > 0) {
      const result = await writeRecordsToTimestream(records);
      processedCount += result.processedCount;
    }
    
    console.log(`Processed ${processedCount} records from file ${fileKey}`);
    return processedCount;
  } catch (error) {
    console.error(`Error processing file ${fileKey}:`, error);
    return 0;
  }
}

// Write records to Timestream in batches (max 100 per write)
async function writeRecordsToTimestream(records) {
  if (!records || records.length === 0) {
    return { success: true, processedCount: 0 };
  }
  
  const results = {
    success: true,
    processedCount: 0,
    errors: []
  };
  
  try {
    const params = {
      DatabaseName: TIMESTREAM_DB,
      TableName: TIMESTREAM_TABLE,
      Records: records
    };
    
    const command = new WriteRecordsCommand(params);
    await timestreamClient.send(command);
    
    results.processedCount += records.length;
    console.log(`Successfully wrote batch of ${records.length} records to Timestream`);
  } catch (error) {
    console.error(`Error writing batch to Timestream:`, error);
    
    // Check for throttling and retry
    if (error.name === 'ThrottlingException' || error.name === 'RejectedRecordsException') {
      console.log('Timestream throttling detected, waiting before retry...');
      await sleep(2000);
      
      try {
        const params = {
          DatabaseName: TIMESTREAM_DB,
          TableName: TIMESTREAM_TABLE,
          Records: records
        };
        
        const command = new WriteRecordsCommand(params);
        await timestreamClient.send(command);
        
        results.processedCount += records.length;
        console.log(`Successfully wrote batch on retry`);
      } catch (retryError) {
        console.error(`Error on retry:`, retryError);
        results.success = false;
        results.errors.push(retryError.message);
      }
    } else {
      results.success = false;
      results.errors.push(error.message);
    }
  }
  
  return results;
}

// Sleep function for rate limiting
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Main function to process all flat files
async function processAllFiles() {
  try {
    console.log('Listing available OHLC files from Polygon S3 bucket...');
    const files = await listOHLCFiles();
    
    if (files.length === 0) {
      console.log('No files found to process');
      return { success: true, totalProcessed: 0 };
    }
    
    console.log(`Found ${files.length} files to process`);
    
    // Load progress from file
    const progress = loadProgress();
    console.log(`Loaded progress: ${progress.processedFiles.length} files already processed`);
    
    // Filter out already processed files
    const filesToProcess = files.filter(file => !progress.processedFiles.includes(file));
    console.log(`Remaining files to process: ${filesToProcess.length}`);
    
    let totalProcessed = 0;
    
    // Start from the last processed file if resuming
    const startIndex = Math.min(progress.lastFileIndex, filesToProcess.length - 1);
    if (startIndex > 0) {
      console.log(`Resuming from file index ${startIndex}`);
    }
    
    // Process each file
    for (let i = startIndex; i < filesToProcess.length; i++) {
      const fileKey = filesToProcess[i];
      
      // Process the file
      const processedCount = await processFile(fileKey);
      totalProcessed += processedCount;
      
      // Update progress
      progress.processedFiles.push(fileKey);
      progress.lastFileIndex = i + 1;
      saveProgress(progress);
      
      // Add a small delay between files to avoid rate limiting
      await sleep(1000);
    }
    
    console.log(`Total historical records processed: ${totalProcessed}`);
    return { success: true, totalProcessed };
  } catch (error) {
    console.error('Error in main process:', error);
    return { success: false, error: error.message };
  } finally {
    // Close the database connection
    if (pool) await pool.end();
  }
}

// Check if running as script or module
if (require.main === module) {
  // Load environment variables from .env file if present
  try {
    require('dotenv').config();
  } catch (e) {
    console.log('dotenv not found, using environment variables');
  }
  
  console.log('Starting Polygon flat file data load process...');
  processAllFiles()
    .then(result => {
      console.log('Process completed:', result);
      process.exit(0);
    })
    .catch(error => {
      console.error('Process failed:', error);
      process.exit(1);
    });
} else {
  // Export for use as a module
  module.exports = {
    processAllFiles,
    processFile,
    listOHLCFiles,
    writeRecordsToTimestream
  };
}