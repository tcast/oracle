/**
 * Script to download Polygon.io flat files to local storage
 * This downloads daily aggregates for a specified date range
 */

const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Configuration 
const POLYGON_ACCESS_KEY = 'S61uA7CzojtsFXNqJAK6t4OW2EA0d5A0';
const POLYGON_SECRET_KEY = 't7PzLSXlxX8pA0sD_lwdQFrI5CGl8nnK';
const POLYGON_BUCKET = 'flatfiles';
const POLYGON_PREFIX = 'us_stocks_sip/day_aggs_v1';

// Initialize client with debug logging
const s3Client = new S3Client({
    endpoint: 'https://files.polygon.io',
    region: 'us-east-1',
    credentials: {
        accessKeyId: POLYGON_ACCESS_KEY,
        secretAccessKey: POLYGON_SECRET_KEY
    },
    forcePathStyle: true,
    logger: console
});

// Create download directory
const downloadDir = path.join(os.homedir(), 'Downloads', 'polygon');
if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
    console.log(`Created download directory: ${downloadDir}`);
}

/**
 * Explore the directory structure to help debug
 */
async function exploreDirectoryStructure() {
    try {
        console.log('Exploring Polygon.io directory structure...');
        
        // Try listing the root
        try {
            const rootCommand = new ListObjectsV2Command({
                Bucket: POLYGON_BUCKET,
                Delimiter: '/',
                MaxKeys: 10
            });
            
            const rootResponse = await s3Client.send(rootCommand);
            console.log('Root directory structure:', JSON.stringify(rootResponse, null, 2));
        } catch (error) {
            console.error('Error listing root directory:', error.message);
        }
        
        // Try listing the prefix
        try {
            const prefixCommand = new ListObjectsV2Command({
                Bucket: POLYGON_BUCKET,
                Delimiter: '/',
                Prefix: POLYGON_PREFIX,
                MaxKeys: 10
            });
            
            const prefixResponse = await s3Client.send(prefixCommand);
            console.log('Prefix directory structure:', JSON.stringify(prefixResponse, null, 2));
        } catch (error) {
            console.error('Error listing prefix directory:', error.message);
        }
        
        // Try listing 2024
        try {
            const yearCommand = new ListObjectsV2Command({
                Bucket: POLYGON_BUCKET,
                Delimiter: '/',
                Prefix: POLYGON_PREFIX + '/2024/',
                MaxKeys: 10
            });
            
            const yearResponse = await s3Client.send(yearCommand);
            console.log('2024 directory structure:', JSON.stringify(yearResponse, null, 2));
        } catch (error) {
            console.error('Error listing 2024 directory:', error.message);
        }
        
        // Try a known file from older data to verify access
        try {
            const knownPrefix = 'us_stocks_sip/day_aggs_v1/2023/12/';
            const knownCommand = new ListObjectsV2Command({
                Bucket: POLYGON_BUCKET,
                Prefix: knownPrefix,
                MaxKeys: 5
            });
            
            const knownResponse = await s3Client.send(knownCommand);
            console.log('Known directory (2023/12) listing:', JSON.stringify(knownResponse, null, 2));
            
            if (knownResponse.Contents && knownResponse.Contents.length > 0) {
                console.log('Verification successful: found files in 2023/12');
            } else {
                console.log('Verification failed: no files found in 2023/12');
            }
        } catch (error) {
            console.error('Error verifying access with known files:', error.message);
        }
    } catch (error) {
        console.error('Error exploring directory structure:', error);
    }
}

/**
 * Generate a list of dates in YYYY-MM-DD format
 */
function generateDateRange(startDate, endDate) {
    const dates = [];
    const current = new Date(startDate);
    const end = new Date(endDate);
    
    while (current <= end) {
        const year = current.getFullYear().toString();
        const month = (current.getMonth() + 1).toString().padStart(2, '0');
        const day = current.getDate().toString().padStart(2, '0');
        
        dates.push({
            year,
            month,
            day,
            dateString: `${year}-${month}-${day}`
        });
        
        current.setDate(current.getDate() + 1);
    }
    
    return dates;
}

/**
 * List files for a specific date
 */
async function listFilesForDate(year, month, day) {
    const dateString = `${year}-${month}-${day}`;
    const prefix = `${POLYGON_PREFIX}/${year}/${month}/${dateString}.csv.gz`;
    
    console.log(`Looking for files with prefix: ${prefix}`);
    
    try {
        const command = new ListObjectsV2Command({
            Bucket: POLYGON_BUCKET,
            Prefix: prefix,
            MaxKeys: 1000
        });
        
        const response = await s3Client.send(command);
        
        if (response.Contents && response.Contents.length > 0) {
            console.log(`Found ${response.Contents.length} files for ${dateString}`);
            return response.Contents.map(item => item.Key);
        }
        
        console.log(`No files found for ${dateString} (might be a non-trading day)`);
        return [];
    } catch (error) {
        console.error(`Error listing files for ${dateString}:`, error.message);
        return [];
    }
}

/**
 * Download a file
 */
async function downloadFile(key) {
    // Create the directory structure based on the key
    const filePath = path.join(downloadDir, key);
    const dirPath = path.dirname(filePath);
    
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
    
    try {
        console.log(`Downloading ${key} to ${filePath}`);
        
        const command = new GetObjectCommand({
            Bucket: POLYGON_BUCKET,
            Key: key
        });
        
        const response = await s3Client.send(command);
        
        // Stream the file to disk
        const writeStream = fs.createWriteStream(filePath);
        
        return new Promise((resolve, reject) => {
            response.Body.pipe(writeStream);
            
            writeStream.on('finish', () => {
                console.log(`✓ Successfully downloaded ${key}`);
                resolve(true);
            });
            
            writeStream.on('error', (err) => {
                console.error(`Error writing file ${key}:`, err);
                reject(err);
            });
            
            response.Body.on('error', (err) => {
                console.error(`Error reading stream for ${key}:`, err);
                reject(err);
            });
        });
    } catch (error) {
        console.error(`Error downloading ${key}:`, error.message);
        return false;
    }
}

/**
 * Download all files for a date range
 */
async function downloadFilesForDateRange(startDate, endDate) {
    const dateRange = generateDateRange(startDate, endDate);
    console.log(`Processing ${dateRange.length} days from ${startDate} to ${endDate}`);
    
    let totalFiles = 0;
    let successfulDownloads = 0;
    
    for (const date of dateRange) {
        process.stdout.write(`\nProcessing ${date.dateString}... `);
        const files = await listFilesForDate(date.year, date.month, date.day);
        totalFiles += files.length;
        
        if (files.length > 0) {
            process.stdout.write(`found ${files.length} files. Downloading...\n`);
            
            // Create a year/month subdirectory
            const yearMonthDir = path.join(downloadDir, date.year, date.month);
            if (!fs.existsSync(yearMonthDir)) {
                fs.mkdirSync(yearMonthDir, { recursive: true });
            }
            
            // Download each file
            for (const file of files) {
                const success = await downloadFile(file);
                if (success) successfulDownloads++;
                
                // Small delay to avoid hammering the API
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        } else {
            process.stdout.write('no files found (non-trading day or not yet available)\n');
        }
    }
    
    return {
        daysProcessed: dateRange.length,
        totalFiles,
        successfulDownloads
    };
}

/**
 * Main function
 */
async function main() {
    try {
        // Get command line arguments
        const args = process.argv.slice(2);
        let startDate = '2024-01-01';
        let endDate = '2025-03-13';
        
        if (args.length >= 1) startDate = args[0];
        if (args.length >= 2) endDate = args[1];
        
        console.log('\n=== Polygon.io Flat File Downloader ===');
        console.log(`Download directory: ${downloadDir}`);
        console.log(`Date range: ${startDate} to ${endDate}`);
        console.log('======================================\n');
        
        // First explore the directory structure to verify access
        console.log('Verifying access to Polygon.io...');
        await exploreDirectoryStructure();
        
        console.log('\nStarting download process...');
        const result = await downloadFilesForDateRange(startDate, endDate);
        
        console.log('\n=== Download Summary ===');
        console.log(`Days processed: ${result.daysProcessed}`);
        console.log(`Total files found: ${result.totalFiles}`);
        console.log(`Successfully downloaded: ${result.successfulDownloads}`);
        console.log(`Download path: ${downloadDir}`);
        console.log('=======================\n');
        
    } catch (error) {
        console.error('Error in main function:', error);
    }
}

// Run the script
main();