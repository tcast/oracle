const fs = require('fs');
const readline = require('readline');
const { TimestreamWriteClient, WriteRecordsCommand } = require('@aws-sdk/client-timestream-write');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os');

// Configuration
const REGION = 'us-east-1';
const TIMESTREAM_DB = 'oracle';
const TIMESTREAM_TABLE = 'stock_prices';
const CSV_FILE_PATH = '/Users/tcast/Downloads/polygon/combined_stock_data.csv';
const BATCH_SIZE = 100; // Maximum allowed by Timestream
const MAX_CONCURRENT_REQUESTS = 25; // Maximum concurrent API calls
const NUM_WORKERS = Math.max(1, Math.min(os.cpus().length - 1, 8)); // Use up to CPU count-1 workers, max 8
const PROGRESS_INTERVAL = 100000; // Log progress every N records
const WORKER_CHUNK_SIZE = 50000; // Records per worker

// This code will run in worker threads
if (!isMainThread) {
    const { records, region, database, table } = workerData;
    
    const writeClient = new TimestreamWriteClient({ region });
    
    async function processRecords() {
        let successCount = 0;
        let failureCount = 0;
        const batches = [];
        
        // Split into batches of BATCH_SIZE
        for (let i = 0; i < records.length; i += BATCH_SIZE) {
            batches.push(records.slice(i, Math.min(i + BATCH_SIZE, records.length)));
        }
        
        // Process batches with concurrency control
        const results = [];
        for (let i = 0; i < batches.length; i += MAX_CONCURRENT_REQUESTS) {
            const batchPromises = batches
                .slice(i, Math.min(i + MAX_CONCURRENT_REQUESTS, batches.length))
                .map(async (batch, batchIndex) => {
                    try {
                        const params = {
                            DatabaseName: database,
                            TableName: table,
                            Records: batch
                        };
                        
                        const command = new WriteRecordsCommand(params);
                        const response = await writeClient.send(command);
                        
                        // Check for rejected records
                        if (response.RejectedRecords && response.RejectedRecords.length > 0) {
                            return { 
                                success: batch.length - response.RejectedRecords.length, 
                                failure: response.RejectedRecords.length 
                            };
                        }
                        
                        return { 
                            success: batch.length, 
                            failure: 0 
                        };
                    } catch (error) {
                        return { 
                            success: 0, 
                            failure: batch.length,
                            error: error.message
                        };
                    }
                });
            
            // Wait for the current set of batches to complete
            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults);
            
            // Throttle a bit between large concurrent batch sets
            if (i + MAX_CONCURRENT_REQUESTS < batches.length) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        
        // Calculate totals
        results.forEach(result => {
            successCount += result.success;
            failureCount += result.failure;
        });
        
        return { successCount, failureCount };
    }
    
    // Run the worker
    processRecords()
        .then(result => {
            parentPort.postMessage({ 
                type: 'complete', 
                successCount: result.successCount, 
                failureCount: result.failureCount 
            });
        })
        .catch(error => {
            parentPort.postMessage({ 
                type: 'error', 
                message: error.message 
            });
        });
}
// This code runs in the main thread
else {
    // Convert CSV row to Timestream records
    function convertRowToTimestreams(row) {
        try {
            const [ticker, volume, open, close, high, low, originalTimestamp, transactions] = row;
            
            // Skip if essential fields are missing
            if (!ticker || !originalTimestamp) {
                return null;
            }
            
            // Convert original timestamp to a readable date string for dimension
            const originalDate = new Date(Number(originalTimestamp) / 1000000);
            const dateStr = originalDate.toISOString().split('T')[0]; // YYYY-MM-DD format
            
            // Use current time plus a small offset for each record to avoid collisions
            const currentTimeMs = Date.now();
            
            // Create measure records for each value
            const records = [];
            
            // Skip zero values to reduce record count
            if (volume && volume !== "0") {
                records.push({
                    Dimensions: [
                        { Name: 'ticker', Value: ticker },
                        { Name: 'date', Value: dateStr },
                        { Name: 'original_timestamp', Value: originalTimestamp }
                    ],
                    MeasureName: 'volume',
                    MeasureValue: volume,
                    MeasureValueType: 'DOUBLE',
                    Time: currentTimeMs.toString(),
                    TimeUnit: 'MILLISECONDS'
                });
            }
            
            if (open && open !== "0") {
                records.push({
                    Dimensions: [
                        { Name: 'ticker', Value: ticker },
                        { Name: 'date', Value: dateStr },
                        { Name: 'original_timestamp', Value: originalTimestamp }
                    ],
                    MeasureName: 'open',
                    MeasureValue: open,
                    MeasureValueType: 'DOUBLE',
                    Time: (currentTimeMs + 1).toString(), // Offset to avoid timestamp collisions
                    TimeUnit: 'MILLISECONDS'
                });
            }
            
            if (close && close !== "0") {
                records.push({
                    Dimensions: [
                        { Name: 'ticker', Value: ticker },
                        { Name: 'date', Value: dateStr },
                        { Name: 'original_timestamp', Value: originalTimestamp }
                    ],
                    MeasureName: 'close',
                    MeasureValue: close,
                    MeasureValueType: 'DOUBLE',
                    Time: (currentTimeMs + 2).toString(), // Offset to avoid timestamp collisions
                    TimeUnit: 'MILLISECONDS'
                });
            }
            
            if (high && high !== "0") {
                records.push({
                    Dimensions: [
                        { Name: 'ticker', Value: ticker },
                        { Name: 'date', Value: dateStr },
                        { Name: 'original_timestamp', Value: originalTimestamp }
                    ],
                    MeasureName: 'high',
                    MeasureValue: high,
                    MeasureValueType: 'DOUBLE',
                    Time: (currentTimeMs + 3).toString(), // Offset to avoid timestamp collisions
                    TimeUnit: 'MILLISECONDS'
                });
            }
            
            if (low && low !== "0") {
                records.push({
                    Dimensions: [
                        { Name: 'ticker', Value: ticker },
                        { Name: 'date', Value: dateStr },
                        { Name: 'original_timestamp', Value: originalTimestamp }
                    ],
                    MeasureName: 'low',
                    MeasureValue: low,
                    MeasureValueType: 'DOUBLE',
                    Time: (currentTimeMs + 4).toString(), // Offset to avoid timestamp collisions
                    TimeUnit: 'MILLISECONDS'
                });
            }
            
            if (transactions && transactions !== "0") {
                records.push({
                    Dimensions: [
                        { Name: 'ticker', Value: ticker },
                        { Name: 'date', Value: dateStr },
                        { Name: 'original_timestamp', Value: originalTimestamp }
                    ],
                    MeasureName: 'transactions',
                    MeasureValue: transactions,
                    MeasureValueType: 'DOUBLE',
                    Time: (currentTimeMs + 5).toString(), // Offset to avoid timestamp collisions
                    TimeUnit: 'MILLISECONDS'
                });
            }
            
            return records;
        } catch (error) {
            console.error('Error converting row to records:', error.message);
            return null;
        }
    }

    // Main function to process the CSV file
    async function processCSV() {
        console.log(`Processing CSV file: ${CSV_FILE_PATH}`);
        console.log(`Using ${NUM_WORKERS} worker threads with up to ${MAX_CONCURRENT_REQUESTS} concurrent API calls`);
        
        // Create readline interface
        const fileStream = fs.createReadStream(CSV_FILE_PATH);
        const rl = readline.createInterface({
            input: fileStream,
            crlfDelay: Infinity
        });
        
        let lineCount = 0;
        let recordsCount = 0;
        let totalSuccess = 0;
        let totalFailure = 0;
        let records = [];
        let activeWorkers = 0;
        const startTime = Date.now();
        
        // Function to spawn a worker with a batch of records
        function spawnWorker(workerRecords) {
            return new Promise((resolve, reject) => {
                activeWorkers++;
                
                const worker = new Worker(__filename, {
                    workerData: {
                        records: workerRecords,
                        region: REGION,
                        database: TIMESTREAM_DB,
                        table: TIMESTREAM_TABLE
                    }
                });
                
                worker.on('message', message => {
                    if (message.type === 'complete') {
                        totalSuccess += message.successCount;
                        totalFailure += message.failureCount;
                        
                        const elapsedSeconds = (Date.now() - startTime) / 1000;
                        const recordsPerSecond = Math.round((totalSuccess + totalFailure) / elapsedSeconds);
                        
                        console.log(`Worker completed: ${message.successCount} succeeded, ${message.failureCount} failed`);
                        console.log(`Total progress: ${totalSuccess + totalFailure} records processed (${totalSuccess} succeeded, ${totalFailure} failed)`);
                        console.log(`Processing speed: ${recordsPerSecond} records/second`);
                        
                        activeWorkers--;
                        resolve();
                    } else if (message.type === 'error') {
                        console.error(`Worker error: ${message.message}`);
                        activeWorkers--;
                        reject(new Error(message.message));
                    }
                });
                
                worker.on('error', error => {
                    console.error(`Worker error: ${error.message}`);
                    activeWorkers--;
                    reject(error);
                });
                
                worker.on('exit', code => {
                    if (code !== 0) {
                        console.error(`Worker exited with code ${code}`);
                        activeWorkers--;
                        reject(new Error(`Worker exited with code ${code}`));
                    }
                });
            });
        }
        
        console.log('Reading CSV file...');
        
        // Process line by line
        for await (const line of rl) {
            lineCount++;
            
            // Skip header line
            if (lineCount === 1) {
                console.log(`CSV Headers: ${line}`);
                continue;
            }
            
            // Parse CSV line
            const row = line.split(',');
            
            // Convert row to Timestream records
            const rowRecords = convertRowToTimestreams(row);
            if (rowRecords && rowRecords.length > 0) {
                records.push(...rowRecords);
                recordsCount += rowRecords.length;
            }
            
            // When we have collected enough records, spawn a worker
            if (records.length >= WORKER_CHUNK_SIZE) {
                // Wait if we already have the maximum number of workers
                while (activeWorkers >= NUM_WORKERS) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                
                // Spawn a worker with the collected records
                const workerRecords = records;
                records = [];
                
                spawnWorker(workerRecords).catch(error => {
                    console.error(`Worker failed: ${error.message}`);
                });
            }
            
            // Log progress
            if (lineCount % PROGRESS_INTERVAL === 0) {
                const elapsedSeconds = (Date.now() - startTime) / 1000;
                const linesPerSecond = Math.round(lineCount / elapsedSeconds);
                const recordsPerSecond = Math.round(recordsCount / elapsedSeconds);
                
                console.log(`Read ${lineCount} lines, generated ${recordsCount} records`);
                console.log(`Reading speed: ${linesPerSecond} lines/second, ${recordsPerSecond} records/second`);
                console.log(`Active workers: ${activeWorkers}`);
            }
        }
        
        // Process any remaining records
        if (records.length > 0) {
            // Wait if we already have the maximum number of workers
            while (activeWorkers >= NUM_WORKERS) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            
            // Spawn a worker with the remaining records
            const workerRecords = records;
            records = [];
            
            spawnWorker(workerRecords).catch(error => {
                console.error(`Worker failed: ${error.message}`);
            });
        }
        
        // Wait for all workers to complete
        while (activeWorkers > 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        const elapsedSeconds = (Date.now() - startTime) / 1000;
        const totalRecords = totalSuccess + totalFailure;
        const recordsPerSecond = Math.round(totalRecords / elapsedSeconds);
        
        console.log('\nCSV import complete!');
        console.log(`Total lines read: ${lineCount}`);
        console.log(`Total records processed: ${totalRecords}`);
        console.log(`Successfully imported: ${totalSuccess} records`);
        console.log(`Failed records: ${totalFailure} records`);
        console.log(`Total time: ${Math.round(elapsedSeconds)} seconds`);
        console.log(`Average speed: ${recordsPerSecond} records per second`);
    }

    // Run the main function
    processCSV()
        .then(() => {
            console.log('Import completed successfully');
            process.exit(0);
        })
        .catch(error => {
            console.error('Import failed:', error);
            process.exit(1);
        });
} 