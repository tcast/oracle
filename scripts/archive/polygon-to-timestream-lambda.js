/**
 * AWS Lambda function to fetch Polygon.io flat files and store in Amazon Timestream
 * 
 * This function:
 * 1. Downloads daily stock data from Polygon.io flat files
 * 2. Processes the data
 * 3. Stores it in Amazon Timestream
 */

const AWS = require('aws-sdk');
const https = require('https');
const zlib = require('zlib');
const csv = require('csv-parser');
const { Readable } = require('stream');

// Configure AWS SDK
const region = process.env.AWS_REGION || 'us-east-1';
AWS.config.update({ region });

// Initialize Timestream client
const timestream = new AWS.TimestreamWrite();

// Constants
const DATABASE_NAME = 'financial_data';
const TABLE_NAME = 'stock_prices';
const POLYGON_ENDPOINT = 'https://files.polygon.io';
const POLYGON_BUCKET = 'flatfiles';
const BATCH_SIZE = 100; // Timestream API limit is 100 records per request

// Helper function to download file from Polygon.io S3
async function downloadPolygonFile(objectKey) {
  console.log(`Downloading file: ${objectKey}`);
  
  // Create S3-compatible request
  const options = {
    hostname: 'files.polygon.io',
    path: `/${POLYGON_BUCKET}/${objectKey}`,
    method: 'GET',
    headers: {
      'Host': 'files.polygon.io',
      'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      'Authorization': `AWS4-HMAC-SHA256 Credential=${process.env.POLYGON_ACCESS_KEY}/${new Date().toISOString().slice(0, 10)}/${region}/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=...`
    }
  };
  
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to download file: ${res.statusCode}`));
        return;
      }
      
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve(buffer);
      });
    });
    
    req.on('error', (error) => {
      reject(error);
    });
    
    req.end();
  });
}

// Process CSV data from Polygon
async function processPolygonData(gzippedData) {
  console.log('Processing Polygon data...');
  
  return new Promise((resolve, reject) => {
    // Decompress gzipped data
    zlib.gunzip(gzippedData, (err, unzippedData) => {
      if (err) {
        reject(err);
        return;
      }
      
      const results = [];
      const readableStream = new Readable();
      readableStream.push(unzippedData);
      readableStream.push(null);
      
      readableStream
        .pipe(csv())
        .on('data', (data) => {
          results.push(data);
        })
        .on('end', () => {
          resolve(results);
        })
        .on('error', (error) => {
          reject(error);
        });
    });
  });
}

// Convert Polygon record to Timestream record
function convertToTimestreamRecord(row) {
  // Convert timestamp to epoch milliseconds
  const timestamp = new Date(row.timestamp).getTime();
  
  return {
    Dimensions: [
      { Name: 'symbol', Value: row.ticker },
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

// Main Lambda handler
exports.handler = async (event) => {
  console.log('Starting Polygon to Timestream data processing...');
  
  try {
    // Get yesterday's date (or use date from event if provided)
    let targetDate;
    if (event && event.date) {
      targetDate = new Date(event.date);
    } else {
      targetDate = new Date();
      targetDate.setDate(targetDate.getDate() - 1);
    }
    
    const dateStr = targetDate.toISOString().split('T')[0]; // YYYY-MM-DD
    const year = dateStr.slice(0, 4);
    const month = dateStr.slice(5, 7);
    
    // Construct object key for Polygon flat file
    // Adjust the path based on your Polygon subscription (us_stocks_sip, us_indices, etc.)
    const objectKey = `us_stocks_sip/trades_v1/${year}/${month}/${dateStr}.csv.gz`;
    
    // Download file from Polygon
    const gzippedData = await downloadPolygonFile(objectKey);
    
    // Process the data
    const records = await processPolygonData(gzippedData);
    console.log(`Processed ${records.length} records from Polygon`);
    
    // Write to Timestream in batches
    let processedCount = 0;
    let timestreamBatch = [];
    
    for (const record of records) {
      const timestreamRecord = convertToTimestreamRecord(record);
      timestreamBatch.push(timestreamRecord);
      
      // If we've reached batch size, write to Timestream
      if (timestreamBatch.length >= BATCH_SIZE) {
        const success = await writeBatchToTimestream(timestreamBatch);
        if (success) {
          processedCount += timestreamBatch.length;
          console.log(`Written ${processedCount}/${records.length} records to Timestream`);
        }
        timestreamBatch = [];
      }
    }
    
    // Write any remaining records
    if (timestreamBatch.length > 0) {
      const success = await writeBatchToTimestream(timestreamBatch);
      if (success) {
        processedCount += timestreamBatch.length;
      }
    }
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Data processing complete',
        processedRecords: processedCount,
        date: dateStr
      })
    };
  } catch (error) {
    console.error('Error processing data:', error);
    
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Error processing data',
        error: error.message
      })
    };
  }
}; 