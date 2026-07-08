/**
 * Script to create an S3 bucket and upload sample stock data files
 */

const { 
  S3Client, 
  CreateBucketCommand, 
  PutObjectCommand,
  HeadBucketCommand
} = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Configure AWS SDK
const REGION = 'us-east-1';
const BUCKET_NAME = 'polygon-market-data-' + Date.now().toString().substring(4); // Unique bucket name
const S3_PREFIX = 'stocks/daily/';

// Initialize S3 client
const s3Client = new S3Client({ region: REGION });

// List of stock symbols to create data for
const symbols = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META'];

/**
 * Create a new S3 bucket
 */
async function createBucket() {
  try {
    console.log(`Creating bucket: ${BUCKET_NAME}`);
    
    // First check if bucket already exists
    try {
      const headCommand = new HeadBucketCommand({ Bucket: BUCKET_NAME });
      await s3Client.send(headCommand);
      console.log(`Bucket ${BUCKET_NAME} already exists`);
      return BUCKET_NAME;
    } catch (error) {
      // Bucket doesn't exist, create it
      const command = new CreateBucketCommand({
        Bucket: BUCKET_NAME,
        CreateBucketConfiguration: {
          LocationConstraint: REGION !== 'us-east-1' ? REGION : undefined
        }
      });
      
      const result = await s3Client.send(command);
      console.log(`Successfully created bucket: ${result.Location}`);
      return BUCKET_NAME;
    }
  } catch (error) {
    console.error('Error creating S3 bucket:', error);
    throw error;
  }
}

/**
 * Generate sample stock data CSV content
 * @param {string} symbol - Stock symbol
 * @returns {string} - CSV content
 */
function generateSampleData(symbol) {
  const startDate = new Date('2003-01-01');
  const endDate = new Date('2023-12-31');
  const rows = ['date,open,high,low,close,volume,adj_close'];
  
  // Generate random but realistic stock data
  let currentPrice = 50 + (Math.random() * 50); // Starting price between $50-$100
  
  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    // Skip weekends
    if (d.getDay() === 0 || d.getDay() === 6) {
      continue;
    }
    
    // Generate random price movements (max 3% daily change)
    const changePercent = (Math.random() * 6) - 3; // -3% to +3%
    const change = currentPrice * (changePercent / 100);
    
    const open = currentPrice;
    const close = currentPrice + change;
    currentPrice = close; // Set for next day
    
    // High is the higher of open/close plus a random amount
    const high = Math.max(open, close) + (Math.random() * Math.abs(change));
    
    // Low is the lower of open/close minus a random amount
    const low = Math.min(open, close) - (Math.random() * Math.abs(change));
    
    // Volume - random between 1M and 10M
    const volume = Math.floor(1000000 + (Math.random() * 9000000));
    
    // Format date as YYYY-MM-DD
    const dateStr = d.toISOString().split('T')[0];
    
    rows.push(`${dateStr},${open.toFixed(2)},${high.toFixed(2)},${low.toFixed(2)},${close.toFixed(2)},${volume},${close.toFixed(2)}`);
  }
  
  return rows.join('\n');
}

/**
 * Upload sample stock data to S3
 * @param {string} symbol - Stock symbol
 * @returns {Promise<string>} - S3 object key
 */
async function uploadSampleData(symbol) {
  const fileKey = `${S3_PREFIX}${symbol}.csv`;
  const data = generateSampleData(symbol);
  
  try {
    console.log(`Uploading sample data for ${symbol} to s3://${BUCKET_NAME}/${fileKey}`);
    
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileKey,
      Body: data,
      ContentType: 'text/csv'
    });
    
    await s3Client.send(command);
    console.log(`Successfully uploaded sample data for ${symbol}`);
    return fileKey;
  } catch (error) {
    console.error(`Error uploading sample data for ${symbol}:`, error);
    throw error;
  }
}

/**
 * Main function
 */
async function main() {
  try {
    await createBucket();
    
    const results = [];
    
    for (const symbol of symbols) {
      try {
        const fileKey = await uploadSampleData(symbol);
        results.push({
          symbol,
          fileKey,
          success: true
        });
      } catch (error) {
        results.push({
          symbol,
          success: false,
          error: error.message
        });
      }
      
      // Add a small delay between uploads
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log('Upload summary:');
    console.log(JSON.stringify(results, null, 2));
    
    console.log('\nS3 bucket setup complete.');
    console.log(`Bucket name: ${BUCKET_NAME}`);
    console.log(`S3 prefix: ${S3_PREFIX}`);
    console.log('\nTo use with the Lambda function, set these environment variables:');
    console.log(`S3_BUCKET=${BUCKET_NAME}`);
    console.log(`S3_PREFIX=${S3_PREFIX}`);
  } catch (error) {
    console.error('Error in main function:', error);
  }
}

// Run the script
main(); 