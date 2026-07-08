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

// Fetch previous trading day's data
async function fetchPreviousDayData(symbol) {
  try {
    // Get yesterday's date, considering weekends
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
    
    const formattedDate = date.toISOString().split('T')[0];
    
    console.log(`Fetching data for ${symbol} on ${formattedDate}`);
    
    const url = `${POLYGON_BASE_URL}/v1/open-close/${symbol}/${formattedDate}`;
    
    const response = await axios.get(url, {
      params: {
        adjusted: true,
        apiKey: POLYGON_API_KEY
      },
      timeout: 10000
    });
    
    if (response.data && response.data.status === 'OK') {
      console.log(`Successfully fetched data for ${symbol}`);
      return response.data;
    } else {
      console.log(`No data available for ${symbol} on ${formattedDate}`);
      return null;
    }
  } catch (error) {
    console.error(`Error fetching data for ${symbol}:`, error.message);
    return null;
  }
}

// Convert Polygon data to Timestream record
function convertToTimestreamRecord(symbol, data, assetType = 'stock') {
  // Convert timestamp to milliseconds
  const date = new Date(data.from);
  const timestamp = date.getTime().toString();
  
  // Create dimensions (attributes we want to filter/query by)
  const dimensions = [
    { Name: 'symbol', Value: symbol },
    { Name: 'asset_type', Value: assetType }
  ];
  
  return {
    Dimensions: dimensions,
    MeasureName: 'price_data',
    MeasureValues: [
      { Name: 'open', Value: data.open.toString(), Type: 'DOUBLE' },
      { Name: 'high', Value: data.high.toString(), Type: 'DOUBLE' },
      { Name: 'low', Value: data.low.toString(), Type: 'DOUBLE' },
      { Name: 'close', Value: data.close.toString(), Type: 'DOUBLE' },
      { Name: 'volume', Value: data.volume.toString(), Type: 'DOUBLE' },
    ],
    Time: timestamp,
    TimeUnit: 'MILLISECONDS'
  };
}

// Write record to Timestream
async function writeRecordToTimestream(record) {
  try {
    const params = {
      DatabaseName: TIMESTREAM_DB,
      TableName: TIMESTREAM_TABLE,
      Records: [record]
    };
    
    const command = new WriteRecordsCommand(params);
    await timestreamClient.send(command);
    
    return true;
  } catch (error) {
    console.error(`Error writing to Timestream:`, error);
    return false;
  }
}

// Sleep function for rate limiting
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Main Lambda handler
exports.handler = async (event, context) => {
  console.log('Starting daily price update process');
  context.callbackWaitsForEmptyEventLoop = false;
  
  try {
    // Get stock symbols from database
    const symbols = await getStockSymbols();
    console.log(`Found ${symbols.length} symbols to process`);
    
    let successCount = 0;
    let errorCount = 0;
    
    // Process each symbol
    for (const symbolData of symbols) {
      const symbol = symbolData.symbol;
      const assetType = symbolData.type || 'stock';
      
      const data = await fetchPreviousDayData(symbol);
      
      if (data) {
        const record = convertToTimestreamRecord(symbol, data, assetType);
        const success = await writeRecordToTimestream(record);
        
        if (success) {
          successCount++;
        } else {
          errorCount++;
        }
      }
      
      // Rate limiting - Polygon's free tier allows 5 calls per minute
      await sleep(12000); // 12 seconds between calls to stay well under the limit
    }
    
    console.log(`Completed with ${successCount} successful updates and ${errorCount} errors`);
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Processing complete',
        successCount,
        errorCount
      })
    };
  } catch (error) {
    console.error('Error in Lambda handler:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Error processing request',
        error: error.message
      })
    };
  } finally {
    // Close the database connection
    if (pool) await pool.end();
  }
};
