/**
 * Script to fetch historical stock data from Polygon API going back to 2003
 * and load it directly into Amazon Timestream
 */

const axios = require('axios');
const { TimestreamWriteClient, WriteRecordsCommand } = require('@aws-sdk/client-timestream-write');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Configure AWS SDK
const REGION = process.env.AWS_REGION || 'us-east-1';
const TIMESTREAM_DB = process.env.TIMESTREAM_DATABASE || 'oracle';
const TIMESTREAM_TABLE = process.env.TIMESTREAM_TABLE || 'stock_prices';
const timestreamClient = new TimestreamWriteClient({ region: REGION });

// Polygon API configuration
// TEMPORARY HARDCODED API KEY FOR TESTING
const POLYGON_API_KEY = "GamH9ewSNWT6BeUM19cdtlCzyNCfVHWx";
const POLYGON_BASE_URL = 'https://api.polygon.io';

// Rate limiting settings
const CALLS_PER_MINUTE = 5; // Conservative limit to avoid hitting Polygon's rate limits
const DELAY_BETWEEN_CALLS = (60 * 1000) / CALLS_PER_MINUTE; // ms between API calls

// Progress tracking
const PROGRESS_FILE = 'polygon_import_progress.json';

// Database configuration for retrieving symbols
let pool;

// Initialize PostgreSQL pool for getting stock symbols
const initializePool = () => {
  if (!pool) {
    pool = new Pool({
      user: process.env.DB_USER || 'postgres',
      host: process.env.DB_HOST || 'oracle-db.cyruxuioaadm.us-east-1.rds.amazonaws.com',
      database: process.env.DB_NAME || 'oracle',
      password: process.env.DB_PASSWORD || 'QnEv5TgRxC3LbH7Wd9Kp',
      port: process.env.DB_PORT || 5432,
      ssl: process.env.DB_REQUIRE_SSL === 'true' ? {
        rejectUnauthorized: false
      } : false
    });
    
    console.log('Database pool initialized');
  }
  return pool;
};

// Get active stock symbols from database
async function getStockSymbols() {
  const pool = await initializePool();
  const result = await pool.query(`
    SELECT symbol, type FROM stock_symbols 
    WHERE active = true 
    ORDER BY symbol
  `);
  
  return result.rows;
}

// Load progress from file if exists
function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const data = fs.readFileSync(PROGRESS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.warn('Could not load progress file:', error.message);
  }
  return { processedSymbols: {}, lastSymbolIndex: 0 };
}

// Save progress to file
function saveProgress(progress) {
  try {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), 'utf8');
  } catch (error) {
    console.error('Error saving progress:', error.message);
  }
}

// Fetch historical data for a symbol from Polygon API with retry mechanism
async function fetchHistoricalData(symbol, startDate, endDate, multiplier = 1, timespan = 'day', retries = 3) {
  try {
    const url = `${POLYGON_BASE_URL}/v2/aggs/ticker/${symbol}/range/${multiplier}/${timespan}/${startDate}/${endDate}`;
    
    console.log(`Fetching historical data for ${symbol}: ${startDate} to ${endDate}`);
    
    const response = await axios.get(url, {
      params: {
        apiKey: POLYGON_API_KEY,
        adjusted: true,
        limit: 50000 // Maximum limit to get all data
      },
      timeout: 30000 // 30 second timeout
    });
    
    if (response.data && response.data.results && response.data.results.length > 0) {
      console.log(`Received ${response.data.results.length} data points for ${symbol}`);
      return response.data.results;
    } else {
      console.log(`No data found for ${symbol} in the specified date range`);
      return [];
    }
  } catch (error) {
    console.error(`Error fetching historical data for ${symbol}:`, error.message);
    
    if (error.response) {
      console.error('Response status:', error.response.status);
      
      // Handle rate limiting
      if (error.response.status === 429) {
        console.log('Rate limit hit, waiting longer before retry...');
        await sleep(60000); // Wait a full minute
        if (retries > 0) {
          console.log(`Retrying (${retries} attempts left)...`);
          return fetchHistoricalData(symbol, startDate, endDate, multiplier, timespan, retries - 1);
        }
      }
      
      // Log response data for debugging
      if (error.response.data) {
        console.error('Response data:', error.response.data);
      }
    }
    
    // Retry for network errors or other transient issues
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      if (retries > 0) {
        console.log(`Network error, retrying (${retries} attempts left)...`);
        await sleep(5000);
        return fetchHistoricalData(symbol, startDate, endDate, multiplier, timespan, retries - 1);
      }
    }
    
    return [];
  }
}

// Convert polygon data to Timestream records
function convertToTimestreamRecords(symbol, data, assetType = 'stock') {
  return data.map(item => {
    // Timestream requires millisecond timestamp
    const timestamp = item.t.toString();
    
    // Create dimensions (attributes we want to filter/query by)
    const dimensions = [
      { Name: 'symbol', Value: symbol },
      { Name: 'asset_type', Value: assetType }
    ];
    
    return {
      Dimensions: dimensions,
      MeasureName: 'price_data',
      MeasureValues: [
        { Name: 'open', Value: item.o.toString(), Type: 'DOUBLE' },
        { Name: 'high', Value: item.h.toString(), Type: 'DOUBLE' },
        { Name: 'low', Value: item.l.toString(), Type: 'DOUBLE' },
        { Name: 'close', Value: item.c.toString(), Type: 'DOUBLE' },
        { Name: 'volume', Value: item.v.toString(), Type: 'DOUBLE' },
      ],
      Time: timestamp,
      TimeUnit: 'MILLISECONDS'
    };
  });
}

// Write records to Timestream in batches (max 100 per write)
async function writeRecordsToTimestream(records) {
  if (!records || records.length === 0) {
    return { success: true, processedCount: 0 };
  }
  
  const batchSize = 100; // Timestream limit
  const results = {
    success: true,
    processedCount: 0,
    errors: []
  };
  
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    
    try {
      const params = {
        DatabaseName: TIMESTREAM_DB,
        TableName: TIMESTREAM_TABLE,
        Records: batch
      };
      
      const command = new WriteRecordsCommand(params);
      await timestreamClient.send(command);
      
      results.processedCount += batch.length;
      console.log(`Successfully wrote batch of ${batch.length} records to Timestream`);
    } catch (error) {
      console.error(`Error writing batch to Timestream:`, error);
      
      // Check for throttling and retry
      if (error.name === 'ThrottlingException' || error.name === 'RejectedRecordsException') {
        console.log('Timestream throttling detected, waiting before retry...');
        await sleep(2000);
        
        try {
          const params = {
            DatabaseName: TIMESTREAM_DB,
            TableName: TIMESTREAM_TABLE,
            Records: batch
          };
          
          const command = new WriteRecordsCommand(params);
          await timestreamClient.send(command);
          
          results.processedCount += batch.length;
          console.log(`Successfully wrote batch on retry`);
        } catch (retryError) {
          console.error(`Error on retry:`, retryError);
          results.success = false;
          results.errors.push(retryError.message);
        }
      } else {
        results.success = false;
        results.errors.push(error.message);
      }
    }
    
    // Small delay between batch writes
    await sleep(200);
  }
  
  return results;
}

// Sleep function for rate limiting
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Process a single symbol for a specific year
async function processSymbolYear(symbol, year, assetType, progress) {
  try {
    // Skip if this year is already processed for this symbol
    if (progress.processedSymbols[symbol] && 
        progress.processedSymbols[symbol].includes(year)) {
      console.log(`Skipping ${symbol} for ${year} (already processed)`);
      return 0;
    }
    
    // For older years, process in smaller chunks (e.g., quarters) to avoid timeouts
    if (year < 2010) {
      let totalProcessed = 0;
      
      // Process by quarter
      for (let quarter = 1; quarter <= 4; quarter++) {
        const startMonth = (quarter - 1) * 3 + 1;
        const endMonth = quarter * 3;
        
        const startDate = `${year}-${String(startMonth).padStart(2, '0')}-01`;
        let endDate;
        
        if (quarter === 4) {
          endDate = `${year}-12-31`;
        } else {
          endDate = `${year}-${String(endMonth).padStart(2, '0')}-${endMonth === 2 ? '28' : '30'}`;
        }
        
        // Rate limiting
        await sleep(DELAY_BETWEEN_CALLS);
        
        const data = await fetchHistoricalData(symbol, startDate, endDate);
        
        if (data.length > 0) {
          const records = convertToTimestreamRecords(symbol, data, assetType);
          const result = await writeRecordsToTimestream(records);
          
          totalProcessed += result.processedCount;
          console.log(`Processed ${symbol} for ${year} Q${quarter}: ${result.processedCount} records written`);
        }
      }
      
      // Mark this year as processed
      if (!progress.processedSymbols[symbol]) {
        progress.processedSymbols[symbol] = [];
      }
      progress.processedSymbols[symbol].push(year);
      saveProgress(progress);
      
      return totalProcessed;
    } else {
      // Post-2010 data - process by entire year
      const startDate = `${year}-01-01`;
      const endDate = year === new Date().getFullYear() 
        ? new Date().toISOString().split('T')[0] // Today's date if current year
        : `${year}-12-31`;
      
      // Rate limiting
      await sleep(DELAY_BETWEEN_CALLS);
      
      const data = await fetchHistoricalData(symbol, startDate, endDate);
      
      if (data.length > 0) {
        const records = convertToTimestreamRecords(symbol, data, assetType);
        const result = await writeRecordsToTimestream(records);
        
        console.log(`Processed ${symbol} for ${year}: ${result.processedCount} records written`);
        
        // Mark this year as processed
        if (!progress.processedSymbols[symbol]) {
          progress.processedSymbols[symbol] = [];
        }
        progress.processedSymbols[symbol].push(year);
        saveProgress(progress);
        
        return result.processedCount;
      }
    }
    
    return 0;
  } catch (error) {
    console.error(`Error processing ${symbol} for year ${year}:`, error.message);
    return 0;
  }
}

// Main function to process all symbols
async function processAllSymbols() {
  try {
    // Get stock symbols from database
    const symbols = await getStockSymbols();
    console.log(`Found ${symbols.length} symbols to process`);
    
    // Load progress from file
    const progress = loadProgress();
    console.log(`Loaded progress: ${Object.keys(progress.processedSymbols).length} symbols partially processed`);
    
    const years = [];
    // Generate array of years from 2003 to current year
    for (let year = 2003; year <= new Date().getFullYear(); year++) {
      years.push(year);
    }
    
    let totalProcessed = 0;
    
    // Start from the last processed symbol if resuming
    const startIndex = Math.min(progress.lastSymbolIndex, symbols.length - 1);
    console.log(`Starting from symbol index ${startIndex}`);
    
    // Process each symbol year by year
    for (let i = startIndex; i < symbols.length; i++) {
      const symbolData = symbols[i];
      const symbol = symbolData.symbol;
      const assetType = symbolData.type || 'stock';
      
      console.log(`Processing ${symbol} (${assetType}) - ${i + 1}/${symbols.length}`);
      
      for (const year of years) {
        const processed = await processSymbolYear(symbol, year, assetType, progress);
        totalProcessed += processed;
      }
      
      // Update the last processed symbol index
      progress.lastSymbolIndex = i + 1;
      saveProgress(progress);
      
      // Add a larger delay between symbols
      await sleep(2000);
    }
    
    console.log(`Total historical records processed: ${totalProcessed}`);
    return { success: true, totalProcessed };
  } catch (error) {
    console.error('Error in main process:', error);
    return { success: false, error: error.message };
  } finally {
    // Close the database connection
    if (pool) await pool.end();
  }
}

// Check if running as script or module
if (require.main === module) {
  // Load environment variables from .env file if present
  try {
    require('dotenv').config();
  } catch (e) {
    console.log('dotenv not found, using environment variables');
  }
  
  console.log('Starting historical data load process...');
  processAllSymbols()
    .then(result => {
      console.log('Process completed:', result);
      process.exit(0);
    })
    .catch(error => {
      console.error('Process failed:', error);
      process.exit(1);
    });
} else {
  // Export for use as a module
  module.exports = {
    processAllSymbols,
    processSymbolYear,
    fetchHistoricalData,
    convertToTimestreamRecords,
    writeRecordsToTimestream
  };
} 