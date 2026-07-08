/**
 * Lambda function to fetch daily price updates from Polygon API
 * and store them in Amazon Timestream
 */

const axios = require('axios');
const { TimestreamWriteClient, WriteRecordsCommand } = require('@aws-sdk/client-timestream-write');
const { Pool } = require('pg');

// Configure AWS SDK
const REGION = process.env.AWS_REGION || 'us-east-1';
const TIMESTREAM_DB = process.env.TIMESTREAM_DATABASE || 'oracle';
const TIMESTREAM_TABLE = process.env.TIMESTREAM_TABLE || 'stock_prices';
const timestreamClient = new TimestreamWriteClient({ region: REGION });

// Polygon API configuration
const POLYGON_API_KEY = process.env.POLYGON_API_KEY;
const POLYGON_BASE_URL = 'https://api.polygon.io';

// Database configuration for retrieving symbols
let pool;

// Initialize PostgreSQL pool for getting stock symbols
const initializePool = () => {
  if (!pool) {
    pool = new Pool({
      user: process.env.DB_USER,
      host: process.env.DB_HOST,
      database: process.env.DB_NAME,
      password: process.env.DB_PASSWORD,
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

// Calculate previous trading day
function getPreviousTradingDay() {
  let date = new Date();
  date.setDate(date.getDate() - 1);
  
  // If yesterday was Sunday, use Friday's data
  if (date.getDay() === 0) {
    date.setDate(date.getDate() - 2);
  }
  // If yesterday was Saturday, use Friday's data
  else if (date.getDay() === 6) {
    date.setDate(date.getDate() - 1);
  }
  
  return date.toISOString().split('T')[0];
}

// Fetch daily data for a symbol
async function fetchDailyData(symbol, date) {
  try {
    console.log(`Fetching daily data for ${symbol} on ${date}`);
    
    // Use the aggregates endpoint for a single day
    const url = `${POLYGON_BASE_URL}/v2/aggs/ticker/${symbol}/range/1/day/${date}/${date}`;
    
    const response = await axios.get(url, {
      params: {
        apiKey: POLYGON_API_KEY,
        adjusted: true
      },
      timeout: 10000
    });
    
    if (response.data && response.data.results && response.data.results.length > 0) {
      console.log(`Received data for ${symbol} on ${date}`);
      return response.data.results;
    } else {
      console.log(`No data found for ${symbol} on ${date}`);
      return [];
    }
  } catch (error) {
    console.error(`Error fetching data for ${symbol}:`, error.message);
    
    if (error.response && error.response.data) {
      console.error('Response data:', error.response.data);
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

// Write records to Timestream
async function writeRecordsToTimestream(records) {
  if (!records || records.length === 0) {
    return { success: true, processedCount: 0 };
  }
  
  try {
    const params = {
      DatabaseName: TIMESTREAM_DB,
      TableName: TIMESTREAM_TABLE,
      Records: records
    };
    
    const command = new WriteRecordsCommand(params);
    await timestreamClient.send(command);
    
    return { success: true, processedCount: records.length };
  } catch (error) {
    console.error(`Error writing to Timestream:`, error);
    return { success: false, processedCount: 0, error: error.message };
  }
}

// Sleep function for rate limiting
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Process a batch of symbols
async function processBatchOfSymbols(symbols, date, context) {
  let successCount = 0;
  let errorCount = 0;
  let totalRecords = 0;
  
  for (const symbolData of symbols) {
    // Check for remaining execution time in Lambda
    const timeRemaining = context.getRemainingTimeInMillis();
    if (timeRemaining < 30000) { // Less than 30 seconds remaining
      console.log(`Less than 30 seconds remaining, stopping batch processing`);
      break;
    }
    
    const symbol = symbolData.symbol;
    const assetType = symbolData.type || 'stock';
    
    const data = await fetchDailyData(symbol, date);
    
    if (data.length > 0) {
      const records = convertToTimestreamRecords(symbol, data, assetType);
      const result = await writeRecordsToTimestream(records);
      
      if (result.success) {
        successCount++;
        totalRecords += result.processedCount;
      } else {
        errorCount++;
      }
    }
    
    // Rate limiting - 5 calls per minute (12 seconds between calls)
    await sleep(12000);
  }
  
  return {
    successCount,
    errorCount,
    totalRecords
  };
}

// Main Lambda handler
exports.handler = async (event, context) => {
  console.log('Starting daily price update process');
  context.callbackWaitsForEmptyEventLoop = false;
  
  try {
    // Get the date to fetch data for (yesterday by default)
    const date = event.date || getPreviousTradingDay();
    console.log(`Fetching price data for date: ${date}`);
    
    // Get batch parameters
    const startSymbolIndex = event.startSymbolIndex || 0;
    const batchSize = event.batchSize || 20; // Process 20 symbols per Lambda invocation
    
    // Get stock symbols from database
    const allSymbols = await getStockSymbols();
    console.log(`Found ${allSymbols.length} symbols in total`);
    
    // Take a batch of symbols to process
    const symbolBatch = allSymbols.slice(startSymbolIndex, startSymbolIndex + batchSize);
    
    if (symbolBatch.length === 0) {
      console.log('No symbols left to process');
      return {
        statusCode: 200,
        body: {
          message: 'Daily update complete',
          date: date,
          totalSymbols: allSymbols.length,
          processedSymbols: startSymbolIndex,
          remainingSymbols: 0
        }
      };
    }
    
    console.log(`Processing batch of ${symbolBatch.length} symbols starting from index ${startSymbolIndex}`);
    
    // Process this batch of symbols
    const result = await processBatchOfSymbols(symbolBatch, date, context);
    
    // Determine if there are more symbols to process
    const nextSymbolIndex = startSymbolIndex + symbolBatch.length;
    const remainingSymbols = allSymbols.length - nextSymbolIndex;
    
    return {
      statusCode: 200,
      body: {
        message: 'Batch processed successfully',
        date: date,
        batchProcessed: symbolBatch.length,
        successCount: result.successCount,
        errorCount: result.errorCount,
        totalProcessedRecords: result.totalRecords,
        nextSymbolIndex: nextSymbolIndex,
        remainingSymbols: remainingSymbols,
        moreToProcess: remainingSymbols > 0
      }
    };
  } catch (error) {
    console.error('Error in Lambda handler:', error);
    return {
      statusCode: 500,
      body: {
        message: 'Error processing request',
        error: error.message
      }
    };
  } finally {
    // Close the database connection
    if (pool) await pool.end();
  }
};