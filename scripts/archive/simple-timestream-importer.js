const fs = require('fs');
const readline = require('readline');
const { TimestreamWriteClient, WriteRecordsCommand, DeleteTableCommand, CreateTableCommand } = require('@aws-sdk/client-timestream-write');

// Configuration
const REGION = 'us-east-1';
const TIMESTREAM_DB = 'oracle';
const TIMESTREAM_TABLE = 'stock_prices';
const CSV_FILE_PATH = '/Users/tcast/Downloads/polygon/combined_stock_data.csv';
const BATCH_SIZE = 50; // Smaller batch size for testing
const MAX_LINES_TO_PROCESS = 10000; // Start with a small subset
const DETAILED_ERROR_LOGGING = true;

// Initialize Timestream client
const client = new TimestreamWriteClient({ region: REGION });

// Function to delete the existing table
async function deleteTable() {
  console.log(`Deleting existing Timestream table: ${TIMESTREAM_DB}.${TIMESTREAM_TABLE}`);
  
  try {
    const deleteParams = {
      DatabaseName: TIMESTREAM_DB,
      TableName: TIMESTREAM_TABLE
    };
    
    const command = new DeleteTableCommand(deleteParams);
    await client.send(command);
    console.log('Table deleted successfully');
    
    // Wait for table deletion to complete
    console.log('Waiting 30 seconds for deletion to propagate...');
    await new Promise(resolve => setTimeout(resolve, 30000));
    
    return true;
  } catch (error) {
    if (error.name === 'ResourceNotFoundException') {
      console.log('Table does not exist, nothing to delete');
      return true;
    }
    console.error('Error deleting table:', error);
    return false;
  }
}

// Function to create a new table
async function createTable() {
  console.log(`Creating new Timestream table: ${TIMESTREAM_DB}.${TIMESTREAM_TABLE}`);
  
  try {
    const createParams = {
      DatabaseName: TIMESTREAM_DB,
      TableName: TIMESTREAM_TABLE,
      RetentionProperties: {
        MemoryStoreRetentionPeriodInHours: 24,
        MagneticStoreRetentionPeriodInDays: 365
      }
    };
    
    const command = new CreateTableCommand(createParams);
    await client.send(command);
    console.log('Table created successfully');
    
    // Wait for table creation to complete
    console.log('Waiting 10 seconds for table creation to propagate...');
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    return true;
  } catch (error) {
    console.error('Error creating table:', error);
    return false;
  }
}

// Function to write records to Timestream
async function writeRecordBatch(records) {
  try {
    const params = {
      DatabaseName: TIMESTREAM_DB,
      TableName: TIMESTREAM_TABLE,
      Records: records
    };
    
    const command = new WriteRecordsCommand(params);
    const response = await client.send(command);
    
    // Check for rejected records
    if (response.RejectedRecords && response.RejectedRecords.length > 0) {
      console.warn(`${response.RejectedRecords.length} records were rejected`);
      
      if (DETAILED_ERROR_LOGGING) {
        response.RejectedRecords.forEach(rejected => {
          console.error(`Rejected record at index ${rejected.RecordIndex}: ${rejected.Reason}`);
          if (rejected.ExistingVersion) {
            console.error(`Existing version: ${rejected.ExistingVersion}`);
          }
          
          // Log the actual record that was rejected
          if (rejected.RecordIndex < records.length) {
            console.error('Rejected record:', JSON.stringify(records[rejected.RecordIndex], null, 2));
          }
        });
      }
      
      return {
        success: records.length - response.RejectedRecords.length,
        failure: response.RejectedRecords.length
      };
    }
    
    return {
      success: records.length,
      failure: 0
    };
  } catch (error) {
    console.error('Error writing batch to Timestream:', error);
    
    // Check for specific AWS errors
    if (error.name === 'ThrottlingException') {
      console.error('API call was throttled. Consider reducing batch size or frequency.');
    } else if (error.name === 'RejectedRecordsException') {
      if (error.RejectedRecords) {
        console.error(`${error.RejectedRecords.length} records were rejected.`);
      }
    } else if (error.name === 'ValidationException') {
      console.error('Validation error. Check record format:', error.message);
    }
    
    return {
      success: 0,
      failure: records.length
    };
  }
}

// Main function to process the CSV file
async function processCSV() {
  console.log(`Starting import of CSV file: ${CSV_FILE_PATH}`);
  console.log(`Will process up to ${MAX_LINES_TO_PROCESS} lines with batch size ${BATCH_SIZE}`);
  
  // Delete and recreate the table
  console.log('=== STEP 1: Removing existing data ===');
  const tableDeleted = await deleteTable();
  if (!tableDeleted) {
    console.error('Failed to delete the table. Aborting import.');
    return { success: 0, failure: 0 };
  }
  
  console.log('=== STEP 2: Creating fresh table ===');
  const tableCreated = await createTable();
  if (!tableCreated) {
    console.error('Failed to create the table. Aborting import.');
    return { success: 0, failure: 0 };
  }
  
  console.log('=== STEP 3: Processing CSV data ===');
  
  const startTime = Date.now();
  let lineCount = 0;
  let processedCount = 0;
  let successCount = 0;
  let failureCount = 0;
  let skippedHeader = false;
  let currentBatch = [];
  
  try {
    // Create readline interface
    const fileStream = fs.createReadStream(CSV_FILE_PATH);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });
    
    // Process line by line
    for await (const line of rl) {
      lineCount++;
      
      // Skip header
      if (!skippedHeader) {
        console.log(`Header: ${line}`);
        skippedHeader = true;
        continue;
      }
      
      try {
        // Parse CSV line
        const row = line.split(',');
        const [ticker, volume, open, close, high, low, originalTimestamp, transactions] = row;
        
        if (!ticker || !originalTimestamp) {
          console.warn(`Line ${lineCount}: Missing required fields, skipping`);
          continue;
        }
        
        // Convert date for dimension
        const timestamp = Number(originalTimestamp);
        if (isNaN(timestamp)) {
          console.warn(`Line ${lineCount}: Invalid timestamp ${originalTimestamp}, skipping`);
          continue;
        }
        
        const originalDate = new Date(timestamp / 1000000);
        const dateStr = originalDate.toISOString().split('T')[0]; // YYYY-MM-DD format
        
        // Use current time with offset for Timestream
        const baseTimestamp = Date.now();
        
        // Process each measure that has a value
        const measures = [
          { name: 'volume', value: volume },
          { name: 'open', value: open },
          { name: 'close', value: close },
          { name: 'high', value: high },
          { name: 'low', value: low },
          { name: 'transactions', value: transactions }
        ];
        
        for (let i = 0; i < measures.length; i++) {
          const { name, value } = measures[i];
          
          if (value && value !== "0") {
            currentBatch.push({
              Dimensions: [
                { Name: 'ticker', Value: ticker },
                { Name: 'date', Value: dateStr }
              ],
              MeasureName: name,
              MeasureValue: value,
              MeasureValueType: 'DOUBLE',
              Time: (baseTimestamp + i).toString(),
              TimeUnit: 'MILLISECONDS'
            });
          }
        }
        
        processedCount++;
        
        // Write batch when it reaches BATCH_SIZE
        if (currentBatch.length >= BATCH_SIZE) {
          console.log(`Submitting batch of ${currentBatch.length} records...`);
          
          // Print first record as a sample
          console.log('Sample record:', JSON.stringify(currentBatch[0], null, 2));
          
          const result = await writeRecordBatch(currentBatch);
          successCount += result.success;
          failureCount += result.failure;
          
          console.log(`Batch result: ${result.success} succeeded, ${result.failure} failed`);
          
          // Clear batch
          currentBatch = [];
        }
      } catch (error) {
        console.error(`Error processing line ${lineCount}:`, error);
        console.error('Line content:', line);
      }
      
      // Stop after MAX_LINES_TO_PROCESS
      if (processedCount >= MAX_LINES_TO_PROCESS) {
        console.log(`Reached maximum lines to process (${MAX_LINES_TO_PROCESS}). Stopping.`);
        break;
      }
    }
    
    // Process any remaining records
    if (currentBatch.length > 0) {
      console.log(`Submitting final batch of ${currentBatch.length} records...`);
      const result = await writeRecordBatch(currentBatch);
      successCount += result.success;
      failureCount += result.failure;
      console.log(`Final batch result: ${result.success} succeeded, ${result.failure} failed`);
    }
    
    const elapsedSeconds = (Date.now() - startTime) / 1000;
    const recordsPerSecond = Math.round(processedCount / elapsedSeconds);
    
    console.log('\nProcessing complete!');
    console.log(`Processed ${processedCount} csv rows (${lineCount} total lines read)`);
    console.log(`Successfully imported: ${successCount} records`);
    console.log(`Failed records: ${failureCount}`);
    console.log(`Total time: ${Math.round(elapsedSeconds)} seconds`);
    console.log(`Average speed: ${recordsPerSecond} records per second`);
    
    return { success: successCount, failure: failureCount };
  } catch (error) {
    console.error('Fatal error processing CSV:', error);
    return { success: successCount, failure: failureCount };
  }
}

// Run the main function
processCSV()
  .then(result => {
    if (result.success > 0) {
      console.log('CSV import completed successfully');
    } else {
      console.error('CSV import completed with no successful records');
    }
    process.exit(0);
  })
  .catch(error => {
    console.error('CSV import failed:', error);
    process.exit(1);
  }); 