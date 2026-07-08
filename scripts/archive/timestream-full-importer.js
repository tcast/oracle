const fs = require('fs');
const readline = require('readline');
const { TimestreamWriteClient, WriteRecordsCommand, DeleteTableCommand, CreateTableCommand } = require('@aws-sdk/client-timestream-write');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os');

// Configuration
const REGION = 'us-east-1';
const TIMESTREAM_DB = 'oracle';
const TIMESTREAM_TABLE = 'stock_prices';
const CSV_FILE_PATH = '/Users/tcast/Downloads/polygon/combined_stock_data.csv';
const BATCH_SIZE = 75; // Good balance based on testing
const MAX_CONCURRENT_BATCHES = 20; // Prevent throttling
const NUM_WORKERS = Math.max(1, os.cpus().length - 1); // Use all but one CPU core
const REPORT_PROGRESS_INTERVAL = 60000; // Report progress every minute

// If this is a worker thread, execute the worker function
if (!isMainThread) {
  workerFunction();
} else {
  // Main thread execution

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
          MagneticStoreRetentionPeriodInDays: 365 * 3 // 3 years retention
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

  // Function to count total lines in CSV
  async function countLines() {
    console.log(`Counting lines in ${CSV_FILE_PATH}...`);
    const fileStream = fs.createReadStream(CSV_FILE_PATH);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });
    
    let count = 0;
    for await (const line of rl) {
      count++;
    }
    
    console.log(`Total lines in CSV: ${count} (including header)`);
    return count;
  }

  // Main function to orchestrate the import
  async function importAllData() {
    console.log(`Starting import of entire CSV file using ${NUM_WORKERS} worker threads`);
    
    // Delete and recreate the table
    console.log('=== STEP 1: Removing existing data ===');
    const tableDeleted = await deleteTable();
    if (!tableDeleted) {
      console.error('Failed to delete the table. Aborting import.');
      return false;
    }
    
    console.log('=== STEP 2: Creating fresh table ===');
    const tableCreated = await createTable();
    if (!tableCreated) {
      console.error('Failed to create the table. Aborting import.');
      return false;
    }
    
    console.log('=== STEP 3: Processing CSV data with worker threads ===');
    
    // Count lines to distribute work
    const totalLines = await countLines();
    const linesPerWorker = Math.floor((totalLines - 1) / NUM_WORKERS); // Exclude header
    
    // For tracking progress
    const startTime = Date.now();
    let totalSuccessCount = 0;
    let totalFailureCount = 0;
    
    // Start regular progress reporting
    const progressTimer = setInterval(() => {
      const elapsedMinutes = (Date.now() - startTime) / 60000;
      const recordsPerMinute = Math.round((totalSuccessCount + totalFailureCount) / elapsedMinutes);
      
      console.log(`Progress: ${totalSuccessCount.toLocaleString()} records imported successfully, ${totalFailureCount.toLocaleString()} failed`);
      console.log(`Elapsed time: ${elapsedMinutes.toFixed(2)} minutes, speed: ${recordsPerMinute.toLocaleString()} records/minute`);
    }, REPORT_PROGRESS_INTERVAL);
    
    // Create and run workers
    const workerPromises = [];
    
    for (let i = 0; i < NUM_WORKERS; i++) {
      const startLine = i * linesPerWorker + 1; // Start after header (line 0)
      const endLine = (i === NUM_WORKERS - 1) ? totalLines : startLine + linesPerWorker - 1;
      
      console.log(`Starting worker ${i + 1} to process lines ${startLine} to ${endLine}`);
      
      const worker = new Worker(__filename, {
        workerData: {
          workerId: i + 1,
          startLine,
          endLine,
          region: REGION,
          database: TIMESTREAM_DB,
          table: TIMESTREAM_TABLE,
          csvPath: CSV_FILE_PATH,
          batchSize: BATCH_SIZE,
          maxConcurrentBatches: MAX_CONCURRENT_BATCHES
        }
      });
      
      // Handle messages from workers
      worker.on('message', (message) => {
        if (message.type === 'progress') {
          totalSuccessCount += message.success;
          totalFailureCount += message.failure;
        }
      });
      
      // Create a promise that resolves when the worker completes
      const workerPromise = new Promise((resolve, reject) => {
        worker.on('exit', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Worker ${i + 1} exited with code ${code}`));
          }
        });
        
        worker.on('error', (err) => {
          reject(err);
        });
      });
      
      workerPromises.push(workerPromise);
    }
    
    // Wait for all workers to complete
    try {
      await Promise.all(workerPromises);
      
      // Stop progress reporting
      clearInterval(progressTimer);
      
      const elapsedSeconds = (Date.now() - startTime) / 1000;
      const recordsPerSecond = Math.round((totalSuccessCount + totalFailureCount) / elapsedSeconds);
      
      console.log('\nImport complete!');
      console.log(`Successfully imported: ${totalSuccessCount.toLocaleString()} records`);
      console.log(`Failed records: ${totalFailureCount.toLocaleString()}`);
      console.log(`Total time: ${(elapsedSeconds / 60).toFixed(2)} minutes`);
      console.log(`Average speed: ${recordsPerSecond.toLocaleString()} records per second`);
      
      return true;
    } catch (error) {
      clearInterval(progressTimer);
      console.error('Error during import:', error);
      return false;
    }
  }

  // Run the main function
  importAllData()
    .then(success => {
      if (success) {
        console.log('CSV import completed successfully');
      } else {
        console.error('CSV import failed');
      }
      process.exit(success ? 0 : 1);
    })
    .catch(error => {
      console.error('Fatal error during import:', error);
      process.exit(1);
    });
}

// Worker thread function to process a chunk of the CSV file
async function workerFunction() {
  const { 
    workerId, 
    startLine, 
    endLine, 
    region, 
    database, 
    table, 
    csvPath, 
    batchSize, 
    maxConcurrentBatches 
  } = workerData;
  
  // Initialize client for this worker
  const client = new TimestreamWriteClient({ region });
  
  // Track progress
  let processedLines = 0;
  let successCount = 0;
  let failureCount = 0;
  const totalLines = endLine - startLine + 1;
  const reportInterval = Math.floor(totalLines / 20); // Report ~20 times during processing
  
  // Function to write records to Timestream
  async function writeRecordBatch(records) {
    try {
      const params = {
        DatabaseName: database,
        TableName: table,
        Records: records
      };
      
      const command = new WriteRecordsCommand(params);
      const response = await client.send(command);
      
      // Check for rejected records
      if (response.RejectedRecords && response.RejectedRecords.length > 0) {
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
      // Implement exponential backoff for throttling errors
      if (error.name === 'ThrottlingException') {
        // Wait and retry once
        await new Promise(resolve => setTimeout(resolve, 1000));
        try {
          const params = {
            DatabaseName: database,
            TableName: table,
            Records: records
          };
          
          const command = new WriteRecordsCommand(params);
          const response = await client.send(command);
          
          if (response.RejectedRecords && response.RejectedRecords.length > 0) {
            return {
              success: records.length - response.RejectedRecords.length,
              failure: response.RejectedRecords.length
            };
          }
          
          return {
            success: records.length,
            failure: 0
          };
        } catch (retryError) {
          return {
            success: 0,
            failure: records.length
          };
        }
      }
      
      return {
        success: 0,
        failure: records.length
      };
    }
  }
  
  // Function to process batches of records with controlled concurrency
  async function processBatches(batches) {
    let totalSuccess = 0;
    let totalFailure = 0;
    
    // Process batches with limited concurrency
    for (let i = 0; i < batches.length; i += maxConcurrentBatches) {
      const currentBatches = batches.slice(i, Math.min(i + maxConcurrentBatches, batches.length));
      
      const batchPromises = currentBatches.map(batch => writeRecordBatch(batch));
      const results = await Promise.all(batchPromises);
      
      // Sum up the successes and failures
      results.forEach(result => {
        totalSuccess += result.success;
        totalFailure += result.failure;
      });
      
      // If not the last batch, add a small delay to avoid throttling
      if (i + maxConcurrentBatches < batches.length) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    
    return { success: totalSuccess, failure: totalFailure };
  }
  
  try {
    // Process the assigned range of the CSV file
    const fileStream = fs.createReadStream(csvPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });
    
    let lineCount = 0;
    let currentBatches = [];
    let currentBatch = [];
    
    for await (const line of rl) {
      lineCount++;
      
      // Skip lines outside our range
      if (lineCount < startLine || lineCount > endLine) {
        // Skip header or lines not assigned to this worker
        if (lineCount <= endLine) continue;
        else break; // We've passed our range, stop processing
      }
      
      try {
        // Parse CSV line
        const row = line.split(',');
        const [ticker, volume, open, close, high, low, originalTimestamp, transactions] = row;
        
        if (!ticker || !originalTimestamp) continue;
        
        // Convert to date string for dimension
        const timestamp = Number(originalTimestamp);
        if (isNaN(timestamp)) continue;
        
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
        
        // When the batch reaches the size limit, add it to the batches array
        if (currentBatch.length >= batchSize) {
          currentBatches.push(currentBatch);
          currentBatch = [];
        }
        
        // When we have accumulated enough batches, process them
        if (currentBatches.length >= maxConcurrentBatches) {
          const result = await processBatches(currentBatches);
          successCount += result.success;
          failureCount += result.failure;
          
          // Report progress to main thread
          parentPort.postMessage({
            type: 'progress',
            success: result.success,
            failure: result.failure
          });
          
          currentBatches = [];
        }
        
        processedLines++;
        
        // Report progress occasionally
        if (processedLines % reportInterval === 0 || processedLines === totalLines) {
          const percentComplete = Math.round((processedLines / totalLines) * 100);
          console.log(`Worker ${workerId}: ${percentComplete}% complete, processed ${processedLines.toLocaleString()} of ${totalLines.toLocaleString()} lines`);
        }
      } catch (err) {
        // Skip lines with errors
        continue;
      }
    }
    
    // Process any remaining batches
    if (currentBatch.length > 0) {
      currentBatches.push(currentBatch);
    }
    
    if (currentBatches.length > 0) {
      const result = await processBatches(currentBatches);
      successCount += result.success;
      failureCount += result.failure;
      
      // Report final progress
      parentPort.postMessage({
        type: 'progress',
        success: result.success,
        failure: result.failure
      });
    }
    
    console.log(`Worker ${workerId} completed: processed ${processedLines.toLocaleString()} lines, ${successCount.toLocaleString()} records succeeded, ${failureCount.toLocaleString()} failed`);
    process.exit(0);
  } catch (error) {
    console.error(`Worker ${workerId} error:`, error);
    process.exit(1);
  }
} 