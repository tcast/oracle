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
const MAX_RECORDS_PER_RUN = 5000; // Process this many records at a time to avoid memory issues

// Initialize clients
const writeClient = new TimestreamWriteClient({ region: REGION });
const queryClient = new TimestreamQueryClient({ region: REGION });

// Schema mapping based on the provided schema:
// date (varchar), symbol (varchar), original_timestamp (varchar), asset_type (varchar),
// data_source (varchar), measure_name (varchar), time (timestamp), measure_value::double (double)

// Function to delete data using a query
async function deleteExistingData() {
  try {
    console.log(`Attempting to delete data from ${TIMESTREAM_DB}.${TIMESTREAM_TABLE}...`);
    
    // Check table existence and count records
    const countParams = {
      QueryString: `SELECT COUNT(*) FROM ${TIMESTREAM_DB}.${TIMESTREAM_TABLE}`
    };
    
    console.log('Checking table and count...');
    
    try {
      const command = new QueryCommand(countParams);
      const result = await queryClient.send(command);
      
      if (result.Rows && result.Rows.length > 0) {
        const count = parseInt(result.Rows[0].Data[0].ScalarValue);
        console.log(`Found ${count} records in the table.`);
        
        if (count > 0) {
          console.log('Note: Timestream doesn\'t support direct DELETE operations.');
          console.log('The script will attempt to overwrite existing records when possible.');
          console.log('Old data will be automatically removed based on your retention policy.');
        }
      }
    } catch (error) {
      console.error('Error querying table count:', error.message);
      console.log('Continuing with import assuming table exists...');
    }
    
    return true;
  } catch (error) {
    console.error('Error in deleteExistingData:', error);
    console.log('Continuing with import...');
    return false;
  }
}

// Function to format date from timestamp
function formatDate(timestamp) {
  try {
    // Convert nanoseconds to milliseconds
    const timeMs = Math.floor(Number(timestamp) / 1000000);
    const date = new Date(timeMs);
    return date.toISOString().split('T')[0]; // YYYY-MM-DD format
  } catch (error) {
    return 'unknown_date';
  }
}

// Function to convert CSV row to Timestream record
function convertRowToTimestreamRecord(row) {
  try {
    const [ticker, volume, open, close, high, low, timestamp, transactions] = row;
    
    // Skip if any essential field is missing
    if (!ticker || !timestamp) {
      return [];
    }
    
    // Validate the timestamp is a number
    const timestampNum = Number(timestamp);
    if (isNaN(timestampNum)) {
      return [];
    }
    
    // Convert timestamp from nanoseconds to milliseconds for AWS Timestream
    const timeMs = Math.floor(timestampNum / 1000000);
    
    // Generate formatted date for the record
    const dateStr = formatDate(timestamp);
    
    // Common dimensions for all measures
    const commonDimensions = [
      { Name: 'symbol', Value: ticker },
      { Name: 'date', Value: dateStr },
      { Name: 'original_timestamp', Value: timestamp },
      { Name: 'asset_type', Value: 'stock' },
      { Name: 'data_source', Value: 'polygon' }
    ];
    
    // Create multiple records - one for each measure
    const records = [];
    
    // Add record for open price
    if (open !== undefined && open !== null && open !== '') {
      records.push({
        Dimensions: commonDimensions,
        MeasureName: 'open',
        MeasureValue: open.toString(),
        MeasureValueType: 'DOUBLE',
        Time: timeMs.toString(),
        TimeUnit: 'MILLISECONDS'
      });
    }
    
    // Add record for close price
    if (close !== undefined && close !== null && close !== '') {
      records.push({
        Dimensions: commonDimensions,
        MeasureName: 'close',
        MeasureValue: close.toString(),
        MeasureValueType: 'DOUBLE',
        Time: timeMs.toString(),
        TimeUnit: 'MILLISECONDS'
      });
    }
    
    // Add record for high price
    if (high !== undefined && high !== null && high !== '') {
      records.push({
        Dimensions: commonDimensions,
        MeasureName: 'high',
        MeasureValue: high.toString(),
        MeasureValueType: 'DOUBLE',
        Time: timeMs.toString(),
        TimeUnit: 'MILLISECONDS'
      });
    }
    
    // Add record for low price
    if (low !== undefined && low !== null && low !== '') {
      records.push({
        Dimensions: commonDimensions,
        MeasureName: 'low',
        MeasureValue: low.toString(),
        MeasureValueType: 'DOUBLE',
        Time: timeMs.toString(),
        TimeUnit: 'MILLISECONDS'
      });
    }
    
    // Add record for volume
    if (volume !== undefined && volume !== null && volume !== '') {
      records.push({
        Dimensions: commonDimensions,
        MeasureName: 'volume',
        MeasureValue: volume.toString(),
        MeasureValueType: 'DOUBLE', // Using DOUBLE for consistency
        Time: timeMs.toString(),
        TimeUnit: 'MILLISECONDS'
      });
    }
    
    // Add record for transactions
    if (transactions !== undefined && transactions !== null && transactions !== '') {
      records.push({
        Dimensions: commonDimensions,
        MeasureName: 'transactions',
        MeasureValue: transactions.toString(),
        MeasureValueType: 'DOUBLE', // Using DOUBLE for consistency
        Time: timeMs.toString(),
        TimeUnit: 'MILLISECONDS'
      });
    }
    
    return records;
  } catch (error) {
    console.error('Error converting row:', error, row);
    return [];
  }
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
      const response = await writeClient.send(command);
      
      if (response.RejectedRecords && response.RejectedRecords.length > 0) {
        console.error(`Batch ${i+1} had ${response.RejectedRecords.length} rejected records.`);
        failureCount += response.RejectedRecords.length;
        successCount += (chunk.length - response.RejectedRecords.length);
        
        // Log the first rejection for debugging
        if (response.RejectedRecords.length > 0) {
          const firstRejection = response.RejectedRecords[0];
          console.error(`  Rejection reason: ${firstRejection.Reason}`);
          console.error(`  Record index: ${firstRejection.RecordIndex}`);
          if (firstRejection.ExistingVersion) {
            console.error(`  Existing version: ${firstRejection.ExistingVersion}`);
          }
        }
      } else {
        successCount += chunk.length;
      }
      
      // Show progress periodically
      if ((i+1) % 50 === 0 || i === batches.length - 1) {
        console.log(`Progress: ${successCount + failureCount} records processed (${successCount} succeeded, ${failureCount} failed)`);
      }
    } catch (error) {
      console.error(`Error writing batch ${i+1}:`, error.message);
      
      // Log more detailed error information
      if (error.name) console.error(`Error name: ${error.name}`);
      if (error.code) console.error(`Error code: ${error.code}`);
      if (error.$metadata && error.$metadata.httpStatusCode) {
        console.error(`HTTP Status: ${error.$metadata.httpStatusCode}`);
      }
      
      failureCount += chunk.length;
    }
  }
  
  return { successCount, failureCount };
}

// Main function to process CSV file
async function processCSV() {
  try {
    // First, attempt to delete existing data
    await deleteExistingData();
    
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
      
      // Convert row to Timestream records (multiple records per row)
      const rowRecords = convertRowToTimestreamRecord(row);
      records = records.concat(rowRecords);
      
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
      
      // Log progress every 10,000 lines
      if (lineCount % 10000 === 0) {
        console.log(`Processed ${lineCount} lines from CSV file...`);
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