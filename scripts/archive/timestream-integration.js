/**
 * Example integration showing how to replace PostgreSQL queries with Timestream
 * for the Oracle application
 * 
 * This file demonstrates side-by-side comparisons of:
 * 1. Original PostgreSQL queries
 * 2. Equivalent Timestream queries
 */

require('dotenv').config();
const { Pool } = require('pg');
const { getStockPrices, getLatestPrices } = require('./query-timestream');

// PostgreSQL connection
const pgPool = new Pool({
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  port: process.env.PG_PORT || 5432
});

/**
 * EXAMPLE 1: Get historical stock data for a symbol
 */

// Original PostgreSQL function
async function getHistoricalDataFromPG(symbol, startDate, endDate) {
  const query = {
    text: `
      SELECT 
        date, symbol, open, high, low, close, volume
      FROM 
        stock_prices
      WHERE 
        symbol = $1 AND date BETWEEN $2 AND $3
      ORDER BY 
        date ASC
    `,
    values: [symbol, startDate, endDate]
  };
  
  try {
    const result = await pgPool.query(query);
    console.log(`PostgreSQL: Retrieved ${result.rows.length} records for ${symbol}`);
    return result.rows;
  } catch (error) {
    console.error('PostgreSQL Error:', error);
    throw error;
  }
}

// Timestream replacement
async function getHistoricalDataFromTimestream(symbol, startDate, endDate) {
  try {
    const data = await getStockPrices(symbol, startDate, endDate);
    console.log(`Timestream: Retrieved ${data.length} records for ${symbol}`);
    return data;
  } catch (error) {
    console.error('Timestream Error:', error);
    throw error;
  }
}

/**
 * EXAMPLE 2: Get latest prices for a watchlist
 */

// Original PostgreSQL function
async function getLatestPricesFromPG(symbols) {
  const query = {
    text: `
      WITH latest_dates AS (
        SELECT 
          symbol, MAX(date) as max_date
        FROM 
          stock_prices
        WHERE 
          symbol = ANY($1)
        GROUP BY 
          symbol
      )
      SELECT 
        s.symbol, s.date, s.close
      FROM 
        stock_prices s
      INNER JOIN 
        latest_dates l ON s.symbol = l.symbol AND s.date = l.max_date
    `,
    values: [symbols]
  };
  
  try {
    const result = await pgPool.query(query);
    console.log(`PostgreSQL: Retrieved latest prices for ${result.rows.length} symbols`);
    
    // Convert array to object for easier lookup
    const priceMap = {};
    for (const row of result.rows) {
      priceMap[row.symbol] = {
        date: row.date,
        close: row.close
      };
    }
    
    return priceMap;
  } catch (error) {
    console.error('PostgreSQL Error:', error);
    throw error;
  }
}

// Timestream replacement
async function getLatestPricesFromTimestream(symbols) {
  try {
    const data = await getLatestPrices(symbols);
    console.log(`Timestream: Retrieved latest prices for ${Object.keys(data).length} symbols`);
    return data;
  } catch (error) {
    console.error('Timestream Error:', error);
    throw error;
  }
}

/**
 * Run examples that demonstrate both PostgreSQL and Timestream queries
 */
async function runComparison() {
  try {
    console.log('EXAMPLE 1: Historical Data Comparison\n');
    const pgHistorical = await getHistoricalDataFromPG('AAPL', '2024-01-01', '2024-03-01');
    const tsHistorical = await getHistoricalDataFromTimestream('AAPL', '2024-01-01', '2024-03-01');
    
    console.log('\nPostgreSQL Result (first 2 records):');
    console.log(pgHistorical.slice(0, 2));
    
    console.log('\nTimestream Result (first 2 records):');
    console.log(tsHistorical.slice(0, 2));
    
    console.log('\n----------------------------------------\n');
    
    console.log('EXAMPLE 2: Latest Prices Comparison\n');
    const symbols = ['AAPL', 'MSFT', 'GOOGL', 'AMZN'];
    const pgLatest = await getLatestPricesFromPG(symbols);
    const tsLatest = await getLatestPricesFromTimestream(symbols);
    
    console.log('\nPostgreSQL Result:');
    console.log(pgLatest);
    
    console.log('\nTimestream Result:');
    console.log(tsLatest);
    
  } catch (error) {
    console.error('Comparison error:', error);
  } finally {
    // Close PostgreSQL connection
    await pgPool.end();
  }
}

// Run the comparison if executed directly
if (require.main === module) {
  runComparison();
}

// Export functions for use in other modules
module.exports = {
  // PostgreSQL functions
  getHistoricalDataFromPG,
  getLatestPricesFromPG,
  
  // Timestream functions
  getHistoricalDataFromTimestream,
  getLatestPricesFromTimestream
}; 