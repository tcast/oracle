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
const LOG_DIR = path.join(__dirname, 'logs');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

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
        MagneticStoreRetentionPeriodInDays: 365 * 3 // 3 years retention
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

// This function creates a separate child process for each chunk
async function processChunkInWorker(startLine, endLine, processIndex) {
  return new Promise((resolve, reject) => {
    const progressLogPath = path.join(LOG_DIR, `process_${processIndex}_progress.json`);
    const resultLogPath = path.join(LOG_DIR, `process_${processIndex}_result.json`);
    
    // Create an initial progress file
    fs.writeFileSync(progressLogPath, JSON.stringify({ 
      success: 0, 
      failure: 0,
      processing: true,
      startLine,
      endLine,
      lastUpdate: new Date().toISOString()
    }));
    
    console.log(`Starting worker process ${processIndex} for lines ${startLine} to ${endLine}`);
    
    // Create a separate JavaScript file for this worker
    const workerPath = path.join(__dirname, `worker_${processIndex}.js`);
    const workerCode = `
      const fs = require('fs');
      const { TimestreamWriteClient, WriteRecordsCommand } = require('@aws-sdk/client-timestream-write');
      
      // Configuration from parent
      const REGION = '${REGION}';
      const TIMESTREAM_DB = '${TIMESTREAM_DB}';
      const TIMESTREAM_TABLE = '${TIMESTREAM_TABLE}';
      const CSV_FILE_PATH = '${CSV_FILE_PATH}';
      const BATCH_SIZE = ${BATCH_SIZE};
      const MAX_CONCURRENT_BATCHES = ${MAX_CONCURRENT_BATCHES};
      const RECORDS_PER_PROCESS_BATCH = ${RECORDS_PER_PROCESS_BATCH};
      const START_LINE = ${startLine};
      const END_LINE = ${endLine};
      const PROCESS_INDEX = ${processIndex};
      const PROGRESS_LOG_PATH = '${progressLogPath}';
      const RESULT_LOG_PATH = '${resultLogPath}';
      
      // Initialize client
      const client = new TimestreamWriteClient({ region: REGION });
      
      // Function to update progress
      function updateProgress(success, failure) {
        try {
          const progress = { 
            success, 
            failure,
            processing: true,
            startLine: START_LINE,
            endLine: END_LINE,
            lastUpdate: new Date().toISOString()
          };
          fs.writeFileSync(PROGRESS_LOG_PATH, JSON.stringify(progress));
        } catch (error) {
          console.error('Error updating progress:', error);
        }
      }
      
      // Function to write final result
      function writeResult(success, failure, error = null) {
        try {
          const result = { 
            success, 
            failure,
            error: error ? error.toString() : null,
            processing: false,
            completed: !error,
            startLine: START_LINE,
            endLine: END_LINE,
            completedAt: new Date().toISOString()
          };
          fs.writeFileSync(RESULT_LOG_PATH, JSON.stringify(result));
          fs.writeFileSync(PROGRESS_LOG_PATH, JSON.stringify({ 
            ...result,
            processing: false
          }));
        } catch (writeError) {
          console.error('Error writing result:', writeError);
        }
      }
      
      // Process the chunk of the CSV file
      async function processChunkFile() {
        const records = [];
        let successCount = 0;
        let failureCount = 0;
        let lineCount = 0;
        let headerSkipped = false;
        let lastProgressUpdate = Date.now();
        const PROGRESS_UPDATE_INTERVAL = 5000; // 5 seconds
      
        try {
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
            if (lineCount < START_LINE) continue;
            
            // Stop after reaching the end of our chunk
            if (lineCount > END_LINE) break;
            
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
              
              // Update progress at intervals to avoid too many file writes
              const now = Date.now();
              if (now - lastProgressUpdate > PROGRESS_UPDATE_INTERVAL) {
                updateProgress(successCount, failureCount);
                lastProgressUpdate = now;
              }
              
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
          
          // Write final result
          writeResult(successCount, failureCount);
          
          return { success: successCount, failure: failureCount };
        } catch (error) {
          console.error('Error in process chunk:', error);
          writeResult(successCount, failureCount, error);
          throw error;
        }
      }
      
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
              console.error('Error writing batch:', error.message);
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
      
      // Execute the processing
      processChunkFile()
        .then(() => {
          console.log(\`Worker \${PROCESS_INDEX} completed successfully\`);
          process.exit(0);
        })
        .catch(error => {
          console.error(\`Worker \${PROCESS_INDEX} failed:\`, error);
          process.exit(1);
        });
    `;
    
    // Write the worker script to a file
    fs.writeFileSync(workerPath, workerCode);
    
    // Spawn the worker as a new Node.js process
    const worker = spawn('node', [workerPath]);
    
    // Handle worker output
    worker.stdout.on('data', (data) => {
      console.log(`Worker ${processIndex} output: ${data.toString().trim()}`);
    });
    
    worker.stderr.on('data', (data) => {
      console.error(`Worker ${processIndex} error: ${data.toString().trim()}`);
    });
    
    // Handle worker exit
    worker.on('exit', (code) => {
      if (code === 0) {
        // Read the result file
        try {
          if (fs.existsSync(resultLogPath)) {
            const resultData = JSON.parse(fs.readFileSync(resultLogPath, 'utf8'));
            console.log(`Worker ${processIndex} completed: ${resultData.success} succeeded, ${resultData.failure} failed`);
            resolve(resultData);
          } else {
            console.error(`Worker ${processIndex} did not produce a result file`);
            reject(new Error(`Worker ${processIndex} did not produce a result file`));
          }
        } catch (error) {
          console.error(`Error reading result from worker ${processIndex}:`, error);
          reject(error);
        }
      } else {
        console.error(`Worker ${processIndex} exited with code ${code}`);
        reject(new Error(`Worker ${processIndex} exited with code ${code}`));
      }
      
      // Clean up the worker script
      try {
        fs.unlinkSync(workerPath);
      } catch (err) {
        console.error(`Failed to clean up worker script ${workerPath}:`, err);
      }
    });
  });
}

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

// Function to read worker progress
function readWorkerProgress() {
  const progressFiles = fs.readdirSync(LOG_DIR)
    .filter(file => file.match(/process_\d+_progress\.json/));
  
  let totalSuccess = 0;
  let totalFailure = 0;
  let active = 0;
  
  progressFiles.forEach(file => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(LOG_DIR, file), 'utf8'));
      totalSuccess += data.success;
      totalFailure += data.failure;
      if (data.processing) {
        active++;
      }
    } catch (error) {
      console.error(`Error reading progress file ${file}:`, error);
    }
  });
  
  return { success: totalSuccess, failure: totalFailure, active };
}

// Main function to orchestrate the parallel processing
async function processCSVParallel() {
  const startTime = Date.now();
  
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
  
  // Create ranges for each process
  const processRanges = [];
  for (let i = 0; i < NUM_PROCESSES; i++) {
    const start = i * linesPerProcess + 1; // +1 for header
    const end = Math.min(start + linesPerProcess - 1, totalLines);
    processRanges.push({ start, end, index: i + 1 });
  }
  
  // Start progress monitoring
  const progressInterval = setInterval(() => {
    const progress = readWorkerProgress();
    const elapsedSeconds = (Date.now() - startTime) / 1000;
    const recordsProcessed = progress.success + progress.failure;
    const recordsPerSecond = Math.round(recordsProcessed / elapsedSeconds);
    
    console.log(`Progress: ${recordsProcessed.toLocaleString()} records processed (${progress.success.toLocaleString()} succeeded, ${progress.failure.toLocaleString()} failed)`);
    console.log(`Processing speed: ${recordsPerSecond.toLocaleString()} records/second, ${progress.active} workers active`);
    
    if (progress.active === 0) {
      clearInterval(progressInterval);
    }
  }, 10000);
  
  // Launch all worker processes
  try {
    const workerPromises = processRanges.map(range => 
      processChunkInWorker(range.start, range.end, range.index)
    );
    
    const results = await Promise.allSettled(workerPromises);
    
    // Stop the progress monitoring
    clearInterval(progressInterval);
    
    // Calculate final statistics
    let totalSuccess = 0;
    let totalFailure = 0;
    let succeededWorkers = 0;
    let failedWorkers = 0;
    
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        totalSuccess += result.value.success;
        totalFailure += result.value.failure;
        succeededWorkers++;
      } else {
        console.error(`Worker ${index + 1} failed:`, result.reason);
        failedWorkers++;
      }
    });
    
    const elapsedSeconds = (Date.now() - startTime) / 1000;
    const totalRecords = totalSuccess + totalFailure;
    const recordsPerSecond = Math.round(totalRecords / elapsedSeconds);
    
    console.log('\nCSV import complete!');
    console.log(`Total workers: ${NUM_PROCESSES}, succeeded: ${succeededWorkers}, failed: ${failedWorkers}`);
    console.log(`Total records processed: ${totalRecords.toLocaleString()}`);
    console.log(`Successfully imported: ${totalSuccess.toLocaleString()} records`);
    console.log(`Failed records: ${totalFailure.toLocaleString()}`);
    console.log(`Total time: ${Math.round(elapsedSeconds)} seconds`);
    console.log(`Average speed: ${recordsPerSecond.toLocaleString()} records per second`);
    
    return { success: totalSuccess, failure: totalFailure };
  } catch (error) {
    clearInterval(progressInterval);
    console.error('Error in parallel processing:', error);
    return { success: 0, failure: 0, error };
  } finally {
    // Clean up any temporary worker files
    try {
      const workerFiles = fs.readdirSync(__dirname)
        .filter(file => file.match(/^worker_\d+\.js$/));
      
      workerFiles.forEach(file => {
        try {
          fs.unlinkSync(path.join(__dirname, file));
        } catch (error) {
          console.error(`Failed to clean up worker file ${file}:`, error);
        }
      });
    } catch (error) {
      console.error('Error cleaning up worker files:', error);
    }
  }
}

// Run the main function if this is the parent process
if (require.main === module) {
  processCSVParallel()
    .then((result) => {
      if (result.error) {
        console.error('Import failed with errors');
        process.exit(1);
      } else {
        console.log('Import completed successfully');
        process.exit(0);
      }
    })
    .catch(error => {
      console.error('Import failed:', error);
      process.exit(1);
    });
} 