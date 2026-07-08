/**
 * Simple test for Polygon.io S3 access
 */
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const fs = require('fs');

// S3 Configuration from Polygon.io
const POLYGON_S3_CONFIG = {
  credentials: {
    accessKeyId: '18972b38-e2dd-40cf-bb10-f3eede60c8c4',
    secretAccessKey: 'GamH9ewSNWT6BeUM19cdtlCzyNCfVHWx'
  },
  endpoint: 'https://files.polygon.io',
  region: 'us-east-1',
  forcePathStyle: true
};

// Create log file
const logFile = fs.createWriteStream('polygon-s3-test.log', { flags: 'a' });

// Log function that writes to file
function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  
  // Write to file
  logFile.write(logMessage);
  
  // Also write to console
  console.log(message);
}

// Initialize S3 client
const s3Client = new S3Client(POLYGON_S3_CONFIG);

// Test listing the root of the bucket
async function testListBucket() {
  try {
    log('Testing connection to Polygon.io S3...');
    log('Attempting to list bucket contents...');
    
    const command = new ListObjectsV2Command({
      Bucket: 'flatfiles',
      MaxKeys: 10
    });
    
    log('Sending S3 ListObjectsV2 command...');
    const response = await s3Client.send(command);
    
    log('S3 list response received.');
    log(`Found ${response.Contents?.length || 0} items.`);
    
    if (response.Contents && response.Contents.length > 0) {
      log('First 10 items:');
      response.Contents.forEach(item => {
        log(`- ${item.Key} (${item.Size} bytes, Last Modified: ${item.LastModified})`);
      });
    }
    
    return true;
  } catch (error) {
    log(`Error: ${error.message}`);
    log(`Error stack: ${error.stack}`);
    return false;
  }
}

// Main function
async function main() {
  log('===== Simple Polygon.io S3 Test =====');
  
  try {
    // Test bucket listing
    await testListBucket();
    
    // Try to list a specific directory
    const dirPath = 'us_stocks_sip/day_aggs_v1/2024/01';
    log(`\nListing directory: ${dirPath}`);
    
    const dirCommand = new ListObjectsV2Command({
      Bucket: 'flatfiles',
      Prefix: dirPath,
      MaxKeys: 10
    });
    
    const dirResponse = await s3Client.send(dirCommand);
    
    log(`Found ${dirResponse.Contents?.length || 0} items in directory.`);
    
    if (dirResponse.Contents && dirResponse.Contents.length > 0) {
      log('Items:');
      dirResponse.Contents.forEach(item => {
        log(`- ${item.Key}`);
      });
    }
    
    log('\nTest completed.');
  } catch (error) {
    log(`Fatal error: ${error.message}`);
    log(`Error stack: ${error.stack}`);
  } finally {
    // Close log file
    logFile.end();
  }
}

// Run the test
main();