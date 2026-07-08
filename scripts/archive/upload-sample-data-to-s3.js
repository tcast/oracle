/**
 * Script to upload sample stock data to S3
 * 
 * This script takes the locally generated CSV files and uploads them to an S3 bucket
 * for use with the Lambda function.
 */

const { S3Client, PutObjectCommand, HeadBucketCommand, CreateBucketCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

// Configuration
const region = process.env.AWS_REGION || 'us-east-1';
const s3Client = new S3Client({ region });
const BUCKET_NAME = process.env.S3_BUCKET_NAME || 'imgcorefiles';
const DATA_DIR = path.join(__dirname, 'data', 'stocks');
const S3_PREFIX = 'stocks/';

/**
 * Checks if the S3 bucket exists and is accessible
 * @returns {Promise<boolean>} True if the bucket exists and is accessible
 */
async function checkBucketExists() {
    try {
        const command = new HeadBucketCommand({
            Bucket: BUCKET_NAME
        });
        
        await s3Client.send(command);
        console.log(`Bucket ${BUCKET_NAME} exists and is accessible`);
        return true;
    } catch (error) {
        if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
            console.log(`Bucket ${BUCKET_NAME} does not exist`);
            return false;
        }
        
        console.error(`Error checking bucket ${BUCKET_NAME}:`, error);
        throw error;
    }
}

/**
 * Lists all CSV files in the data directory
 * @returns {Promise<Array<string>>} List of file paths
 */
async function listCsvFiles() {
    try {
        const files = await fs.promises.readdir(DATA_DIR);
        const csvFiles = files.filter(file => file.endsWith('.csv'));
        
        console.log(`Found ${csvFiles.length} CSV files in ${DATA_DIR}`);
        return csvFiles.map(file => path.join(DATA_DIR, file));
    } catch (error) {
        console.error(`Error listing CSV files in ${DATA_DIR}:`, error);
        throw error;
    }
}

/**
 * Uploads a file to S3
 * @param {string} filePath - Path to the file to upload
 * @returns {Promise<Object>} Result of the upload operation
 */
async function uploadFileToS3(filePath) {
    try {
        const fileName = path.basename(filePath);
        const s3Key = `${S3_PREFIX}${fileName}`;
        
        console.log(`Uploading ${filePath} to s3://${BUCKET_NAME}/${s3Key}`);
        
        const fileContent = await fs.promises.readFile(filePath);
        
        const command = new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: s3Key,
            Body: fileContent,
            ContentType: 'text/csv'
        });
        
        const result = await s3Client.send(command);
        
        console.log(`Successfully uploaded ${fileName} to S3`);
        return {
            filePath,
            s3Key,
            success: true,
            result
        };
    } catch (error) {
        console.error(`Error uploading ${filePath} to S3:`, error);
        return {
            filePath,
            error: error.message,
            success: false
        };
    }
}

/**
 * Main function to upload all CSV files to S3
 */
async function uploadAllFilesToS3() {
    try {
        // Check if the bucket exists
        const bucketExists = await checkBucketExists();
        
        if (!bucketExists) {
            throw new Error(`Bucket ${BUCKET_NAME} does not exist or is not accessible`);
        }
        
        // List all CSV files
        const files = await listCsvFiles();
        
        // Upload each file to S3
        const results = [];
        for (const file of files) {
            const result = await uploadFileToS3(file);
            results.push(result);
        }
        
        // Summarize results
        const successCount = results.filter(r => r.success).length;
        const errorCount = results.filter(r => !r.success).length;
        
        console.log('\nUpload Summary:');
        console.log(`Total files: ${files.length}`);
        console.log(`Successfully uploaded: ${successCount}`);
        console.log(`Failed to upload: ${errorCount}`);
        
        if (errorCount > 0) {
            console.log('\nFailed uploads:');
            results
                .filter(r => !r.success)
                .forEach(r => console.log(`- ${path.basename(r.filePath)}: ${r.error}`));
        }
        
        return {
            totalFiles: files.length,
            successCount,
            errorCount,
            results
        };
    } catch (error) {
        console.error('Error uploading files to S3:', error);
        throw error;
    }
}

// Run the script if executed directly
if (require.main === module) {
    uploadAllFilesToS3()
        .then(result => console.log('Upload completed'))
        .catch(error => {
            console.error('Upload failed:', error);
            process.exit(1);
        });
} 