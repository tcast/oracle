const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { TimestreamWriteClient, WriteRecordsCommand, DeleteTableCommand, CreateTableCommand } = require('@aws-sdk/client-timestream-write');

// Configuration
const REGION = 'us-east-1';
const TIMESTREAM_DB = 'oracle';
const TIMESTREAM_TABLE = 'stock_prices';
const CSV_FILE_PATH = '/Users/tcast/Downloads/polygon/combined_stock_data.csv';
const BATCH_SIZE = 100; // Maximum allowed by Timestream for a single write
const MAX_CONCURRENT_BATCHES = 50; // Maximum concurrent API calls
const NUM_PROCESSES = 4; // Number of child processes to spawn
const RECORDS_PER_PROCESS_BATCH = 500000; // Records to process in each batch per process

// Main client instance for the parent process
const timestream = new TimestreamWriteClient({ region: REGION });

// Function to delete the existing table
async function deleteTimestreamTable() {
  console.log(`Deleting existing Timestream table: ${TIMESTREAM_DB}.${TIMESTREAM_TABLE}`);
  
  try {
    const deleteParams = {
      DatabaseName: TIMESTREAM_DB,
      TableName: TIMESTREAM_TABLE
    };
    
    const command = new DeleteTableCommand(deleteParams);
    await timestream.send(command);
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
async function createTimestreamTable() {
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
    await timestream.send(command);
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

// This chunk processing function runs in child processes
function processChunk(startLine, endLine) {
  const client = new TimestreamWriteClient({ region: REGION });
  
  // Process the chunk of the CSV file
  const processChunkFile = async () => {
    const records = [];
    let successCount = 0;
    let failureCount = 0;
    let lineCount = 0;
    let headerSkipped = false;

    // Read the file streams in chunks
    const readStream = fs.createReadStream(CSV_FILE_PATH);
    const rl = require('readline').createInterface({
      input: readStream,
      crlfDelay: Infinity
    });
    
    // Process line by line
    for await (const line of rl) {
      lineCount++;
      
      // Skip lines before our chunk
      if (lineCount < startLine) continue;
      
      // Stop after reaching the end of our chunk
      if (lineCount > endLine) break;
      
      // Skip header
      if (!headerSkipped) {
        headerSkipped = true;
        continue;
      }
      
      try {
        // Parse CSV line
        const row = line.split(',');
        const [ticker, volume, open, close, high, low, originalTimestamp, transactions] = row;
        
        if (!ticker || !originalTimestamp) continue;
        
        // Convert to date string for dimension
        const originalDate = new Date(Number(originalTimestamp) / 1000000);
        const dateStr = originalDate.toISOString().split('T')[0]; // YYYY-MM-DD format
        
        // Use shared base timestamp with small offset for each record
        const baseTimestamp = Date.now();
        
        // Add records for non-zero values
        if (volume && volume !== "0") {
          records.push({
            Dimensions: [
              { Name: 'ticker', Value: ticker },
              { Name: 'date', Value: dateStr }
            ],
            MeasureName: 'volume',
            MeasureValue: volume,
            MeasureValueType: 'DOUBLE',
            Time: (baseTimestamp).toString(),
            TimeUnit: 'MILLISECONDS'
          });
        }
        
        if (open && open !== "0") {
          records.push({
            Dimensions: [
              { Name: 'ticker', Value: ticker },
              { Name: 'date', Value: dateStr }
            ],
            MeasureName: 'open',
            MeasureValue: open,
            MeasureValueType: 'DOUBLE',
            Time: (baseTimestamp + 1).toString(),
            TimeUnit: 'MILLISECONDS'
          });
        }
        
        if (close && close !== "0") {
          records.push({
            Dimensions: [
              { Name: 'ticker', Value: ticker },
              { Name: 'date', Value: dateStr }
            ],
            MeasureName: 'close',
            MeasureValue: close,
            MeasureValueType: 'DOUBLE',
            Time: (baseTimestamp + 2).toString(),
            TimeUnit: 'MILLISECONDS'
          });
        }
        
        if (high && high !== "0") {
          records.push({
            Dimensions: [
              { Name: 'ticker', Value: ticker },
              { Name: 'date', Value: dateStr }
            ],
            MeasureName: 'high',
            MeasureValue: high,
            MeasureValueType: 'DOUBLE',
            Time: (baseTimestamp + 3).toString(),
            TimeUnit: 'MILLISECONDS'
          });
        }
        
        if (low && low !== "0") {
          records.push({
            Dimensions: [
              { Name: 'ticker', Value: ticker },
              { Name: 'date', Value: dateStr }
            ],
            MeasureName: 'low',
            MeasureValue: low,
            MeasureValueType: 'DOUBLE',
            Time: (baseTimestamp + 4).toString(),
            TimeUnit: 'MILLISECONDS'
          });
        }
        
        if (transactions && transactions !== "0") {
          records.push({
            Dimensions: [
              { Name: 'ticker', Value: ticker },
              { Name: 'date', Value: dateStr }
            ],
            MeasureName: 'transactions',
            MeasureValue: transactions,
            MeasureValueType: 'DOUBLE',
            Time: (baseTimestamp + 5).toString(),
            TimeUnit: 'MILLISECONDS'
          });
        }
      } catch (err) {
        // Skip lines with errors
        continue;
      }

      // When we've collected enough records, process them
      if (records.length >= RECORDS_PER_PROCESS_BATCH) {
        const result = await writeRecordsInBatches(records);
        successCount += result.success;
        failureCount += result.failure;
        
        // Send progress to parent
        process.send({
          type: 'progress',
          success: successCount,
          failure: failureCount
        });
        
        // Clear the records array
        records.length = 0;
      }
    }
    
    // Process any remaining records
    if (records.length > 0) {
      const result = await writeRecordsInBatches(records);
      successCount += result.success;
      failureCount += result.failure;
    }
    
    return { success: successCount, failure: failureCount };
  };
  
  // Write a batch of records to Timestream with parallelism
  async function writeRecordsInBatches(records) {
    let successCount = 0;
    let failureCount = 0;
    const batches = [];
    
    // Split records into batches of BATCH_SIZE
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      batches.push(records.slice(i, Math.min(i + BATCH_SIZE, records.length)));
    }
    
    // Process batches with limited concurrency
    for (let i = 0; i < batches.length; i += MAX_CONCURRENT_BATCHES) {
      const currentBatches = batches.slice(i, Math.min(i + MAX_CONCURRENT_BATCHES, batches.length));
      
      const batchPromises = currentBatches.map(async (batch) => {
        try {
          const params = {
            DatabaseName: TIMESTREAM_DB,
            TableName: TIMESTREAM_TABLE,
            Records: batch
          };
          
          const command = new WriteRecordsCommand(params);
          const response = await client.send(command);
          
          // Check for rejected records
          if (response.RejectedRecords && response.RejectedRecords.length > 0) {
            return {
              success: batch.length - response.RejectedRecords.length,
              failure: response.RejectedRecords.length
            };
          }
          
          return { success: batch.length, failure: 0 };
        } catch (error) {
          return { success: 0, failure: batch.length };
        }
      });
      
      const results = await Promise.all(batchPromises);
      
      // Sum up the successes and failures
      results.forEach(result => {
        successCount += result.success;
        failureCount += result.failure;
      });
      
      // Throttle a bit between large batch sets to avoid overloading AWS
      if (i + MAX_CONCURRENT_BATCHES < batches.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    return { success: successCount, failure: failureCount };
  }
  
  // Execute the processing and return results to parent
  processChunkFile()
    .then(result => {
      process.send({ type: 'complete', success: result.success, failure: result.failure });
    })
    .catch(error => {
      process.send({ type: 'error', message: error.message });
    });
}

// If this is a child process, run the processing function with the provided arguments
if (process.argv[2] === '--child') {
  const startLine = parseInt(process.argv[3]);
  const endLine = parseInt(process.argv[4]);
  processChunk(startLine, endLine);
} 
// This is the main process
else {
  const startTime = Date.now();
  
  // Count the total lines in the CSV file
  async function countLines() {
    console.log(`Counting lines in ${CSV_FILE_PATH}...`);
    const fileStream = fs.createReadStream(CSV_FILE_PATH);
    const rl = require('readline').createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });
    
    let count = 0;
    for await (const line of rl) {
      count++;
    }
    
    console.log(`Total lines in CSV: ${count}`);
    return count;
  }
  
  // Main function to orchestrate the parallel processing
  async function processCSVParallel() {
    console.log(`Starting parallel import of CSV file: ${CSV_FILE_PATH}`);
    console.log(`Using ${NUM_PROCESSES} processes with up to ${MAX_CONCURRENT_BATCHES} concurrent API calls`);
    
    // Delete and recreate the table first
    console.log('=== STEP 1: Removing existing data ===');
    const tableDeleted = await deleteTimestreamTable();
    if (!tableDeleted) {
      console.error('Failed to delete the table. Aborting import.');
      return;
    }
    
    console.log('=== STEP 2: Creating fresh table ===');
    const tableCreated = await createTimestreamTable();
    if (!tableCreated) {
      console.error('Failed to create the table. Aborting import.');
      return;
    }
    
    // Count total lines
    console.log('=== STEP 3: Importing data ===');
    const totalLines = await countLines();
    const linesPerProcess = Math.ceil((totalLines - 1) / NUM_PROCESSES); // Account for header
    
    let activeProcesses = 0;
    let totalSuccess = 0;
    let totalFailure = 0;
    let completedProcesses = 0;
    
    // Create ranges for each process
    const processRanges = [];
    for (let i = 0; i < NUM_PROCESSES; i++) {
      const start = i * linesPerProcess + 1; // +1 for header
      const end = Math.min(start + linesPerProcess - 1, totalLines);
      processRanges.push({ start, end });
    }
    
    // Create a map to track progress for each process
    const processProgress = new Map();
    
    // Function to spawn a child process
    function spawnChildProcess(range, processIndex) {
      return new Promise((resolve, reject) => {
        console.log(`Starting process ${processIndex + 1} for lines ${range.start} to ${range.end}`);
        
        const child = spawn('node', [
          __filename,
          '--child',
          range.start.toString(),
          range.end.toString()
        ]);
        
        activeProcesses++;
        processProgress.set(processIndex, { success: 0, failure: 0 });
        
        // Handle messages from the child process
        child.on('message', (message) => {
          if (message.type === 'progress') {
            processProgress.set(processIndex, { 
              success: message.success, 
              failure: message.failure 
            });
            
            // Log overall progress
            const totalProgressSuccess = Array.from(processProgress.values())
              .reduce((sum, current) => sum + current.success, 0);
            const totalProgressFailure = Array.from(processProgress.values())
              .reduce((sum, current) => sum + current.failure, 0);
            
            const elapsedSeconds = (Date.now() - startTime) / 1000;
            const recordsPerSecond = Math.round((totalProgressSuccess + totalProgressFailure) / elapsedSeconds);
            
            console.log(`Progress: ${totalProgressSuccess + totalProgressFailure} records processed (${totalProgressSuccess} succeeded, ${totalProgressFailure} failed)`);
            console.log(`Processing speed: ${recordsPerSecond} records/second`);
          } else if (message.type === 'complete') {
            totalSuccess += message.success;
            totalFailure += message.failure;
            
            console.log(`Process ${processIndex + 1} completed: ${message.success} succeeded, ${message.failure} failed`);
            
            activeProcesses--;
            completedProcesses++;
            resolve();
          } else if (message.type === 'error') {
            console.error(`Process ${processIndex + 1} error: ${message.message}`);
            activeProcesses--;
            reject(new Error(message.message));
          }
        });
        
        // Handle process exit
        child.on('exit', (code) => {
          if (code !== 0 && activeProcesses > 0) {
            console.error(`Process ${processIndex + 1} exited with code ${code}`);
            activeProcesses--;
            reject(new Error(`Process exited with code ${code}`));
          }
        });
        
        // Handle stderr
        child.stderr.on('data', (data) => {
          console.error(`Process ${processIndex + 1} error: ${data.toString()}`);
        });
      });
    }
    
    // Spawn processes and wait for all to complete
    try {
      const processPromises = processRanges.map((range, index) => 
        spawnChildProcess(range, index)
      );
      
      await Promise.all(processPromises);
      
      const elapsedSeconds = (Date.now() - startTime) / 1000;
      const totalRecords = totalSuccess + totalFailure;
      const recordsPerSecond = Math.round(totalRecords / elapsedSeconds);
      
      console.log('\nCSV import complete!');
      console.log(`Total records processed: ${totalRecords}`);
      console.log(`Successfully imported: ${totalSuccess} records`);
      console.log(`Failed records: ${totalFailure}`);
      console.log(`Total time: ${Math.round(elapsedSeconds)} seconds`);
      console.log(`Average speed: ${recordsPerSecond} records per second`);
    } catch (error) {
      console.error('Error in parallel processing:', error);
    }
  }
  
  // Run the main function
  processCSVParallel()
    .then(() => {
      console.log('Import completed successfully');
      process.exit(0);
    })
    .catch(error => {
      console.error('Import failed:', error);
      process.exit(1);
    });
} 