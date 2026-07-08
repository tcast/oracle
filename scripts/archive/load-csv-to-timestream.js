const fs = require('fs');
const readline = require('readline');
const { TimestreamWriteClient, WriteRecordsCommand } = require('@aws-sdk/client-timestream-write');
const { TimestreamQueryClient, QueryCommand } = require('@aws-sdk/client-timestream-query');

// Configuration
const REGION = 'us-east-1';
const TIMESTREAM_DB = 'oracle';
const TIMESTREAM_TABLE = 'stock_prices';
const CSV_FILE_PATH = '/Users/tcast/Downloads/polygon/combined_stock_data.csv';
const BATCH_SIZE = 100; // Timestream limit per write operation
const MAX_RECORDS_PER_RUN = 10000; // Process this many records at a time to avoid memory issues

// Initialize clients
const writeClient = new TimestreamWriteClient({ region: REGION });
const queryClient = new TimestreamQueryClient({ region: REGION });

// Function to delete all data from the table
async function truncateTable() {
  try {
    console.log(`Checking for data in ${TIMESTREAM_DB}.${TIMESTREAM_TABLE}...`);
    
    // First, check if there's data to delete
    const countParams = {
      QueryString: `SELECT COUNT(*) FROM ${TIMESTREAM_DB}.${TIMESTREAM_TABLE}`
    };
    
    const command = new QueryCommand(countParams);
    const result = await queryClient.send(command);
    
    if (result.Rows && result.Rows.length > 0) {
      const count = parseInt(result.Rows[0].Data[0].ScalarValue);
      console.log(`Found ${count} records in the table.`);
      
      if (count > 0) {
        console.log('Note: Timestream doesn\'t support direct truncation.');
        console.log('New data will effectively overwrite existing data with matching time series.');
      }
    }
    
    return true;
  } catch (error) {
    console.error('Error connecting to Timestream:', error);
    throw new Error('Failed to connect to Timestream. Please check your credentials and permissions.');
  }
}

// Function to normalize a value for Timestream
function normalizeValue(value, type) {
  if (value === null || value === undefined || value === '') {
    // Return appropriate default values based on type
    if (type === 'DOUBLE') return '0.0';
    if (type === 'BIGINT') return '0';
    return '';
  }
  
  // Return the value as a string
  return value.toString();
}

// Function to convert CSV row to Timestream record
function convertRowToTimestreamRecord(row) {
  try {
    const [ticker, volume, open, close, high, low, timestamp, transactions] = row;
    
    // Skip if any essential field is missing
    if (!ticker || !timestamp) {
      return null;
    }
    
    // Validate the timestamp is a number
    const timestampNum = Number(timestamp);
    if (isNaN(timestampNum)) {
      return null;
    }
    
    // Convert timestamp from nanoseconds to milliseconds for AWS Timestream
    // Timestream expects time in milliseconds
    const timeMs = Math.floor(timestampNum / 1000000);
    
    // Validate the time is not in the future or too far in the past
    const currentTime = Date.now();
    const minTime = new Date('2000-01-01').getTime();
    
    if (timeMs > currentTime || timeMs < minTime) {
      return null;
    }
    
    return {
      Dimensions: [
        { Name: 'ticker', Value: ticker }
      ],
      MeasureName: 'stock_price',
      MeasureValues: [
        {
          Name: 'volume',
          Value: normalizeValue(volume, 'BIGINT'),
          Type: 'BIGINT'
        },
        {
          Name: 'open',
          Value: normalizeValue(open, 'DOUBLE'),
          Type: 'DOUBLE'
        },
        {
          Name: 'close',
          Value: normalizeValue(close, 'DOUBLE'),
          Type: 'DOUBLE'
        },
        {
          Name: 'high',
          Value: normalizeValue(high, 'DOUBLE'),
          Type: 'DOUBLE'
        },
        {
          Name: 'low',
          Value: normalizeValue(low, 'DOUBLE'),
          Type: 'DOUBLE'
        },
        {
          Name: 'transactions',
          Value: normalizeValue(transactions, 'BIGINT'),
          Type: 'BIGINT'
        }
      ],
      MeasureValueType: 'MULTI',
      Time: timeMs.toString(),
      TimeUnit: 'MILLISECONDS'
    };
  } catch (error) {
    console.error('Error converting row:', error, row);
    return null;
  }
}

// Function to write records to Timestream
async function writeToTimestream(records) {
  // Split records into chunks of BATCH_SIZE (Timestream limit)
  const batches = [];
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
  const [ticker, volume, open, close, high, low, timestamp, transactions] = row;
  
  // Skip if any essential field is missing
  if (!ticker || !timestamp) return null;
  
  // Convert timestamp from nanoseconds to milliseconds for AWS Timestream
  // Timestream expects time in milliseconds or ISO string
  const timeMs = Math.floor(Number(timestamp) / 1000000);
  
  return {
    Dimensions: [
      { Name: 'ticker', Value: ticker }
    ],
    MeasureName: 'stock_price',
    MeasureValueType: 'MULTI',
    MeasureValues: [
      {
        Name: 'volume',
        Value: volume || '0',
        Type: 'BIGINT'
      },
      {
        Name: 'open',
        Value: open || '0',
        Type: 'DOUBLE'
      },
      {
        Name: 'close',
        Value: close || '0',
        Type: 'DOUBLE'
      },
      {
        Name: 'high',
        Value: high || '0',
        Type: 'DOUBLE'
      },
      {
        Name: 'low',
        Value: low || '0',
        Type: 'DOUBLE'
      },
      {
        Name: 'transactions',
        Value: transactions || '0',
        Type: 'BIGINT'
      }
    ],
    Time: timeMs.toString(),
    TimeUnit: 'MILLISECONDS'
  };
}

// Function to write records to Timestream
async function writeToTimestream(records) {
  // Split records into chunks of BATCH_SIZE (Timestream limit)
  const batches = [];
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    batches.push(records.slice(i, i + BATCH_SIZE));
  }
  
  let successCount = 0;
  let failureCount = 0;
  
  for (let i = 0; i < batches.length; i++) {
    const chunk = batches[i];
    const params = {
      DatabaseName: TIMESTREAM_DB,
      TableName: TIMESTREAM_TABLE,
      Records: chunk
    };
    
    try {
      // Only show progress every 10 batches to avoid console spam
      if (i % 10 === 0) {
        console.log(`Writing batch ${i+1}/${batches.length} (${chunk.length} records)`);
      }
      
      const command = new WriteRecordsCommand(params);
      await writeClient.send(command);
      successCount += chunk.length;
      
      // Show progress periodically
      if ((i+1) % 50 === 0 || i === batches.length - 1) {
        console.log(`Progress: ${successCount + failureCount} records processed (${successCount} succeeded, ${failureCount} failed)`);
      }
    } catch (error) {
      console.error(`Error writing batch ${i+1}:`, error.message);
      failureCount += chunk.length;
    }
  }
  
  return { successCount, failureCount };
}

// Main function to process CSV file
async function processCSV() {
  try {
    // First, truncate the table
    await truncateTable();
    
    console.log(`Processing CSV file: ${CSV_FILE_PATH}`);
    
    // Create readline interface
    const fileStream = fs.createReadStream(CSV_FILE_PATH);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });
    
    let lineCount = 0;
    let recordsProcessed = 0;
    let totalSuccess = 0;
    let totalFailure = 0;
    let records = [];
    let header = null;
    
    console.log('Reading CSV file...');
    
    // Process line by line
    for await (const line of rl) {
      lineCount++;
      
      // Skip header line
      if (lineCount === 1) {
        header = line;
        continue;
      }
      
      // Parse CSV line (simple split, assuming no commas in values)
      const row = line.split(',');
      
      // Convert row to Timestream record
      const record = convertRowToTimestreamRecord(row);
      if (record) {
        records.push(record);
      }
      
      // Process in batches to avoid memory issues
      if (records.length >= MAX_RECORDS_PER_RUN) {
        console.log(`Processed ${lineCount} lines, writing batch of ${records.length} records to Timestream...`);
        const result = await writeToTimestream(records);
        totalSuccess += result.successCount;
        totalFailure += result.failureCount;
        recordsProcessed += records.length;
        records = [];
        
        console.log(`Total progress: ${recordsProcessed} records processed (${totalSuccess} succeeded, ${totalFailure} failed)`);
      }
    }
    
    // Process any remaining records
    if (records.length > 0) {
      console.log(`Writing final batch of ${records.length} records to Timestream...`);
      const result = await writeToTimestream(records);
      totalSuccess += result.successCount;
      totalFailure += result.failureCount;
      recordsProcessed += records.length;
    }
    
    console.log('\nCSV import complete!');
    console.log(`Total lines read: ${lineCount}`);
    console.log(`Total records processed: ${recordsProcessed}`);
    console.log(`Successfully imported: ${totalSuccess} records`);
    console.log(`Failed records: ${totalFailure}`);
    
  } catch (error) {
    console.error('Error processing CSV file:', error);
  }
}

// Run the script
processCSV().catch(console.error);