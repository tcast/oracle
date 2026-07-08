const fs = require('fs');
const readline = require('readline');
const { TimestreamWriteClient, WriteRecordsCommand } = require('@aws-sdk/client-timestream-write');

// Configuration
const REGION = 'us-east-1';
const TIMESTREAM_DB = 'oracle';
const TIMESTREAM_TABLE = 'stock_prices';
const CSV_FILE_PATH = '/Users/tcast/Downloads/polygon/combined_stock_data.csv';
const BATCH_SIZE = 100; // Timestream limit per write operation
const MAX_RECORDS_PER_RUN = 5000; // Process this many records at a time
let SHOW_SAMPLE_DATA = true; // Set to true to show sample data

// Initialize client
const writeClient = new TimestreamWriteClient({ region: REGION });

// CSV structure: ticker,volume,open,close,high,low,window_start,transactions

// Function to convert CSV row to Timestream record
function convertRowToTimestreamRecord(row) {
    try {
        const [ticker, volume, open, close, high, low, timestamp, transactions] = row;
        
        // Skip if essential fields are missing
        if (!ticker || !timestamp) {
            return null;
        }
        
        // Convert timestamp from nanoseconds to seconds
        // The window_start in the CSV is in nanoseconds (1362718800000000000)
        // Timestream expects seconds or milliseconds
        let timeMs;
        if (timestamp.length > 13) {
            // Convert nanoseconds to seconds (not milliseconds)
            // We'll use seconds as the TimeUnit below
            timeMs = Math.floor(Number(timestamp) / 1000000000);
        } else if (timestamp.length > 10) {
            // Already in milliseconds, convert to seconds
            timeMs = Math.floor(Number(timestamp) / 1000);
        } else {
            // Already in seconds
            timeMs = Number(timestamp);
        }
        
        // Create measure records for each value
        const records = [];
        
        // Add volume record if present
        if (volume && volume !== "0") {
            records.push({
                Dimensions: [{ Name: 'ticker', Value: ticker }],
                MeasureName: 'volume',
                MeasureValue: volume,
                MeasureValueType: 'DOUBLE',
                Time: timeMs.toString(),
                TimeUnit: 'SECONDS'  // Changed from MILLISECONDS to SECONDS
            });
        }
        
        // Add open record if present
        if (open && open !== "0") {
            records.push({
                Dimensions: [{ Name: 'ticker', Value: ticker }],
                MeasureName: 'open',
                MeasureValue: open,
                MeasureValueType: 'DOUBLE',
                Time: timeMs.toString(),
                TimeUnit: 'SECONDS'  // Changed from MILLISECONDS to SECONDS
            });
        }
        
        // Add close record if present
        if (close && close !== "0") {
            records.push({
                Dimensions: [{ Name: 'ticker', Value: ticker }],
                MeasureName: 'close',
                MeasureValue: close,
                MeasureValueType: 'DOUBLE',
                Time: timeMs.toString(),
                TimeUnit: 'SECONDS'  // Changed from MILLISECONDS to SECONDS
            });
        }
        
        // Add high record if present
        if (high && high !== "0") {
            records.push({
                Dimensions: [{ Name: 'ticker', Value: ticker }],
                MeasureName: 'high',
                MeasureValue: high,
                MeasureValueType: 'DOUBLE',
                Time: timeMs.toString(),
                TimeUnit: 'SECONDS'  // Changed from MILLISECONDS to SECONDS
            });
        }
        
        // Add low record if present
        if (low && low !== "0") {
            records.push({
                Dimensions: [{ Name: 'ticker', Value: ticker }],
                MeasureName: 'low',
                MeasureValue: low,
                MeasureValueType: 'DOUBLE',
                Time: timeMs.toString(),
                TimeUnit: 'SECONDS'  // Changed from MILLISECONDS to SECONDS
            });
        }
        
        // Add transactions record if present
        if (transactions && transactions !== "0") {
            records.push({
                Dimensions: [{ Name: 'ticker', Value: ticker }],
                MeasureName: 'transactions',
                MeasureValue: transactions,
                MeasureValueType: 'DOUBLE',
                Time: timeMs.toString(),
                TimeUnit: 'SECONDS'  // Changed from MILLISECONDS to SECONDS
            });
        }
        
        return records;
    } catch (error) {
        console.error('Error converting row to record:', error, row);
        return null;
    }
}

// Function to write records to Timestream
async function writeToTimestream(records) {
    // Split records into chunks of BATCH_SIZE
    const batches = [];
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
        batches.push(records.slice(i, i + BATCH_SIZE));
    }
    
    let successCount = 0;
    let failureCount = 0;
    
    // Log sample data if enabled
    if (SHOW_SAMPLE_DATA && records.length > 0) {
        console.log('Sample record being sent to Timestream:');
        console.log(JSON.stringify(records[0], null, 2));
        SHOW_SAMPLE_DATA = false; // Only show once
    }
    
    for (let i = 0; i < batches.length; i++) {
        const chunk = batches[i];
        const params = {
            DatabaseName: TIMESTREAM_DB,
            TableName: TIMESTREAM_TABLE,
            Records: chunk
        };
        
        try {
            // Show progress every 10 batches
            if (i % 10 === 0) {
                console.log(`Writing batch ${i+1}/${batches.length} (${chunk.length} records)`);
            }
            
            const command = new WriteRecordsCommand(params);
            const response = await writeClient.send(command);
            
            // Check for rejected records
            if (response.RejectedRecords && response.RejectedRecords.length > 0) {
                console.error(`Batch ${i+1} had ${response.RejectedRecords.length} rejected records`);
                
                // Log detailed information about rejections
                for (let j = 0; j < Math.min(5, response.RejectedRecords.length); j++) {
                    const rejection = response.RejectedRecords[j];
                    console.error(`  Rejection ${j+1}:`);
                    console.error(`    Reason: ${rejection.Reason}`);
                    console.error(`    Record index: ${rejection.RecordIndex}`);
                    if (chunk[rejection.RecordIndex]) {
                        console.error(`    Problem record:`, JSON.stringify(chunk[rejection.RecordIndex], null, 2));
                    }
                }
                
                if (response.RejectedRecords.length > 5) {
                    console.error(`  ... and ${response.RejectedRecords.length - 5} more rejections.`);
                }
                
                failureCount += response.RejectedRecords.length;
                successCount += (chunk.length - response.RejectedRecords.length);
            } else {
                successCount += chunk.length;
            }
            
            // Show progress periodically
            if ((i+1) % 50 === 0 || i === batches.length - 1) {
                console.log(`Progress: ${successCount + failureCount} records processed (${successCount} succeeded, ${failureCount} failed)`);
            }
        } catch (error) {
            console.error(`Error writing batch ${i+1}:`, error.message);
            
            // More detailed error info
            if (error.$metadata) {
                console.error(`HTTP Status: ${error.$metadata.httpStatusCode}`);
                console.error(`Request ID: ${error.$metadata.requestId}`);
            }
            
            // Try to capture the first record of the batch for debugging
            if (chunk.length > 0) {
                console.error(`Example record in batch:`, JSON.stringify(chunk[0], null, 2));
            }
            
            failureCount += chunk.length;
        }
        
        // Add a small delay between batches to avoid throttling
        if (i < batches.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }
    
    return { successCount, failureCount };
}

// Main function to process the CSV file
async function processCSV() {
    try {
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
            const rowRecords = convertRowToTimestreamRecord(row);
            if (rowRecords && rowRecords.length > 0) {
                records.push(...rowRecords);
            }
            
            // Process in batches
            if (records.length >= MAX_RECORDS_PER_RUN) {
                console.log(`Processed ${lineCount} lines, writing batch of ${records.length} records to Timestream...`);
                const result = await writeToTimestream(records);
                totalSuccess += result.successCount;
                totalFailure += result.failureCount;
                recordsProcessed += records.length;
                records = [];
                
                console.log(`Total progress: ${recordsProcessed} records processed (${totalSuccess} succeeded, ${totalFailure} failed)`);
            }
            
            // Log progress periodically
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

// Run just 100 records as a test
async function testSmallBatch() {
    try {
        console.log('RUNNING TEST WITH SMALL BATCH OF RECORDS');
        console.log(`Processing CSV file: ${CSV_FILE_PATH}`);
        
        // Create readline interface
        const fileStream = fs.createReadStream(CSV_FILE_PATH);
        const rl = readline.createInterface({
            input: fileStream,
            crlfDelay: Infinity
        });
        
        let lineCount = 0;
        let records = [];
        let header = null;
        const TEST_RECORD_COUNT = 100;
        
        console.log(`Reading first ${TEST_RECORD_COUNT} records from CSV file...`);
        
        // Process just a few lines
        for await (const line of rl) {
            lineCount++;
            
            // Skip header line
            if (lineCount === 1) {
                header = line;
                console.log(`CSV Headers: ${header}`);
                continue;
            }
            
            // Parse CSV line
            const row = line.split(',');
            
            // Convert row to Timestream records
            const rowRecords = convertRowToTimestreamRecord(row);
            if (rowRecords && rowRecords.length > 0) {
                records.push(...rowRecords);
            }
            
            // Stop after processing TEST_RECORD_COUNT records
            if (records.length >= TEST_RECORD_COUNT) {
                console.log(`Processed ${lineCount} lines for test`);
                break;
            }
        }
        
        // Close the reader
        rl.close();
        fileStream.destroy();
        
        if (records.length > 0) {
            console.log(`Writing test batch of ${records.length} records to Timestream...`);
            // Show detailed info for the first record
            console.log('First record to be written:');
            console.log(JSON.stringify(records[0], null, 2));
            
            const result = await writeToTimestream(records);
            console.log(`Test results: ${result.successCount} succeeded, ${result.failureCount} failed`);
            
            if (result.failureCount > 0) {
                console.log('Test failed with errors. Please check the logs above.');
            } else {
                console.log('Test successful! You can now run the full import.');
            }
        }
        
    } catch (error) {
        console.error('Error in test batch:', error);
    }
}

// Check if we should run test mode or full import
const args = process.argv.slice(2);
if (args.includes('--test')) {
    testSmallBatch().catch(console.error);
} else if (args.includes('--full')) {
    processCSV().catch(console.error);
} else {
    console.log('Please specify --test or --full as an argument:');
    console.log('  node import-csv-to-timestream.js --test    # Run with 100 records only');
    console.log('  node import-csv-to-timestream.js --full    # Run full import');
}