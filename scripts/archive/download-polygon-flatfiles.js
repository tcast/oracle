/**
 * Script to download Polygon.io flat files using direct HTTPS requests
 * This avoids S3 SDK issues by using the Polygon.io API directly
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

// Configuration
const POLYGON_API_KEY = 'S61uA7CzojtsFXNqJAK6t4OW2EA0d5A0';
const BASE_URL = 'https://files.polygon.io';
const PREFIX = 'us_stocks_sip/day_aggs_v1';

// Create download directory
const downloadDir = path.join(os.homedir(), 'Downloads', 'polygon');
if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
    console.log(`Created download directory: ${downloadDir}`);
}

/**
 * Generate date range in YYYY-MM-DD format
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
 * Make an HTTP request and return response data
 */
function makeRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, options, (res) => {
            const { statusCode } = res;
            
            if (statusCode !== 200) {
                const error = new Error(`Request failed with status code ${statusCode}`);
                error.statusCode = statusCode;
                res.resume(); // Consume response to free up memory
                reject(error);
                return;
            }
            
            const chunks = [];
            
            res.on('data', (chunk) => {
                chunks.push(chunk);
            });
            
            res.on('end', () => {
                const responseBody = Buffer.concat(chunks);
                resolve({ statusCode, body: responseBody, headers: res.headers });
            });
        });
        
        req.on('error', (err) => {
            reject(err);
        });
        
        req.end();
    });
}

/**
 * Fetch directory listing
 */
async function listDirectory(directoryPath) {
    // For Polygon, we can use a HEAD request to check if a file exists
    const apiUrl = `${BASE_URL}/${directoryPath}`;
    
    try {
        console.log(`Checking directory: ${apiUrl}`);
        const response = await makeRequest(apiUrl, {
            method: 'HEAD',
            headers: {
                'Authorization': `Bearer ${POLYGON_API_KEY}`,
                'Accept': 'application/json'
            }
        });
        
        console.log(`Directory exists: ${response.statusCode === 200}`);
        return true;
    } catch (error) {
        console.error(`Error checking directory ${directoryPath}:`, error.message);
        return false;
    }
}

/**
 * Check if a specific file exists
 */
async function fileExists(filePath) {
    const apiUrl = `${BASE_URL}/${filePath}`;
    
    try {
        console.log(`Checking file: ${apiUrl}`);
        const response = await makeRequest(apiUrl, {
            method: 'HEAD',
            headers: {
                'Authorization': `Bearer ${POLYGON_API_KEY}`,
                'Accept': 'application/octet-stream'
            }
        });
        
        return response.statusCode === 200;
    } catch (error) {
        console.log(`File ${filePath} does not exist:`, error.message);
        return false;
    }
}

/**
 * Download a specific file
 */
async function downloadFile(filePath, localPath) {
    const apiUrl = `${BASE_URL}/${filePath}`;
    
    try {
        console.log(`Downloading file: ${apiUrl}`);
        console.log(`Saving to: ${localPath}`);
        
        const response = await makeRequest(apiUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${POLYGON_API_KEY}`,
                'Accept': 'application/octet-stream'
            }
        });
        
        // Ensure the directory exists
        const dirPath = path.dirname(localPath);
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
        
        // Write file to disk
        fs.writeFileSync(localPath, response.body);
        console.log(`✓ Successfully downloaded ${filePath}`);
        return true;
    } catch (error) {
        console.error(`Error downloading ${filePath}:`, error.message);
        return false;
    }
}

/**
 * Process and download files for a specific date
 */
async function processDate(date) {
    const { year, month, day, dateString } = date;
    
    // Construct the file path
    const filePath = `${PREFIX}/${year}/${month}/${dateString}.csv.gz`;
    console.log(`Checking for file: ${filePath}`);
    
    // Check if the file exists
    const exists = await fileExists(filePath);
    
    if (exists) {
        console.log(`File exists for ${dateString}`);
        
        // Define local save path
        const localPath = path.join(downloadDir, filePath);
        
        // Download the file
        return await downloadFile(filePath, localPath);
    } else {
        console.log(`No file found for ${dateString} (likely a non-trading day)`);
        return false;
    }
}

/**
 * Try to download files for known years
 */
async function checkYears() {
    console.log('Checking available years...');
    const years = ['2023', '2024', '2025'];
    
    for (const year of years) {
        const yearPath = `${PREFIX}/${year}`;
        const yearExists = await listDirectory(yearPath);
        
        if (yearExists) {
            console.log(`✓ Year ${year} is available`);
            
            // Try a month (e.g., January)
            const monthPath = `${yearPath}/01`;
            const monthExists = await listDirectory(monthPath);
            
            if (monthExists) {
                console.log(`✓ Month ${year}/01 is available`);
                
                // Try a specific day for this month/year
                const dayFile = `${monthPath}/${year}-01-05.csv.gz`;
                const dayExists = await fileExists(dayFile);
                
                if (dayExists) {
                    console.log(`✓ Found ${dayFile}`);
                    
                    // Try downloading this file as a test
                    const localPath = path.join(downloadDir, dayFile);
                    const success = await downloadFile(dayFile, localPath);
                    
                    if (success) {
                        console.log(`✓ Successfully downloaded test file for ${year}-01-05`);
                        return true;
                    }
                }
            }
        } else {
            console.log(`✗ Year ${year} is not available or accessible`);
        }
    }
    
    return false;
}

/**
 * Download files for a date range
 */
async function downloadFilesForDateRange(startDate, endDate) {
    const dateRange = generateDateRange(startDate, endDate);
    console.log(`Processing ${dateRange.length} days from ${startDate} to ${endDate}`);
    
    let successfulDays = 0;
    
    for (const date of dateRange) {
        process.stdout.write(`\nProcessing ${date.dateString}... `);
        const success = await processDate(date);
        
        if (success) {
            successfulDays++;
            process.stdout.write('✓ done\n');
        } else {
            process.stdout.write('✗ failed or not available\n');
        }
        
        // Add a small delay to avoid hitting rate limits
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    return {
        daysProcessed: dateRange.length,
        successfulDays
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
        
        // First check if we can access the files
        console.log('Verifying access to Polygon.io flat files...');
        const accessVerified = await checkYears();
        
        if (!accessVerified) {
            console.error('Failed to verify access to Polygon.io flat files.');
            console.error('Please check your API key and permissions.');
            return;
        }
        
        console.log('\nStarting download process...');
        const result = await downloadFilesForDateRange(startDate, endDate);
        
        console.log('\n=== Download Summary ===');
        console.log(`Days processed: ${result.daysProcessed}`);
        console.log(`Successfully downloaded: ${result.successfulDays}`);
        console.log(`Download path: ${downloadDir}`);
        console.log('=======================\n');
        
    } catch (error) {
        console.error('Error in main function:', error);
    }
}

// Run the script
main();