/**
 * Example application to query stock price data from Amazon Timestream
 * 
 * This script demonstrates how to query historical stock data stored in Timestream
 * and can be integrated into your main application.
 */

require('dotenv').config();
const { TimestreamQueryClient, QueryCommand } = require('@aws-sdk/client-timestream-query');

// Configure AWS SDK
const region = process.env.AWS_REGION || 'us-east-1';
const timestreamQuery = new TimestreamQueryClient({ region });

// Constants
const DATABASE_NAME = 'financial_data';
const TABLE_NAME = 'stock_prices';

/**
 * Query stock prices for a specific symbol and date range
 * 
 * @param {string} symbol - Stock symbol
 * @param {string} startDate - Start date in ISO format (YYYY-MM-DD)
 * @param {string} endDate - End date in ISO format (YYYY-MM-DD)
 * @returns {Promise<Array>} - Array of price records
 */
async function getStockPrices(symbol, startDate, endDate) {
  // Convert dates to epoch milliseconds for Timestream
  const startTime = new Date(startDate).getTime();
  const endTime = new Date(endDate).getTime() + (24 * 60 * 60 * 1000 - 1); // End of the day
  
  const query = `
    SELECT time, 
           symbol, 
           measure_name,
           CASE 
             WHEN measure_name = 'price_data' THEN 
               (SELECT measure_value::double FROM UNNEST(multi_measure_values) 
                WHERE measure_name = 'open')
           END AS open,
           CASE 
             WHEN measure_name = 'price_data' THEN 
               (SELECT measure_value::double FROM UNNEST(multi_measure_values) 
                WHERE measure_name = 'high')
           END AS high,
           CASE 
             WHEN measure_name = 'price_data' THEN 
               (SELECT measure_value::double FROM UNNEST(multi_measure_values) 
                WHERE measure_name = 'low')
           END AS low,
           CASE 
             WHEN measure_name = 'price_data' THEN 
               (SELECT measure_value::double FROM UNNEST(multi_measure_values) 
                WHERE measure_name = 'close')
           END AS close,
           CASE 
             WHEN measure_name = 'price_data' THEN 
               (SELECT measure_value::bigint FROM UNNEST(multi_measure_values) 
                WHERE measure_name = 'volume')
           END AS volume
    FROM "${DATABASE_NAME}"."${TABLE_NAME}"
    WHERE symbol = '${symbol}'
      AND time BETWEEN FROM_MILLISECONDS(${startTime}) AND FROM_MILLISECONDS(${endTime})
    ORDER BY time ASC
  `;
  
  console.log(`Executing query: ${query}`);
  
  try {
    const command = new QueryCommand({ QueryString: query });
    const response = await timestreamQuery.send(command);
    
    // Process and format the results
    const results = [];
    for (const row of response.Rows) {
      const data = {};
      response.ColumnInfo.forEach((column, i) => {
        const columnName = column.Name;
        const value = row.Data[i].ScalarValue;
        
        // Convert time to readable format
        if (columnName === 'time') {
          data.date = new Date(value).toISOString().split('T')[0];
        } else {
          // Convert numeric values from string
          if (['open', 'high', 'low', 'close'].includes(columnName)) {
            data[columnName] = parseFloat(value);
          } else if (columnName === 'volume') {
            data[columnName] = parseInt(value);
          } else {
            data[columnName] = value;
          }
        }
      });
      results.push(data);
    }
    
    console.log(`Retrieved ${results.length} price records for ${symbol}`);
    return results;
  } catch (error) {
    console.error(`Error querying Timestream: ${error.message}`);
    throw error;
  }
}

/**
 * Get the most recent price for a list of symbols
 * 
 * @param {Array<string>} symbols - Array of stock symbols
 * @returns {Promise<Object>} - Object with symbol as key and price data as value
 */
async function getLatestPrices(symbols) {
  const symbolList = symbols.map(s => `'${s}'`).join(',');
  
  const query = `
    WITH latest_times AS (
      SELECT symbol, MAX(time) as max_time
      FROM "${DATABASE_NAME}"."${TABLE_NAME}"
      WHERE symbol IN (${symbolList})
      GROUP BY symbol
    )
    SELECT t.time, 
           t.symbol,
           t.measure_name,
           CASE 
             WHEN t.measure_name = 'price_data' THEN 
               (SELECT measure_value::double FROM UNNEST(t.multi_measure_values) 
                WHERE measure_name = 'close')
           END AS close
    FROM "${DATABASE_NAME}"."${TABLE_NAME}" t
    INNER JOIN latest_times l
      ON t.symbol = l.symbol AND t.time = l.max_time
  `;
  
  console.log(`Executing query for latest prices of ${symbols.length} symbols`);
  
  try {
    const command = new QueryCommand({ QueryString: query });
    const response = await timestreamQuery.send(command);
    
    // Process and format the results
    const results = {};
    for (const row of response.Rows) {
      const data = {};
      let symbol = '';
      
      response.ColumnInfo.forEach((column, i) => {
        const columnName = column.Name;
        const value = row.Data[i].ScalarValue;
        
        if (columnName === 'symbol') {
          symbol = value;
        } else if (columnName === 'time') {
          data.date = new Date(value).toISOString().split('T')[0];
        } else if (columnName === 'close') {
          data.close = parseFloat(value);
        }
      });
      
      results[symbol] = data;
    }
    
    console.log(`Retrieved latest prices for ${Object.keys(results).length} symbols`);
    return results;
  } catch (error) {
    console.error(`Error querying latest prices: ${error.message}`);
    throw error;
  }
}

// Example usage
async function runExamples() {
  try {
    // Example 1: Query historical prices for a specific symbol
    const appleData = await getStockPrices('AAPL', '2024-01-01', '2024-03-01');
    console.log('AAPL Historical Data:', appleData.slice(0, 5)); // Show first 5 records
    
    // Example 2: Get latest prices for multiple symbols
    const latestPrices = await getLatestPrices(['AAPL', 'MSFT', 'GOOGL', 'AMZN']);
    console.log('Latest Prices:', latestPrices);
    
  } catch (error) {
    console.error('Error running examples:', error);
  }
}

// Run examples if called directly
if (require.main === module) {
  runExamples();
}

// Export functions for use in other modules
module.exports = {
  getStockPrices,
  getLatestPrices
}; 