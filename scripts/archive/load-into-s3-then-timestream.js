const fs = require('fs');
const readline = require('readline');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { TimestreamWriteClient, DeleteTableCommand, CreateTableCommand } = require('@aws-sdk/client-timestream-write');
const { exec } = require('child_process');
const crypto = require('crypto');
const zlib = require('zlib');
const { once } = require('events');
const { pipeline } = require('stream');
const { promisify } = require('util');

// Configuration
const CSV_FILE_PATH = '/Users/tcast/Downloads/polygon/combined_stock_data.csv';
const S3_BUCKET = 'YOUR_S3_BUCKET_NAME'; // Replace with your bucket name
const S3_PREFIX = 'stock_data/';
const CHUNK_SIZE = 100000; // Lines per file
const GZIP_COMPRESSION = true; // Use GZIP compression
const REGION = 'us-east-1';
const TIMESTREAM_DB = 'oracle';
const TIMESTREAM_TABLE = 'stock_prices';

// Initialize S3 client
const s3Client = new S3Client({ region: REGION });
const timestreamClient = new TimestreamWriteClient({ region: REGION });
const execPromise = promisify(exec);
const pipelinePromise = promisify(pipeline);

// Function to delete the existing timestream table
async function deleteTimestreamTable() {
  console.log(`Deleting existing Timestream table: ${TIMESTREAM_DB}.${TIMESTREAM_TABLE}`);
  
  try {
    const deleteParams = {
      DatabaseName: TIMESTREAM_DB,
      TableName: TIMESTREAM_TABLE
    };
    
    const command = new DeleteTableCommand(deleteParams);
    await timestreamClient.send(command);
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

// Function to create a new timestream table
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
    await timestreamClient.send(command);
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

// Main function
async function uploadCSVtoS3() {
  console.log(`Starting CSV to S3 upload and Timestream preparation process`);
  
  // First step: Delete and recreate the Timestream table
  console.log('=== STEP 1: Removing existing data ===');
  const tableDeleted = await deleteTimestreamTable();
  if (!tableDeleted) {
    console.error('Failed to delete the Timestream table. Aborting process.');
    return { success: false, error: 'Failed to delete table' };
  }
  
  console.log('=== STEP 2: Creating fresh table ===');
  const tableCreated = await createTimestreamTable();
  if (!tableCreated) {
    console.error('Failed to create the Timestream table. Aborting process.');
    return { success: false, error: 'Failed to create table' };
  }
  
  console.log('=== STEP 3: Uploading data to S3 ===');
  console.log(`Starting CSV to S3 upload process for ${CSV_FILE_PATH}`);
  console.log(`Target S3 bucket: ${S3_BUCKET}/${S3_PREFIX}`);
  
  const startTime = Date.now();
  const promises = [];
  
  try {
    // Create readline interface
    const fileStream = fs.createReadStream(CSV_FILE_PATH);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });
    
    let header = null;
    let lineCount = 0;
    let fileCount = 0;
    let buffer = [];
    
    console.log('Reading CSV file and uploading in chunks...');
    
    for await (const line of rl) {
      // Save header
      if (lineCount === 0) {
        header = line;
        lineCount++;
        continue;
      }
      
      // Add line to buffer
      buffer.push(line);
      lineCount++;
      
      // When buffer reaches chunk size, upload to S3
      if (buffer.length >= CHUNK_SIZE) {
        fileCount++;
        const content = [header, ...buffer].join('\n');
        
        const fileName = `chunk_${String(fileCount).padStart(5, '0')}.csv${GZIP_COMPRESSION ? '.gz' : ''}`;
        const s3Key = `${S3_PREFIX}${fileName}`;
        
        // Upload the chunk (don't await to allow parallel uploads)
        const uploadPromise = uploadToS3(content, s3Key, fileCount);
        promises.push(uploadPromise);
        
        // Reset buffer
        buffer = [];
        
        // Log progress every 10 files
        if (fileCount % 10 === 0) {
          const elapsedSeconds = (Date.now() - startTime) / 1000;
          const linesPerSecond = Math.round(lineCount / elapsedSeconds);
          console.log(`Processed ${lineCount.toLocaleString()} lines, created ${fileCount} files`);
          console.log(`Processing speed: ${linesPerSecond.toLocaleString()} lines/second`);
        }
      }
    }
    
    // Upload any remaining lines
    if (buffer.length > 0) {
      fileCount++;
      const content = [header, ...buffer].join('\n');
      
      const fileName = `chunk_${String(fileCount).padStart(5, '0')}.csv${GZIP_COMPRESSION ? '.gz' : ''}`;
      const s3Key = `${S3_PREFIX}${fileName}`;
      
      const uploadPromise = uploadToS3(content, s3Key, fileCount);
      promises.push(uploadPromise);
    }
    
    // Wait for all uploads to complete
    console.log('Waiting for all uploads to complete...');
    await Promise.all(promises);
    
    const elapsedSeconds = (Date.now() - startTime) / 1000;
    const linesPerSecond = Math.round(lineCount / elapsedSeconds);
    
    console.log('\nUpload complete!');
    console.log(`Total lines processed: ${lineCount.toLocaleString()}`);
    console.log(`Total files uploaded: ${fileCount}`);
    console.log(`Total time: ${Math.round(elapsedSeconds)} seconds`);
    console.log(`Average speed: ${linesPerSecond.toLocaleString()} lines per second`);
    
    // Generate and upload manifest file for AWS Data Migration or AWS Glue
    await createAndUploadManifest(fileCount);
    
    // Next steps: Create Timestream import commands
    console.log('\nNEXT STEPS:');
    console.log('1. Set up an AWS Glue job or AWS Data Migration job to load the data into Timestream');
    console.log('2. Use the uploaded manifest file to track all chunks for processing');
    console.log('3. Configure the job to map CSV columns to the correct Timestream format');
    console.log('4. Run the job to import all data into Timestream');
    
    console.log('\nFor AWS Glue, you can create a job with this script:');
    printGlueJobScript();
    
    return { success: true, files: fileCount, lines: lineCount };
  } catch (error) {
    console.error('Error uploading CSV to S3:', error);
    return { success: false, error: error.message };
  }
}

// Function to upload content to S3
async function uploadToS3(content, s3Key, fileNumber) {
  try {
    let body = content;
    
    // Apply GZIP compression if enabled
    if (GZIP_COMPRESSION) {
      body = await compressContent(content);
    }
    
    const params = {
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: body,
      ContentType: 'text/csv',
      ...(GZIP_COMPRESSION && { ContentEncoding: 'gzip' })
    };
    
    const command = new PutObjectCommand(params);
    await s3Client.send(command);
    
    return { success: true, key: s3Key, fileNumber };
  } catch (error) {
    console.error(`Error uploading file ${fileNumber} to S3:`, error);
    throw error;
  }
}

// Compress content with GZIP
async function compressContent(content) {
  return new Promise((resolve, reject) => {
    zlib.gzip(content, (err, compressed) => {
      if (err) {
        reject(err);
      } else {
        resolve(compressed);
      }
    });
  });
}

// Create and upload a manifest file
async function createAndUploadManifest(fileCount) {
  const manifest = {
    fileCount,
    files: Array.from({ length: fileCount }, (_, i) => {
      const fileName = `chunk_${String(i+1).padStart(5, '0')}.csv${GZIP_COMPRESSION ? '.gz' : ''}`;
      return {
        key: `${S3_PREFIX}${fileName}`,
        size: 0, // Size not needed for this manifest
      };
    }),
    createdAt: new Date().toISOString()
  };
  
  const manifestContent = JSON.stringify(manifest, null, 2);
  const manifestKey = `${S3_PREFIX}manifest.json`;
  
  try {
    const params = {
      Bucket: S3_BUCKET,
      Key: manifestKey,
      Body: manifestContent,
      ContentType: 'application/json'
    };
    
    const command = new PutObjectCommand(params);
    await s3Client.send(command);
    
    console.log(`Manifest file uploaded: s3://${S3_BUCKET}/${manifestKey}`);
    return { success: true };
  } catch (error) {
    console.error('Error uploading manifest file:', error);
    return { success: false, error: error.message };
  }
}

// Print an AWS Glue ETL job script for converting S3 to Timestream
function printGlueJobScript() {
  const glueScript = `
import sys
from awsglue.transforms import *
from awsglue.utils import getResolvedOptions
from pyspark.context import SparkContext
from awsglue.context import GlueContext
from awsglue.job import Job
from awsglue.dynamicframe import DynamicFrame
from pyspark.sql import SparkSession
from pyspark.sql.functions import *
from datetime import datetime

# Initialize Glue context
sc = SparkContext()
glueContext = GlueContext(sc)
spark = glueContext.spark_session
job = Job(glueContext)

# Parameters
S3_BUCKET = "${S3_BUCKET}"
S3_PREFIX = "${S3_PREFIX}"
TIMESTREAM_DB = "oracle"
TIMESTREAM_TABLE = "stock_prices"

# Read CSV files from S3
datasource = glueContext.create_dynamic_frame.from_options(
    connection_type="s3",
    connection_options={
        "paths": [f"s3://{S3_BUCKET}/{S3_PREFIX}"],
        "recurse": True,
        "groupFiles": "inPartition",
        "groupSize": "1073741824"  # 1GB
    },
    format="csv",
    format_options={
        "withHeader": True,
        "separator": ","
    }
)

# Convert to DataFrame and prepare for Timestream
df = datasource.toDF()

# Rename columns to match Timestream expectations
df = df.withColumnRenamed("ticker", "ticker") \\
       .withColumnRenamed("volume", "volume") \\
       .withColumnRenamed("open", "open") \\
       .withColumnRenamed("close", "close") \\
       .withColumnRenamed("high", "high") \\
       .withColumnRenamed("low", "low") \\
       .withColumnRenamed("window_start", "time") \\
       .withColumnRenamed("transactions", "transactions")

# Convert timestamp from nanoseconds to milliseconds
df = df.withColumn("time", (col("time").cast("double") / 1000000).cast("timestamp"))

# For each record, create multiple measure value records (one for each metric)
volume_df = df.select("ticker", "time", lit("volume").alias("measure_name"), col("volume").cast("double").alias("measure_value"))
open_df = df.select("ticker", "time", lit("open").alias("measure_name"), col("open").cast("double").alias("measure_value"))
close_df = df.select("ticker", "time", lit("close").alias("measure_name"), col("close").cast("double").alias("measure_value"))
high_df = df.select("ticker", "time", lit("high").alias("measure_name"), col("high").cast("double").alias("measure_value"))
low_df = df.select("ticker", "time", lit("low").alias("measure_name"), col("low").cast("double").alias("measure_value"))
trans_df = df.select("ticker", "time", lit("transactions").alias("measure_name"), col("transactions").cast("double").alias("measure_value"))

# Union all the measure records
timestream_df = volume_df.unionAll(open_df).unionAll(close_df).unionAll(high_df).unionAll(low_df).unionAll(trans_df)

# Filter out null or zero values
timestream_df = timestream_df.filter(col("measure_value").isNotNull() & (col("measure_value") != 0))

# Convert to Timestream compatible format
timestream_dynamic_frame = DynamicFrame.fromDF(timestream_df, glueContext, "timestream_dynamic_frame")

# Write to Timestream
glueContext.write_dynamic_frame.from_options(
    frame=timestream_dynamic_frame,
    connection_type="timestream",
    connection_options={
        "database": TIMESTREAM_DB,
        "table": TIMESTREAM_TABLE,
        "write_threads": 64,
        "batch_size": 100
    }
)

job.commit()
  `;
  
  console.log(glueScript);
}

// Run the upload process
uploadCSVtoS3()
  .then(result => {
    if (result.success) {
      console.log('CSV successfully uploaded to S3 and ready for Timestream import');
      process.exit(0);
    } else {
      console.error('Failed to upload CSV to S3:', result.error);
      process.exit(1);
    }
  })
  .catch(error => {
    console.error('Error:', error);
    process.exit(1);
  }); 