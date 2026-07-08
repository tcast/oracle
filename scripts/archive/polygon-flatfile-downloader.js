/**
 * Polygon.io Flat File Downloader
 * 
 * Downloads historical stock data files from Polygon.io to a local directory
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

// Initialize S3 client
const s3Client = new S3Client(POLYGON_S3_CONFIG);

// Ensure download directory exists
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  console.log(`Created download directory: ${DOWNLOAD_DIR}`);
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
    console.log(`Downloading: ${key}`);
    
    // Create the local file path
    const localPath = path.join(DOWNLOAD_DIR, key);
    const localDir = path.dirname(localPath);
    
    // Create directory if it doesn't exist
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    
    // Download the file
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key
    });
    
    const { Body } = await s3Client.send(command);
    
    // Stream to file
    await pipeline(Body, fs.createWriteStream(localPath));
    
    console.log(`Successfully downloaded: ${localPath}`);
    return { success: true, path: localPath };
  } catch (error) {
    console.error(`Error downloading ${key}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Check if file exists for a specific date
 */
async function getFileForDate(date) {
  try {
    const [year, month, day] = date.split('-');
    const key = `${BASE_PATH}/${year}/${month}/${date}.csv.gz`;
    
    console.log(`Checking if file exists: ${key}`);
    
    return key;
  } catch (error) {
    console.error(`Error checking file for ${date}: ${error.message}`);
    return null;
  }
}

/**
 * Process a date range
 */
async function processDateRange(startDate, endDate) {
  console.log(`Processing date range: ${startDate} to ${endDate}`);
  
  // Generate date range
  const dates = generateDateRange(startDate, endDate);
  console.log(`Generated ${dates.length} dates to process`);
  
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
    console.log(`\n[${i+1}/${dates.length}] Processing date: ${date}`);
    
    // Check for file
    const fileKey = await getFileForDate(date);
    
    if (fileKey) {
      // Check if file already exists locally
      const localPath = path.join(DOWNLOAD_DIR, fileKey);
      
      if (fs.existsSync(localPath)) {
        console.log(`File already exists locally: ${localPath}`);
        stats.skipped++;
        continue;
      }
      
      // Download the file
      const result = await downloadFile(fileKey);
      
      if (result.success) {
        stats.success++;
      } else {
        stats.failed++;
      }
    } else {
      console.log(`No file found for date: ${date}`);
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
    console.log('Testing connection to Polygon.io...');
    
    // Try listing the base directory
    const command = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: BASE_PATH,
      Delimiter: '/',
      MaxKeys: 5
    });
    
    const response = await s3Client.send(command);
    
    if (response.CommonPrefixes && response.CommonPrefixes.length > 0) {
      console.log('Available years:');
      response.CommonPrefixes.forEach(prefix => {
        console.log(`- ${prefix.Prefix.split('/').slice(-2, -1)[0]}`);
      });
      return true;
    } else {
      console.error('No data found. Check your credentials and connection.');
      return false;
    }
  } catch (error) {
    console.error(`Connection test failed: ${error.message}`);
    return false;
  }
}

/**
 * Main function
 */
async function main() {
  try {
    console.log('===== Polygon.io Flat File Downloader =====');
    
    // Get command line arguments
    const args = process.argv.slice(2);
    let startDate = args[0] || '2024-01-01';
    let endDate = args[1] || '2024-01-05';
    
    console.log(`Download directory: ${DOWNLOAD_DIR}`);
    console.log(`Date range: ${startDate} to ${endDate}`);
    
    // Test connection first
    const connectionOk = await testConnection();
    
    if (!connectionOk) {
      console.error('Connection test failed. Aborting.');
      process.exit(1);
    }
    
    // Process the date range
    const stats = await processDateRange(startDate, endDate);
    
    // Print summary
    console.log('\n===== Download Summary =====');
    console.log(`Total dates: ${stats.total}`);
    console.log(`Successfully downloaded: ${stats.success}`);
    console.log(`Failed: ${stats.failed}`);
    console.log(`Skipped (already exists): ${stats.skipped}`);
    console.log(`Files saved to: ${DOWNLOAD_DIR}`);
    console.log('============================');
    
  } catch (error) {
    console.error(`Error: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

// Check for command line arguments
if (process.argv.length < 3) {
  console.log(`Usage: node ${path.basename(__filename)} [startDate] [endDate]`);
  console.log('Dates should be in YYYY-MM-DD format');
  console.log('Example: node polygon-flatfile-downloader.js 2024-01-01 2024-01-31');
}

// Run the script
main();