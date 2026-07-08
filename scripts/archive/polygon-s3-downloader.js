/**
 * Polygon.io Flat File Downloader using AWS S3 SDK
 */
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

// S3 Configuration from Polygon.io
const POLYGON_S3_CONFIG = {
  credentials: {
    accessKeyId: '18972b38-e2dd-40cf-bb10-f3eede60c8c4',
    secretAccessKey: 'GamH9ewSNWT6BeUM19cdtlCzyNCfVHWx'
  },
  endpoint: 'https://files.polygon.io',
  region: 'us-east-1', // Default region
  forcePathStyle: true
};

// Bucket name
const BUCKET_NAME = 'flatfiles';

// Base path for stock data
const BASE_PATH = 'us_stocks_sip/day_aggs_v1';

// Local download directory
const DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads', 'polygon');

// Ensure download directory exists
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  console.log(`Created directory: ${DOWNLOAD_DIR}`);
}

// Initialize S3 client
const s3Client = new S3Client(POLYGON_S3_CONFIG);

/**
 * List files for a specific date
 */
async function listFilesForDate(date) {
  try {
    const [year, month, day] = date.split('-');
    const prefix = `${BASE_PATH}/${year}/${month}/${date}`;
    
    console.log(`Listing files for prefix: ${prefix}`);
    
    const command = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: prefix,
      MaxKeys: 1000
    });
    
    const response = await s3Client.send(command);
    
    if (response.Contents && response.Contents.length > 0) {
      console.log(`Found ${response.Contents.length} files for ${date}`);
      return response.Contents.map(item => item.Key);
    } else {
      console.log(`No files found for ${date}`);
      return [];
    }
  } catch (error) {
    console.error(`Error listing files for ${date}:`, error.message);
    return [];
  }
}

/**
 * Download a file from S3
 */
async function downloadFile(s3Key) {
  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key
    });
    
    console.log(`Downloading file: ${s3Key}`);
    
    const response = await s3Client.send(command);
    
    // Create local file path based on S3 key
    const localPath = path.join(DOWNLOAD_DIR, s3Key);
    const localDir = path.dirname(localPath);
    
    // Ensure directory exists
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    
    // Stream the file data to disk
    if (response.Body instanceof Readable) {
      await pipeline(response.Body, fs.createWriteStream(localPath));
    } else {
      // Handle if Body is not a stream
      const bodyContents = await response.Body.transformToByteArray();
      fs.writeFileSync(localPath, Buffer.from(bodyContents));
    }
    
    console.log(`Successfully saved: ${localPath}`);
    return true;
  } catch (error) {
    console.error(`Error downloading file ${s3Key}:`, error.message);
    return false;
  }
}

/**
 * List root directory
 */
async function listRoot() {
  try {
    console.log('Listing root directory of bucket...');
    
    const command = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Delimiter: '/',
      MaxKeys: 100
    });
    
    const response = await s3Client.send(command);
    
    if (response.CommonPrefixes) {
      console.log('Root directories:');
      response.CommonPrefixes.forEach(prefix => {
        console.log(`- ${prefix.Prefix}`);
      });
    }
    
    if (response.Contents) {
      console.log('Root files:');
      response.Contents.forEach(item => {
        console.log(`- ${item.Key} (${item.Size} bytes)`);
      });
    }
    
    return true;
  } catch (error) {
    console.error('Error listing root directory:', error.message);
    return false;
  }
}

/**
 * Test connection by listing the parent directory structure
 */
async function testConnection() {
  try {
    console.log('===== Testing Connection to Polygon.io S3 =====');
    
    // First, try listing the root
    await listRoot();
    
    // Next, try listing the base directory
    console.log(`\nListing base directory: ${BASE_PATH}`);
    const command = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: BASE_PATH,
      Delimiter: '/',
      MaxKeys: 10
    });
    
    const response = await s3Client.send(command);
    
    if (response.CommonPrefixes && response.CommonPrefixes.length > 0) {
      console.log('Years available:');
      response.CommonPrefixes.forEach(prefix => {
        console.log(`- ${prefix.Prefix.replace(BASE_PATH + '/', '')}`);
      });
      return true;
    } else {
      console.log('No data found in base directory');
      return false;
    }
  } catch (error) {
    console.error('Connection test failed:', error.message);
    console.error(error.stack);
    return false;
  }
}

/**
 * Generate dates for the given range
 */
function generateDateRange(startDate, endDate) {
  const dates = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  
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
 * Process a date range
 */
async function processDateRange(startDate, endDate) {
  console.log(`Processing date range: ${startDate} to ${endDate}`);
  
  // Generate list of dates
  const dates = generateDateRange(startDate, endDate);
  console.log(`Generated ${dates.length} dates to process`);
  
  let totalFiles = 0;
  let downloadedFiles = 0;
  
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    console.log(`\n[${i + 1}/${dates.length}] Processing date: ${date}`);
    
    // List files for this date
    const files = await listFilesForDate(date);
    totalFiles += files.length;
    
    // Download each file
    for (let j = 0; j < files.length; j++) {
      const file = files[j];
      console.log(`Downloading file ${j + 1}/${files.length}: ${file}`);
      
      const success = await downloadFile(file);
      if (success) {
        downloadedFiles++;
      }
    }
    
    // Add a small delay between dates to avoid rate limiting
    if (i < dates.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  
  return {
    datesProcessed: dates.length,
    totalFiles,
    downloadedFiles
  };
}

/**
 * Main function
 */
async function main() {
  try {
    console.log('===== Polygon.io Flat File Downloader =====');
    
    // Get command line arguments
    const args = process.argv.slice(2);
    let startDate = '2024-01-01';
    let endDate = '2024-01-05';  // Default to a small range for testing
    
    if (args.length >= 1) startDate = args[0];
    if (args.length >= 2) endDate = args[1];
    
    console.log(`Download directory: ${DOWNLOAD_DIR}`);
    console.log(`Date range: ${startDate} to ${endDate}`);
    
    // Test connection first
    const connectionOk = await testConnection();
    
    if (!connectionOk) {
      console.log('Aborting due to connection test failure');
      process.exit(1);
    }
    
    // Process date range
    const result = await processDateRange(startDate, endDate);
    
    console.log('\n===== Download Summary =====');
    console.log(`Dates processed: ${result.datesProcessed}`);
    console.log(`Total files found: ${result.totalFiles}`);
    console.log(`Files downloaded: ${result.downloadedFiles}`);
    console.log(`Files saved to: ${DOWNLOAD_DIR}`);
    console.log('============================');
    
  } catch (error) {
    console.error(`Fatal error: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run the script
main();