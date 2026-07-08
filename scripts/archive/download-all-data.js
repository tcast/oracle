/**
 * Polygon.io Flat File Downloader for Full Range
 * 
 * Downloads stock data files from January 2024 to March 2025
 */
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const os = require('os');
const stream = require('stream');
const { promisify } = require('util');
const pipeline = promisify(stream.pipeline);

// S3 Configuration
const POLYGON_S3_CONFIG = {
  credentials: {
    accessKeyId: '18972b38-e2dd-40cf-bb10-f3eede60c8c4',
    secretAccessKey: 'GamH9ewSNWT6BeUM19cdtlCzyNCfVHWx'
  },
  endpoint: 'https://files.polygon.io',
  region: 'us-east-1',
  forcePathStyle: true
};

// Bucket name
const BUCKET_NAME = 'flatfiles';

// Base path for stock data
const BASE_PATH = 'us_stocks_sip/day_aggs_v1';

// Local download directory
const DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads', 'polygon');

// Date range parameters
const START_DATE = '2024-01-01';
const END_DATE = '2025-03-13'; // Current date

// Log file for tracking
const LOG_FILE = path.join(os.homedir(), 'Downloads', 'polygon-download.log');
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

// Initialize S3 client
const s3Client = new S3Client(POLYGON_S3_CONFIG);

// Ensure download directory exists
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  log(`Created download directory: ${DOWNLOAD_DIR}`);
}

// Log function that writes to both console and file
function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;
  
  console.log(logMessage);
  logStream.write(logMessage + '\n');
}

/**
 * Generate a list of dates in the format YYYY-MM-DD
 */
function generateDateRange(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new Error('Invalid date format. Please use YYYY-MM-DD');
  }
  
  if (start > end) {
    throw new Error('Start date must be before end date');
  }
  
  const dates = [];
  const current = new Date(start);
  
  while (current <= end) {
    const year = current.getFullYear();
    const month = String(current.getMonth() + 1).padStart(2, '0');
    const day = String(current.getDate()).padStart(2, '0');
    dates.push(`${year}-${month}-${day}`);
    
    // Move to next day
    current.setDate(current.getDate() + 1);
  }
  
  return dates;
}

/**
 * Download a file from S3
 */
async function downloadFile(key) {
  try {
    log(`Downloading: ${key}`);
    
    // Create the local file path
    const localPath = path.join(DOWNLOAD_DIR, key);
    const localDir = path.dirname(localPath);
    
    // Create directory if it doesn't exist
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    
    // Check if file already exists and has content
    if (fs.existsSync(localPath)) {
      const stats = fs.statSync(localPath);
      if (stats.size > 0) {
        log(`File already exists with size ${stats.size} bytes: ${localPath}`);
        return { success: true, path: localPath, skipped: true };
      } else {
        log(`File exists but is empty, re-downloading: ${localPath}`);
      }
    }
    
    // Download the file
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key
    });
    
    const { Body } = await s3Client.send(command);
    
    // Stream to file
    await pipeline(Body, fs.createWriteStream(localPath));
    
    // Verify the file was downloaded correctly
    const fileStats = fs.statSync(localPath);
    log(`Successfully downloaded: ${localPath} (${fileStats.size} bytes)`);
    
    return { success: true, path: localPath, skipped: false };
  } catch (error) {
    log(`Error downloading ${key}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Check file for a specific date
 */
async function getFileForDate(date) {
  try {
    const [year, month, day] = date.split('-');
    const key = `${BASE_PATH}/${year}/${month}/${date}.csv.gz`;
    
    log(`Checking file: ${key}`);
    
    return key;
  } catch (error) {
    log(`Error checking file for ${date}: ${error.message}`);
    return null;
  }
}

/**
 * Process a batch of dates (for chunking large requests)
 */
async function processDateBatch(dates, batchIndex, totalBatches) {
  log(`Processing batch ${batchIndex + 1}/${totalBatches} with ${dates.length} dates`);
  
  // Stats
  const stats = {
    total: dates.length,
    success: 0,
    failed: 0,
    skipped: 0
  };
  
  // Process each date
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const overallIndex = (batchIndex * dates.length) + i + 1;
    log(`[${overallIndex}] Processing date: ${date}`);
    
    // Check for file
    const fileKey = await getFileForDate(date);
    
    if (fileKey) {
      // Download the file
      const result = await downloadFile(fileKey);
      
      if (result.success) {
        if (result.skipped) {
          stats.skipped++;
        } else {
          stats.success++;
        }
      } else {
        stats.failed++;
      }
    } else {
      log(`No file found for date: ${date}`);
      stats.failed++;
    }
    
    // Add a small delay to avoid overwhelming the API
    if (i < dates.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  return stats;
}

/**
 * Test S3 connection
 */
async function testConnection() {
  try {
    log('Testing connection to Polygon.io...');
    
    // Try listing the base directory
    const command = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: BASE_PATH,
      Delimiter: '/',
      MaxKeys: 5
    });
    
    const response = await s3Client.send(command);
    
    if (response.CommonPrefixes && response.CommonPrefixes.length > 0) {
      log('Available years:');
      response.CommonPrefixes.forEach(prefix => {
        log(`- ${prefix.Prefix.split('/').slice(-2, -1)[0]}`);
      });
      return true;
    } else {
      log('No data found. Check your credentials and connection.');
      return false;
    }
  } catch (error) {
    log(`Connection test failed: ${error.message}`);
    return false;
  }
}

/**
 * Main function
 */
async function main() {
  try {
    log('===== Polygon.io Full Date Range Downloader =====');
    log(`Download directory: ${DOWNLOAD_DIR}`);
    log(`Date range: ${START_DATE} to ${END_DATE}`);
    log(`Log file: ${LOG_FILE}`);
    
    // Test connection first
    const connectionOk = await testConnection();
    
    if (!connectionOk) {
      log('Connection test failed. Aborting.');
      logStream.end();
      process.exit(1);
    }
    
    // Generate the full date range
    const allDates = generateDateRange(START_DATE, END_DATE);
    log(`Total dates to process: ${allDates.length}`);
    
    // Process in batches to avoid memory issues with very large ranges
    const BATCH_SIZE = 30; // Process 30 days at a time
    const batches = [];
    
    for (let i = 0; i < allDates.length; i += BATCH_SIZE) {
      batches.push(allDates.slice(i, i + BATCH_SIZE));
    }
    
    log(`Split into ${batches.length} batches of ~${BATCH_SIZE} days each`);
    
    // Overall stats
    const overallStats = {
      total: allDates.length,
      success: 0,
      failed: 0,
      skipped: 0
    };
    
    // Process each batch
    for (let i = 0; i < batches.length; i++) {
      const batchStats = await processDateBatch(batches[i], i, batches.length);
      
      // Update overall stats
      overallStats.success += batchStats.success;
      overallStats.failed += batchStats.failed;
      overallStats.skipped += batchStats.skipped;
      
      // Log interim results
      log(`\n----- Batch ${i + 1}/${batches.length} Complete -----`);
      log(`Success: ${batchStats.success}, Failed: ${batchStats.failed}, Skipped: ${batchStats.skipped}`);
      log(`Overall progress: ${Math.round(((i + 1) / batches.length) * 100)}%`);
      
      // Add a delay between batches
      if (i < batches.length - 1) {
        log('Pausing between batches...');
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
    
    // Print summary
    log('\n===== Download Summary =====');
    log(`Total dates processed: ${overallStats.total}`);
    log(`Successfully downloaded: ${overallStats.success}`);
    log(`Failed: ${overallStats.failed}`);
    log(`Skipped (already exists): ${overallStats.skipped}`);
    log(`Files saved to: ${DOWNLOAD_DIR}`);
    log('============================');
    
  } catch (error) {
    log(`Error: ${error.message}`);
    log(error.stack);
  } finally {
    // Close the log file
    logStream.end();
  }
}

// Run the script
main();