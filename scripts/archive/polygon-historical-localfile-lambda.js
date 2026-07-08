/**
 * Lambda function to load historical stock data from local flat files
 * and load it into Amazon Timestream
 */

const { TimestreamWriteClient, WriteRecordsCommand } = require('@aws-sdk/client-timestream-write');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { createReadStream } = require('fs');

// Configure AWS SDK
const REGION = process.env.AWS_REGION || 'us-east-1';
const TIMESTREAM_DB = process.env.TIMESTREAM_DATABASE || 'oracle';
const TIMESTREAM_TABLE = process.env.TIMESTREAM_TABLE || 'stock_prices';

// Initialize Timestream client
const timestreamClient = new TimestreamWriteClient({ 
  region: REGION
});

// Directory containing data files (relative to the Lambda function)
const DATA_DIR = path.join(__dirname, 'data', 'stocks');

/**
 * List available stock files in the data directory
 * @returns {Array<string>} - Array of file paths
 */
function listStockFiles() {
  try {
    console.log(`Listing files in ${DATA_DIR}`);
    const files = fs.readdirSync(DATA_DIR)
      .filter(file => file.endsWith('.csv'))
      .map(file => path.join(DATA_DIR, file));
    
    console.log(`Found ${files.length} files`);
    return files;
  } catch (error) {
    console.error('Error listing files:', error);
    throw error;
  }
}

/**
 * Process a CSV file and convert to Timestream records
 * @param {string} filePath - Path to the CSV file
 * @returns {Promise<Array>} - Array of Timestream records
 */
function processStockFile(filePath) {
  return new Promise((resolve, reject) => {
    console.log(`Processing file: ${filePath}`);
    
    // Extract symbol from filename
    const symbol = path.basename(filePath, '.csv');
    const records = [];
    
    createReadStream(filePath)
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
        console.error(`Error reading file ${filePath}:`, error);
        reject(error);
      })
      .on('end', () => {
        console.log(`Finished reading file ${filePath}, processed ${records.length} records`);
        resolve(records);
      });
  });
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
 * Process a single stock file and write to Timestream
 * @param {string} filePath - Path to the stock data file
 * @returns {Promise<Object>} - Processing result
 */
async function processFileAndWriteToTimestream(filePath) {
  try {
    console.log(`Processing file: ${filePath}`);
    const records = await processStockFile(filePath);
    
    if (records.length === 0) {
      console.log(`No records to write for ${filePath}`);
      return {
        filePath,
        recordsProcessed: 0,
        recordsWritten: 0,
        success: true
      };
    }
    
    const written = await writeToTimestream(records);
    
    console.log(`Successfully processed ${written} records for ${filePath}`);
    
    return {
      filePath,
      recordsProcessed: records.length,
      recordsWritten: written,
      success: true
    };
  } catch (error) {
    console.error(`Error processing ${filePath}:`, error);
    
    return {
      filePath,
      success: false,
      error: error.message
    };
  }
}

/**
 * Process all stock files or a specific symbol
 * @param {Object} event - Lambda event
 * @returns {Promise<Object>} - Processing results
 */
async function processStockData(event) {
  try {
    // If a specific symbol is provided, process just that symbol
    if (event.symbol) {
      const symbol = event.symbol;
      const filePath = path.join(DATA_DIR, `${symbol}.csv`);
      
      if (!fs.existsSync(filePath)) {
        return {
          success: false,
          error: `File not found for symbol: ${symbol}`
        };
      }
      
      const result = await processFileAndWriteToTimestream(filePath);
      return {
        symbol,
        ...result
      };
    }
    
    // Process all files up to a limit
    const limit = event.limit || Number.MAX_SAFE_INTEGER;
    const files = listStockFiles();
    const filesToProcess = files.slice(0, limit);
    
    const results = [];
    let totalRecordsWritten = 0;
    
    for (const filePath of filesToProcess) {
      const result = await processFileAndWriteToTimestream(filePath);
      results.push(result);
      
      if (result.success) {
        totalRecordsWritten += result.recordsWritten;
      }
    }
    
    return {
      success: true,
      totalFiles: filesToProcess.length,
      totalRecordsWritten,
      results
    };
  } catch (error) {
    console.error('Error processing stock data:', error);
    
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Lambda handler
 */
exports.handler = async (event, context) => {
  console.log('Event:', JSON.stringify(event));
  
  try {
    const result = await processStockData(event);
    
    return {
      statusCode: result.success ? 200 : 500,
      body: result
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

// For local testing
if (require.main === module) {
  const testEvent = process.argv[2] ? { symbol: process.argv[2] } : {};
  exports.handler(testEvent)
    .then(result => {
      console.log('Execution result:', JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch(error => {
      console.error('Execution error:', error);
      process.exit(1);
    });
} 