/**
 * Polygon.io Historical Data Downloader (2003-2023)
 * 
 * Downloads historical stock data for a 20+ year period
 * With resume capability and year-by-year processing
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

// Log file
const LOG_FILE = path.join(DOWNLOAD_DIR, 'polygon-historical-download.log');
const ERROR_LOG = path.join(DOWNLOAD_DIR, 'polygon-historical-errors.log');
const PROGRESS_FILE = path.join(DOWNLOAD_DIR, 'download-progress.json');

// Date range parameters
const START_YEAR = 2003;
const END_YEAR = 2023;

// Initialize S3 client
const s3Client = new S3Client(POLYGON_S3_CONFIG);

// Ensure download directory exists
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  console.log(`Created download directory: ${DOWNLOAD_DIR}`);
}

// Initialize log file stream
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
const errorStream = fs.createWriteStream(ERROR_LOG, { flags: 'a' });

// Log function that writes to both console and file
function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;
  
  console.log(logMessage);
  logStream.write(logMessage + '\\n');
}

// Error logging
function logError(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;
  
  console.error(logMessage);
  errorStream.write(logMessage + '\\n');
}

/**
 * Load download progress to enable resuming
 */
function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const data = fs.readFileSync(PROGRESS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    log(`Error loading progress file: ${error.message}`);
  }
  
  // Default structure
  return {
    lastCompletedYear: null,
    lastCompletedMonth: null,
    stats: {
      total: 0,
      success: 0,
      failed: 0,
      skipped: 0
    }
  };
}

/**
 * Save download progress
 */
function saveProgress(progress) {
  try {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
  } catch (error) {
    logError(`Error saving progress: ${error.message}`);
  }
}

/**
 * Generate a list of months to process for a year
 */
function getMonthsToProcess(year, lastCompletedMonth) {
  const months = [];
  // Start month is 1 (January) unless it's a partial year resume
  let startMonth = 1;
  
  if (year.toString() === lastCompletedMonth?.substring(0, 4)) {
    // If we have a lastCompletedMonth for this year, start from the next month
    startMonth = parseInt(lastCompletedMonth.substring(5, 7), 10) + 1;
  }
  
  for (let month = startMonth; month <= 12; month++) {
    months.push(`${year}-${month.toString().padStart(2, '0')}`);
  }
  
  return months;
}

/**
 * Get trading days for a specific month
 * This is an estimation that excludes weekends but doesn't 
 * account for holidays - we'll let the file check handle that
 */
function getTradingDaysForMonth(yearMonth) {
  const [year, month] = yearMonth.split('-').map(num => parseInt(num, 10));
  const daysInMonth = new Date(year, month, 0).getDate();
  const days = [];
  
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month - 1, day);
    const dayOfWeek = date.getDay();
    
    // Skip weekends (0 = Sunday, 6 = Saturday)
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      const formattedDay = day.toString().padStart(2, '0');
      days.push(`${year}-${month.toString().padStart(2, '0')}-${formattedDay}`);
    }
  }
  
  return days;
}

/**
 * Download a file from S3
 */
async function downloadFile(key) {
  try {
    // Create the local file path
    const localPath = path.join(DOWNLOAD_DIR, key);
    const localDir = path.dirname(localPath);
    
    // Check if file already exists
    if (fs.existsSync(localPath)) {
      const stats = fs.statSync(localPath);
      if (stats.size > 0) {
        log(`File already exists: ${localPath} (${stats.size} bytes)`);
        return { success: true, path: localPath, skipped: true };
      }
    }
    
    // Create directory if it doesn't exist
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    
    log(`Downloading: ${key}`);
    
    // Download the file
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key
    });
    
    const { Body } = await s3Client.send(command);
    
    // Stream to file
    await pipeline(Body, fs.createWriteStream(localPath));
    
    // Verify file size
    const fileStats = fs.statSync(localPath);
    log(`Downloaded: ${localPath} (${fileStats.size} bytes)`);
    
    return { success: true, path: localPath, skipped: false };
  } catch (error) {
    logError(`Error downloading ${key}: ${error.message}`);
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
    
    log(`Checking for: ${key}`);
    
    return key;
  } catch (error) {
    logError(`Error getting file key for ${date}: ${error.message}`);
    return null;
  }
}

/**
 * Process a single month
 */
async function processMonth(yearMonth) {
  log(`Processing month: ${yearMonth}`);
  
  // Get trading days for this month
  const days = getTradingDaysForMonth(yearMonth);
  log(`Found ${days.length} potential trading days in ${yearMonth}`);
  
  // Stats for this month
  const stats = {
    total: days.length,
    success: 0,
    failed: 0,
    skipped: 0
  };
  
  // Process each trading day
  for (let i = 0; i < days.length; i++) {
    const date = days[i];
    log(`[${i+1}/${days.length}] Processing: ${date}`);
    
    // Get file key for this date
    const fileKey = await getFileForDate(date);
    
    if (fileKey) {
      // Try to download the file
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
      
      // Small delay to avoid overwhelming the API
      await new Promise(resolve => setTimeout(resolve, 100));
    } else {
      stats.failed++;
    }
  }
  
  return stats;
}

/**
 * Process a year
 */
async function processYear(year, progress) {
  log(`==== Processing Year: ${year} ====`);
  
  // Get months to process
  const months = getMonthsToProcess(year, progress.lastCompletedMonth);
  log(`Found ${months.length} months to process for ${year}`);
  
  // Year stats
  const yearStats = {
    total: 0,
    success: 0,
    failed: 0,
    skipped: 0
  };
  
  // Process each month
  for (let i = 0; i < months.length; i++) {
    const month = months[i];
    log(`[${i+1}/${months.length}] Processing month: ${month}`);
    
    // Process this month
    const monthStats = await processMonth(month);
    
    // Update year stats
    yearStats.total += monthStats.total;
    yearStats.success += monthStats.success;
    yearStats.failed += monthStats.failed;
    yearStats.skipped += monthStats.skipped;
    
    // Update progress
    progress.lastCompletedMonth = month;
    progress.stats.total += monthStats.total;
    progress.stats.success += monthStats.success;
    progress.stats.failed += monthStats.failed;
    progress.stats.skipped += monthStats.skipped;
    
    // Save progress
    saveProgress(progress);
    
    log(`Completed month ${month}: Success=${monthStats.success}, Failed=${monthStats.failed}, Skipped=${monthStats.skipped}`);
    
    // Add delay between months
    if (i < months.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  // Update progress for completed year
  progress.lastCompletedYear = year;
  progress.lastCompletedMonth = null; // Reset month for next year
  saveProgress(progress);
  
  log(`Completed year ${year}: Success=${yearStats.success}, Failed=${yearStats.failed}, Skipped=${yearStats.skipped}`);
  
  return yearStats;
}

/**
 * Test S3 connection
 */
async function testConnection() {
  try {
    log('Testing connection to Polygon.io S3...');
    
    // Try to list the base directory
    const command = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: BASE_PATH,
      Delimiter: '/',
      MaxKeys: 5
    });
    
    const response = await s3Client.send(command);
    
    if (response.CommonPrefixes && response.CommonPrefixes.length > 0) {
      log('Available years in S3:');
      response.CommonPrefixes.forEach(prefix => {
        log(`- ${prefix.Prefix.split('/').slice(-2, -1)[0]}`);
      });
      return true;
    }
    
    logError('No data found in base directory.');
    return false;
  } catch (error) {
    logError(`Connection test failed: ${error.message}`);
    return false;
  }
}

/**
 * Main function
 */
async function main() {
  try {
    log('===== Polygon.io Historical Data Downloader (2003-2023) =====');
    log(`Download directory: ${DOWNLOAD_DIR}`);
    log(`Date range: ${START_YEAR} to ${END_YEAR}`);
    log(`Log file: ${LOG_FILE}`);
    log(`Error log: ${ERROR_LOG}`);
    
    // Test connection
    const connectionOk = await testConnection();
    
    if (!connectionOk) {
      log('Connection test failed. Aborting.');
      logStream.end();
      errorStream.end();
      process.exit(1);
      return;
    }
    
    // Load progress for resuming
    const progress = loadProgress();
    log(`Loaded progress: Last completed year=${progress.lastCompletedYear || 'None'}, Last completed month=${progress.lastCompletedMonth || 'None'}`);
    
    // Determine years to process
    let yearsToProcess = [];
    for (let year = START_YEAR; year <= END_YEAR; year++) {
      yearsToProcess.push(year);
    }
    
    // Filter out already completed years if resuming
    if (progress.lastCompletedYear) {
      yearsToProcess = yearsToProcess.filter(year => year > progress.lastCompletedYear);
      log(`Resuming from year ${yearsToProcess[0]}`);
    }
    
    log(`Processing ${yearsToProcess.length} years: ${yearsToProcess.join(', ')}`);
    
    // Process each year
    for (let i = 0; i < yearsToProcess.length; i++) {
      const year = yearsToProcess[i];
      log(`\n[${i+1}/${yearsToProcess.length}] Processing Year: ${year}`);
      
      await processYear(year, progress);
      
      // Add delay between years
      if (i < yearsToProcess.length - 1) {
        log('Pausing between years...');
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
    
    // Print final summary
    log('\n===== Download Summary =====');
    log(`Years processed: ${yearsToProcess.length}`);
    log(`Total dates processed: ${progress.stats.total}`);
    log(`Successfully downloaded: ${progress.stats.success}`);
    log(`Failed: ${progress.stats.failed}`);
    log(`Skipped (already exists): ${progress.stats.skipped}`);
    log(`Files saved to: ${DOWNLOAD_DIR}`);
    log('=============================');
    
  } catch (error) {
    logError(`Fatal error: ${error.message}`);
    logError(error.stack);
  } finally {
    // Close log files
    logStream.end();
    errorStream.end();
  }
}

// Run the script
main();