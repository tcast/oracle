/**
 * AWS Lambda function to read historical stock data from S3 and load into Amazon Timestream
 * 
 * This function reads CSV files from an S3 bucket, processes them, and loads the data
 * into Amazon Timestream for time series analysis.
 */

const { TimestreamWriteClient, WriteRecordsCommand } = require("@aws-sdk/client-timestream-write");
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
const csv = require('csv-parser');
const { Readable } = require('stream');

// AWS SDK configuration
const region = process.env.AWS_REGION || 'us-east-1';
const timestreamClient = new TimestreamWriteClient({ region });
const s3Client = new S3Client({ region });

// Timestream configuration
const DATABASE_NAME = process.env.TIMESTREAM_DATABASE || 'oracle';
const TABLE_NAME = process.env.TIMESTREAM_TABLE || 'stock_prices';

// S3 configuration
const BUCKET_NAME = process.env.S3_BUCKET_NAME || 'polygon-market-data-803044560';
const PREFIX = process.env.S3_PREFIX || 'stocks/';

/**
 * Lists stock files available in the S3 bucket
 * @returns {Promise<Array<string>>} List of S3 keys for stock files
 */
async function listStockFiles() {
    try {
        const command = new ListObjectsV2Command({
            Bucket: BUCKET_NAME,
            Prefix: PREFIX
        });
        
        const response = await s3Client.send(command);
        const files = response.Contents?.map(item => item.Key) || [];
        
        console.log(`Found ${files.length} files in S3 bucket ${BUCKET_NAME}/${PREFIX}`);
        return files;
    } catch (error) {
        console.error('Error listing files from S3:', error);
        throw error;
    }
}

/**
 * Processes a CSV file from S3 and converts rows to Timestream records
 * @param {string} s3Key - S3 key for the file to process
 * @returns {Promise<Array>} Array of Timestream records
 */
async function processS3File(s3Key) {
    try {
        console.log(`Processing file: s3://${BUCKET_NAME}/${s3Key}`);
        
        // Extract symbol from filename (assuming format like "stocks/AAPL.csv")
        const symbol = s3Key.split('/').pop().split('.')[0];
        
        const command = new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: s3Key
        });
        
        const response = await s3Client.send(command);
        const stream = response.Body;
        
        if (!stream) {
            throw new Error(`Could not get stream for ${s3Key}`);
        }
        
        // Convert the stream to a format that csv-parser can read
        const readableStream = Readable.from(stream);
        
        // Process the CSV file
        const records = [];
        let count = 0;
        
        return new Promise((resolve, reject) => {
            readableStream
                .pipe(csv())
                .on('data', (row) => {
                    // Convert each row to Timestream records
                    const timestamp = new Date(row.date).getTime();
                    
                    // Common dimensions for all records from this row
                    const commonDimensions = [
                        { Name: 'symbol', Value: symbol },
                        { Name: 'asset_type', Value: 'stock' }
                    ];
                    
                    // Create a record for each measure (open, high, low, close, volume)
                    if (row.open) {
                        records.push({
                            Dimensions: commonDimensions,
                            MeasureName: 'price',
                            MeasureValue: row.open,
                            MeasureValueType: 'DOUBLE',
                            Time: timestamp.toString(),
                            TimeUnit: 'MILLISECONDS',
                            MeasureAttributes: [
                                { Name: 'type', Value: 'open', Type: 'VARCHAR' }
                            ]
                        });
                    }
                    
                    if (row.high) {
                        records.push({
                            Dimensions: commonDimensions,
                            MeasureName: 'price',
                            MeasureValue: row.high,
                            MeasureValueType: 'DOUBLE',
                            Time: timestamp.toString(),
                            TimeUnit: 'MILLISECONDS',
                            MeasureAttributes: [
                                { Name: 'type', Value: 'high', Type: 'VARCHAR' }
                            ]
                        });
                    }
                    
                    if (row.low) {
                        records.push({
                            Dimensions: commonDimensions,
                            MeasureName: 'price',
                            MeasureValue: row.low,
                            MeasureValueType: 'DOUBLE',
                            Time: timestamp.toString(),
                            TimeUnit: 'MILLISECONDS',
                            MeasureAttributes: [
                                { Name: 'type', Value: 'low', Type: 'VARCHAR' }
                            ]
                        });
                    }
                    
                    if (row.close) {
                        records.push({
                            Dimensions: commonDimensions,
                            MeasureName: 'price',
                            MeasureValue: row.close,
                            MeasureValueType: 'DOUBLE',
                            Time: timestamp.toString(),
                            TimeUnit: 'MILLISECONDS',
                            MeasureAttributes: [
                                { Name: 'type', Value: 'close', Type: 'VARCHAR' }
                            ]
                        });
                    }
                    
                    if (row.volume) {
                        records.push({
                            Dimensions: commonDimensions,
                            MeasureName: 'volume',
                            MeasureValue: row.volume,
                            MeasureValueType: 'BIGINT',
                            Time: timestamp.toString(),
                            TimeUnit: 'MILLISECONDS'
                        });
                    }
                    
                    count++;
                })
                .on('end', () => {
                    console.log(`Finished reading file ${s3Key}, processed ${count} rows`);
                    resolve(records);
                })
                .on('error', (error) => {
                    console.error(`Error processing CSV file ${s3Key}:`, error);
                    reject(error);
                });
        });
    } catch (error) {
        console.error(`Error processing S3 file ${s3Key}:`, error);
        throw error;
    }
}

/**
 * Writes records to Timestream in batches
 * @param {Array} records - Array of Timestream records
 * @returns {Promise<Object>} Result of the write operation
 */
async function writeToTimestream(records) {
    if (!records || records.length === 0) {
        console.log('No records to write to Timestream');
        return { recordsWritten: 0 };
    }
    
    let recordsWritten = 0;
    const batchSize = 100; // Timestream has a limit of 100 records per request
    
    try {
        // Process records in batches
        for (let i = 0; i < records.length; i += batchSize) {
            const batch = records.slice(i, i + batchSize);
            console.log(`Writing ${batch.length} records to Timestream`);
            
            const params = {
                DatabaseName: DATABASE_NAME,
                TableName: TABLE_NAME,
                Records: batch
            };
            
            const command = new WriteRecordsCommand(params);
            await timestreamClient.send(command);
            recordsWritten += batch.length;
            console.log(`Successfully wrote ${batch.length} records to Timestream`);
        }
        
        return { recordsWritten };
    } catch (error) {
        console.error('Error writing to Timestream:', error);
        throw error;
    }
}

/**
 * Processes a single S3 file and writes its data to Timestream
 * @param {string} s3Key - S3 key for the file to process
 * @returns {Promise<Object>} Result of the operation
 */
async function processFileAndWriteToTimestream(s3Key) {
    try {
        const records = await processS3File(s3Key);
        const result = await writeToTimestream(records);
        
        return {
            s3Key,
            recordsProcessed: records.length,
            recordsWritten: result.recordsWritten,
            success: true
        };
    } catch (error) {
        console.error(`Error processing file ${s3Key}:`, error);
        return {
            s3Key,
            error: error.message,
            success: false
        };
    }
}

/**
 * Main function to process stock data from S3
 * @param {Object} event - Lambda event object
 * @returns {Promise<Object>} Result of the operation
 */
async function processStockData(event) {
    try {
        // If a specific symbol is provided, process only that file
        if (event && event.symbol) {
            const symbol = event.symbol.toUpperCase();
            const s3Key = `${PREFIX}${symbol}.csv`;
            
            console.log(`Processing single symbol: ${symbol}`);
            return await processFileAndWriteToTimestream(s3Key);
        }
        
        // Otherwise, process all files
        const files = await listStockFiles();
        console.log(`Processing ${files.length} files`);
        
        const results = [];
        for (const file of files) {
            const result = await processFileAndWriteToTimestream(file);
            results.push(result);
        }
        
        const successCount = results.filter(r => r.success).length;
        const errorCount = results.filter(r => !r.success).length;
        const totalRecordsProcessed = results.reduce((sum, r) => sum + (r.recordsProcessed || 0), 0);
        const totalRecordsWritten = results.reduce((sum, r) => sum + (r.recordsWritten || 0), 0);
        
        return {
            filesProcessed: files.length,
            successCount,
            errorCount,
            totalRecordsProcessed,
            totalRecordsWritten,
            results
        };
    } catch (error) {
        console.error('Error processing stock data:', error);
        throw error;
    }
}

/**
 * Lambda handler function
 * @param {Object} event - Lambda event object
 * @returns {Promise<Object>} HTTP response
 */
exports.handler = async (event) => {
    console.log('Event:', JSON.stringify(event));
    
    try {
        const result = await processStockData(event);
        
        return {
            statusCode: 200,
            body: result
        };
    } catch (error) {
        console.error('Error in Lambda handler:', error);
        
        return {
            statusCode: 500,
            body: {
                error: error.message
            }
        };
    }
};

// For local testing
if (require.main === module) {
    const testEvent = process.argv[2] ? { symbol: process.argv[2] } : {};
    exports.handler(testEvent)
        .then(result => console.log('Execution result:', JSON.stringify(result, null, 2)))
        .catch(error => console.error('Execution error:', error));
} 