/**
 * Lambda function to load historical stock data from flat files in S3
 * and load it into Amazon Timestream
 */

const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { TimestreamWriteClient, WriteRecordsCommand } = require('@aws-sdk/client-timestream-write');
const { createReadStream } = require('fs');
const readline = require('readline');
const csv = require('csv-parser');

// Configure AWS SDK
const REGION = process.env.AWS_REGION || 'us-east-1';
const TIMESTREAM_DB = process.env.TIMESTREAM_DATABASE || 'oracle';
const TIMESTREAM_TABLE = process.env.TIMESTREAM_TABLE || 'stock_prices';

// S3 configuration
const S3_BUCKET = process.env.S3_BUCKET || 'polygon-market-data';
const S3_PREFIX = process.env.S3_PREFIX || 'stocks/daily/';

// Initialize clients
const s3Client = new S3Client({ region: REGION });
const timestreamClient = new TimestreamWriteClient({ region: REGION });

/**
 * List available stock files in S3 bucket
 * @param {string} prefix - Optional prefix to filter files
 * @param {string} startAfter - Optional key to start listing after
 * @returns {Promise<Array>} - Array of file keys
 */
async function listStockFiles(prefix = S3_PREFIX, startAfter = null) {
  const params = {
    Bucket: S3_BUCKET,
    Prefix: prefix,
    MaxKeys: 100
  };
  
  if (startAfter) {
    params.StartAfter = startAfter;
  }
  
  try {
    console.log(`Listing files in s3://${S3_BUCKET}/${prefix}`);
    const command = new ListObjectsV2Command(params);
    const response = await s3Client.send(command);
    
    const files = response.Contents?.map(item => item.Key) || [];
    console.log(`Found ${files.length} files`);
    
    // If there are more files, recursively get them
    if (response.IsTruncated) {
      const lastKey = files[files.length - 1];
      const moreFiles = await listStockFiles(prefix, lastKey);
      return [...files, ...moreFiles];
    }
    
    return files;
  } catch (error) {
    console.error('Error listing files in S3:', error);
    throw error;
  }
}

/**
 * Read a CSV file from S3 and process each line
 * @param {string} fileKey - S3 object key
 * @returns {Promise<Array>} - Array of processed records
 */
async function processStockFile(fileKey) {
  try {
    console.log(`Processing file: ${fileKey}`);
    
    // Extract symbol from filename (assuming format like stocks/daily/AAPL.csv)
    const symbol = fileKey.split('/').pop().split('.')[0];
    
    const params = {
      Bucket: S3_BUCKET,
      Key: fileKey
    };
    
    const command = new GetObjectCommand(params);
    const response = await s3Client.send(command);
    
    // Process the file line by line
    const records = [];
    const readStream = response.Body;
    
    return new Promise((resolve, reject) => {
      readStream
        .pipe(csv())
        .on('data', (row) => {
          // Convert CSV row to Timestream records
          try {
            const timestamp = Date.now();
            const date = row.date; // Assuming 'date' column exists
            const originalTimestamp = new Date(date).getTime().toString();
            
            const dimensions = [
              { Name: 'symbol', Value: symbol },
              { Name: 'asset_type', Value: 'stock' },
              { Name: 'original_timestamp', Value: originalTimestamp },
              { Name: 'date', Value: date }
            ];
            
            // Create records for each price metric
            // Assuming column names are 'open', 'high', 'low', 'close', 'volume'
            if (row.open) {
              records.push({
                Dimensions: dimensions,
                MeasureName: 'open',
                MeasureValue: row.open.toString(),
                MeasureValueType: 'DOUBLE',
                Time: timestamp.toString(),
                TimeUnit: 'MILLISECONDS'
              });
            }
            
            if (row.high) {
              records.push({
                Dimensions: dimensions,
                MeasureName: 'high',
                MeasureValue: row.high.toString(),
                MeasureValueType: 'DOUBLE',
                Time: timestamp.toString(),
                TimeUnit: 'MILLISECONDS'
              });
            }
            
            if (row.low) {
              records.push({
                Dimensions: dimensions,
                MeasureName: 'low',
                MeasureValue: row.low.toString(),
                MeasureValueType: 'DOUBLE',
                Time: timestamp.toString(),
                TimeUnit: 'MILLISECONDS'
              });
            }
            
            if (row.close) {
              records.push({
                Dimensions: dimensions,
                MeasureName: 'close',
                MeasureValue: row.close.toString(),
                MeasureValueType: 'DOUBLE',
                Time: timestamp.toString(),
                TimeUnit: 'MILLISECONDS'
              });
            }
            
            if (row.volume) {
              records.push({
                Dimensions: dimensions,
                MeasureName: 'volume',
                MeasureValue: row.volume.toString(),
                MeasureValueType: 'DOUBLE',
                Time: timestamp.toString(),
                TimeUnit: 'MILLISECONDS'
              });
            }
          } catch (error) {
            console.error(`Error processing row: ${JSON.stringify(row)}`, error);
          }
        })
        .on('error', (error) => {
          console.error(`Error reading file ${fileKey}:`, error);
          reject(error);
        })
        .on('end', () => {
          console.log(`Finished reading file ${fileKey}, processed ${records.length} records`);
          resolve(records);
        });
    });
  } catch (error) {
    console.error(`Error processing file ${fileKey}:`, error);
    return [];
  }
}

/**
 * Write records to Timestream
 * @param {Array} records - Array of Timestream records
 * @returns {Promise<number>} - Number of records written
 */
async function writeToTimestream(records) {
  if (records.length === 0) {
    return 0;
  }
  
  // Split records into chunks of 100 (Timestream limit)
  const chunkSize = 100;
  const chunks = [];
  
  for (let i = 0; i < records.length; i += chunkSize) {
    chunks.push(records.slice(i, i + chunkSize));
  }
  
  let successCount = 0;
  
  for (const chunk of chunks) {
    const params = {
      DatabaseName: TIMESTREAM_DB,
      TableName: TIMESTREAM_TABLE,
      Records: chunk
    };
    
    try {
      console.log(`Writing ${chunk.length} records to Timestream`);
      const command = new WriteRecordsCommand(params);
      const result = await timestreamClient.send(command);
      successCount += chunk.length;
      console.log(`Successfully wrote ${chunk.length} records to Timestream`);
    } catch (error) {
      console.error('Error writing to Timestream:', error);
      throw error;
    }
    
    // Add a small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  
  return successCount;
}

/**
 * Process a specific stock file and write data to Timestream
 * @param {string} fileKey - S3 object key
 * @returns {Promise<number>} - Number of records written
 */
async function processStockFileAndWrite(fileKey) {
  try {
    const records = await processStockFile(fileKey);
    
    if (records.length === 0) {
      console.log(`No records to write for ${fileKey}`);
      return 0;
    }
    
    // Write to Timestream
    const written = await writeToTimestream(records);
    console.log(`Successfully processed ${written} records for ${fileKey}`);
    return written;
  } catch (error) {
    console.error(`Error processing ${fileKey}:`, error);
    throw error;
  }
}

/**
 * Process all available stock files or a subset based on event parameters
 * @param {Object} event - Lambda event
 * @returns {Promise<Object>} - Processing results
 */
async function processStockFiles(event) {
  // If specific file is provided in the event, process just that file
  if (event.fileKey) {
    const written = await processStockFileAndWrite(event.fileKey);
    return {
      fileKey: event.fileKey,
      recordsWritten: written
    };
  }
  
  // If specific symbol is provided, process just that symbol's file
  if (event.symbol) {
    const fileKey = `${S3_PREFIX}${event.symbol}.csv`;
    const written = await processStockFileAndWrite(fileKey);
    return {
      symbol: event.symbol,
      fileKey,
      recordsWritten: written
    };
  }
  
  // Process all files up to a limit
  const limit = event.limit || 10; // Default to 10 files to avoid timeout
  const files = await listStockFiles();
  const filesToProcess = files.slice(0, limit);
  
  const results = [];
  let totalRecords = 0;
  
  for (const fileKey of filesToProcess) {
    try {
      const written = await processStockFileAndWrite(fileKey);
      totalRecords += written;
      results.push({
        fileKey,
        recordsWritten: written
      });
    } catch (error) {
      console.error(`Error processing ${fileKey}:`, error);
      results.push({
        fileKey,
        error: error.message
      });
    }
  }
  
  return {
    totalFiles: filesToProcess.length,
    totalRecordsWritten: totalRecords,
    results
  };
}

/**
 * Lambda handler
 */
exports.handler = async (event, context) => {
  console.log('Event:', JSON.stringify(event));
  
  try {
    const results = await processStockFiles(event);
    
    return {
      statusCode: 200,
      body: results
    };
  } catch (error) {
    console.error('Lambda execution error:', error);
    
    return {
      statusCode: 500,
      body: {
        message: 'Lambda execution error',
        error: error.message
      }
    };
  }
}; 