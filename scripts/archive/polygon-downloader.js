/**
 * Simple script to download Polygon.io flat files directly via HTTP
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { format } = require('util');

// Configuration
const POLYGON_API_KEY = 'S61uA7CzojtsFXNqJAK6t4OW2EA0d5A0';
const BASE_PATH = 'https://files.polygon.io/us_stocks_sip/day_aggs_v1';
const DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads', 'polygon');
const DEBUG = true; // Enable debug logging

// Ensure download directory exists
if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    console.log(`Created directory: ${DOWNLOAD_DIR}`);
}

// Logging
function log(message, ...args) {
    const formattedMessage = args.length ? format(message, ...args) : message;
    console.error(`[${new Date().toISOString()}] ${formattedMessage}`);
}

// Debug logging
function debug(message, ...args) {
    if (!DEBUG) return;
    const formattedMessage = args.length ? format(message, ...args) : message;
    console.error(`[DEBUG ${new Date().toISOString()}] ${formattedMessage}`);
}

/**
 * Make a simple HTTP request
 */
function httpRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        log(`HTTP ${options.method || 'GET'} ${url}`);
        debug('Request options: %j', options);
        
        const req = https.request(url, options, (res) => {
            const { statusCode, headers } = res;
            log(`Response: ${statusCode} ${res.statusMessage}`);
            debug('Response headers: %j', headers);
            
            // Check if we need to follow redirects
            if ((statusCode === 301 || statusCode === 302) && headers.location) {
                log(`Following redirect to: ${headers.location}`);
                httpRequest(headers.location, options)
                    .then(resolve)
                    .catch(reject);
                return;
            }
            
            const chunks = [];
            let totalBytes = 0;
            
            res.on('data', (chunk) => {
                chunks.push(chunk);
                totalBytes += chunk.length;
                
                // Log progress for large files
                if (totalBytes > 1024 * 1024) {
                    process.stdout.write(`\rDownloaded: ${(totalBytes / (1024 * 1024)).toFixed(2)} MB`);
                }
            });
            
            res.on('end', () => {
                if (totalBytes > 1024 * 1024) {
                    process.stdout.write('\n');
                }
                
                // Combine response chunks
                const body = Buffer.concat(chunks);
                
                // If error status code, try to parse response for error details
                if (statusCode >= 400) {
                    try {
                        const errorBody = body.toString('utf-8');
                        debug(`Error response body: ${errorBody}`);
                    } catch (e) {
                        debug('Could not parse error response body');
                    }
                }
                
                resolve({ statusCode, headers, body });
            });
        });
        
        req.on('error', (error) => {
            log(`Request error: ${error.message}`);
            debug('Request error stack: %s', error.stack);
            reject(error);
        });
        
        // Set a timeout
        req.setTimeout(30000, () => {
            log('Request timed out');
            req.destroy();
            reject(new Error('Request timed out'));
        });
        
        req.end();
    });
}

/**
 * Try different URL formats to find the right one
 */
async function probeEndpoint() {
    const testUrls = [
        'https://files.polygon.io',
        'https://files.polygon.io/us_stocks_sip',
        'https://files.polygon.io/us_stocks_sip/day_aggs_v1',
        'https://files.polygon.io/us_stocks_sip/day_aggs_v1/2023',
        'https://files.polygon.io/us_stocks_sip/day_aggs_v1/2023/12',
        'https://files.polygon.io/us_stocks_sip/day_aggs_v1/2023/12/2023-12-29.csv.gz'
    ];
    
    log('Probing Polygon.io endpoints to determine correct URL structure...');
    
    for (const url of testUrls) {
        try {
            log(`Testing URL: ${url}`);
            
            const response = await httpRequest(url, {
                headers: {
                    'Authorization': `Bearer ${POLYGON_API_KEY}`,
                    'User-Agent': 'Mozilla/5.0 (Node.js) Polygon-Downloader/1.0'
                }
            });
            
            log(`URL ${url} - Status: ${response.statusCode}`);
            
            if (response.statusCode === 200) {
                if (url.endsWith('.csv.gz')) {
                    log('✓ Found valid file URL pattern!');
                    return true;
                } else {
                    debug('Response body preview: %s', response.body.toString('utf-8').substring(0, 200));
                }
            }
        } catch (error) {
            log(`Error testing ${url}: ${error.message}`);
        }
    }
    
    log('Could not find valid endpoint pattern');
    return false;
}

/**
 * Download a specific date's file
 */
async function downloadForDate(date) {
    try {
        // Parse date components
        const [year, month, day] = date.split('-');
        
        // Create URL for the file
        const url = `${BASE_PATH}/${year}/${month}/${date}.csv.gz`;
        log(`Attempting to download: ${url}`);
        
        // Create local path
        const localDir = path.join(DOWNLOAD_DIR, year, month);
        const localPath = path.join(localDir, `${date}.csv.gz`);
        
        // Ensure local directory exists
        if (!fs.existsSync(localDir)) {
            fs.mkdirSync(localDir, { recursive: true });
        }
        
        // Make request with API key
        const response = await httpRequest(url, {
            headers: {
                'Authorization': `Bearer ${POLYGON_API_KEY}`,
                'Accept': 'application/octet-stream',
                'User-Agent': 'Mozilla/5.0 (Node.js) Polygon-Downloader/1.0'
            }
        });
        
        // Check if successful
        if (response.statusCode === 200) {
            log(`File found for ${date}, size: ${response.body.length} bytes`);
            
            // Write file to disk
            fs.writeFileSync(localPath, response.body);
            log(`Successfully saved: ${localPath}`);
            return true;
        } else {
            log(`File not found for ${date} (status: ${response.statusCode})`);
            return false;
        }
    } catch (error) {
        log(`Error downloading for ${date}: ${error.message}`);
        return false;
    }
}

/**
 * Try a specific known date to test the connection
 */
async function testConnection() {
    log('Testing connection to Polygon.io...');
    
    // First try direct endpoint probing
    await probeEndpoint();
    
    // Try December 29, 2023 (known trading day)
    const testDate = '2023-12-29';
    log(`Testing with date: ${testDate}`);
    
    const success = await downloadForDate(testDate);
    
    if (success) {
        log('✓ Connection test successful! File downloaded.');
        return true;
    } else {
        log('✗ Connection test failed! Could not download test file.');
        
        // Alternative approach - try calling ticker API to verify credentials
        try {
            log('Testing API key with a Polygon REST API endpoint...');
            const apiUrl = `https://api.polygon.io/v2/aggs/ticker/AAPL/range/1/day/2023-12-29/2023-12-29?apiKey=${POLYGON_API_KEY}`;
            
            const response = await httpRequest(apiUrl);
            
            if (response.statusCode === 200) {
                const data = JSON.parse(response.body.toString('utf-8'));
                log(`API Key test successful. Found ${data.resultsCount} results for AAPL.`);
                log('API access works, but flat file access is failing.');
            } else {
                log(`API Key test failed with status ${response.statusCode}`);
            }
        } catch (error) {
            log(`API Key test error: ${error.message}`);
        }
        
        return false;
    }
}

/**
 * Process a date range
 */
async function processDateRange(startDate, endDate) {
    log(`Processing date range: ${startDate} to ${endDate}`);
    
    // Parse dates
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    // Generate list of dates
    const dates = [];
    const current = new Date(start);
    
    while (current <= end) {
        const year = current.getFullYear();
        const month = String(current.getMonth() + 1).padStart(2, '0');
        const day = String(current.getDate()).padStart(2, '0');
        dates.push(`${year}-${month}-${day}`);
        
        // Move to next day
        current.setDate(current.getDate() + 1);
    }
    
    log(`Generated ${dates.length} dates to process`);
    
    // Process each date
    let successCount = 0;
    
    for (let i = 0; i < dates.length; i++) {
        const date = dates[i];
        log(`[${i + 1}/${dates.length}] Processing date: ${date}`);
        
        const success = await downloadForDate(date);
        
        if (success) {
            successCount++;
        }
        
        // Add delay between requests
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    return {
        total: dates.length,
        success: successCount
    };
}

/**
 * Main function
 */
async function main() {
    try {
        log('===== Polygon.io Flat File Downloader =====');
        
        // Get command line arguments
        const args = process.argv.slice(2);
        let startDate = '2024-01-01';
        let endDate = '2024-01-31';  // Starting with just January for testing
        
        if (args.length >= 1) startDate = args[0];
        if (args.length >= 2) endDate = args[1];
        
        log(`Download directory: ${DOWNLOAD_DIR}`);
        log(`Date range: ${startDate} to ${endDate}`);
        log(`API Key (first 6 chars): ${POLYGON_API_KEY.substring(0, 6)}...`);
        
        // Test connection first
        const connectionOk = await testConnection();
        
        if (!connectionOk) {
            log('Aborting due to connection test failure');
            process.exit(1);
            return;
        }
        
        // Process date range
        const result = await processDateRange(startDate, endDate);
        
        log('===== Download Summary =====');
        log(`Total dates processed: ${result.total}`);
        log(`Successfully downloaded: ${result.success}`);
        log(`Failed: ${result.total - result.success}`);
        log(`Files saved to: ${DOWNLOAD_DIR}`);
        log('============================');
        process.exit(0);
        
    } catch (error) {
        log(`Fatal error: ${error.message}`);
        log(error.stack);
        process.exit(1);
    }
}

// Run the script
main();