
      const fs = require('fs');
      const { TimestreamWriteClient, WriteRecordsCommand } = require('@aws-sdk/client-timestream-write');
      
      // Configuration from parent
      const REGION = 'us-east-1';
      const TIMESTREAM_DB = 'oracle';
      const TIMESTREAM_TABLE = 'stock_prices';
      const CSV_FILE_PATH = '/Users/tcast/Downloads/polygon/combined_stock_data.csv';
      const BATCH_SIZE = 100;
      const MAX_CONCURRENT_BATCHES = 50;
      const RECORDS_PER_PROCESS_BATCH = 500000;
      const START_LINE = 1;
      const END_LINE = 11328055;
      const PROCESS_INDEX = 1;
      const PROGRESS_LOG_PATH = '/Users/tcast/Documents/Sites/oracle/logs/process_1_progress.json';
      const RESULT_LOG_PATH = '/Users/tcast/Documents/Sites/oracle/logs/process_1_result.json';
      
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
          console.log(`Worker ${PROCESS_INDEX} completed successfully`);
          process.exit(0);
        })
        .catch(error => {
          console.error(`Worker ${PROCESS_INDEX} failed:`, error);
          process.exit(1);
        });
    