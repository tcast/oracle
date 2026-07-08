const { Pool } = require('pg');
const axios = require('axios');

// Initialize database connection pool
let pool;

const initializePool = () => {
  if (!pool) {
    pool = new Pool({
      user: process.env.DB_USER,
      host: process.env.DB_HOST,
      database: process.env.DB_NAME,
      password: process.env.DB_PASSWORD,
      port: process.env.DB_PORT || 5432,
      ssl: process.env.DB_SSL === 'true' ? {
        rejectUnauthorized: false
      } : false
    });
    
    console.log('Database pool initialized');
  }
  return pool;
};

// Helper function to implement exponential backoff for API rate limits
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Add retry mechanism for API calls
const retryApiCall = async (apiCall, maxRetries = 3, initialDelay = 1000) => {
  let delay = initialDelay;
  let retries = 0;
  
  while (retries < maxRetries) {
    try {
      return await apiCall();
    } catch (error) {
      if (error.response && (error.response.status === 429 || error.response.status === 403)) {
        // Rate limit hit or auth error, exponential backoff
        retries++;
        console.log(`API error (${error.response.status}), retrying after ${delay}ms (retry ${retries}/${maxRetries})`);
        await sleep(delay);
        delay *= 2; // Exponential backoff
      } else {
        // Other error, just throw it
        throw error;
      }
    }
  }
  
  throw new Error(`Failed after ${maxRetries} retries`);
};

// Validate API keys
const validateApiKeys = () => {
  const apiKeys = {
    polygon: process.env.POLYGON_API_KEY,
    finnhub: process.env.FINNHUB_API_KEY,
    alphaVantage: process.env.ALPHA_VANTAGE_API_KEY,
    cryptoCompare: process.env.CRYPTO_COMPARE_API_KEY
  };

  // Log which API keys are available (without showing the actual keys)
  const availableApis = Object.entries(apiKeys)
    .filter(([_, value]) => value && value.trim() !== "")
    .map(([key, _]) => key);
  
  console.log(`Available APIs: ${availableApis.join(', ')}`);
  
  return apiKeys;
};

const updateSymbolOHLC = async (symbol) => {
  try {
    const pool = initializePool();
    const apiKeys = validateApiKeys();
    
    // Get the last date for this symbol in the database
    const lastDateQuery = await pool.query(
      'SELECT MAX(date) as last_date FROM stock_prices WHERE symbol = $1',
      [symbol]
    );
    
    let lastDate = null;
    if (lastDateQuery.rows[0].last_date) {
      lastDate = new Date(lastDateQuery.rows[0].last_date);
      // Add one day to get the start date for new data
      lastDate.setDate(lastDate.getDate() + 1);
    } else {
      // If no data exists, get the last 30 days
      lastDate = new Date();
      lastDate.setDate(lastDate.getDate() - 30);
    }
    
    const startDateStr = lastDate.toISOString().split('T')[0];
    const endDate = new Date();
    const endDateStr = endDate.toISOString().split('T')[0];
    
    // If start date is after or equal to today, no update needed
    if (new Date(startDateStr) >= new Date(endDateStr)) {
      return {
        symbol,
        success: true,
        message: 'Data already up to date',
        daysAdded: 0
      };
    }
    
    console.log(`Updating ${symbol} from ${startDateStr} to ${endDateStr}`);
    
    // Try Polygon API first
    if (apiKeys.polygon && apiKeys.polygon.trim() !== "") {
      try {
        const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/day/${startDateStr}/${endDateStr}?adjusted=true&sort=asc&limit=50000&apiKey=${apiKeys.polygon}`;
        const response = await retryApiCall(() => axios.get(url, { timeout: 10000 }));
        
        if (response.data.results && response.data.results.length > 0) {
          const priceData = response.data.results.map(item => ({
            date: new Date(item.t).toISOString().split('T')[0],
            open: item.o,
            high: item.h,
            low: item.l,
            close: item.c,
            adjustedClose: item.c,
            volume: item.v
          }));
          
          await storeOHLCData(symbol, priceData);
          return { 
            symbol, 
            success: true, 
            source: 'Polygon',
            daysAdded: priceData.length
          };
        }
      } catch (error) {
        console.error(`Polygon API error for ${symbol}: ${error.message}`);
      }
    }
    
    // Try Finnhub API next
    if (apiKeys.finnhub && apiKeys.finnhub.trim() !== "") {
      try {
        const unixStart = Math.floor(new Date(startDateStr).getTime() / 1000);
        const unixEnd = Math.floor(new Date(endDateStr).getTime() / 1000);
        const url = `https://finnhub.io/api/v1/stock/candle?symbol=${symbol}&resolution=D&from=${unixStart}&to=${unixEnd}&token=${apiKeys.finnhub}`;
        
        const response = await retryApiCall(() => axios.get(url, { timeout: 10000 }));
        
        if (response.data.s === 'ok' && response.data.t && response.data.t.length > 0) {
          const priceData = [];
          for (let i = 0; i < response.data.t.length; i++) {
            priceData.push({
              date: new Date(response.data.t[i] * 1000).toISOString().split('T')[0],
              open: response.data.o[i],
              high: response.data.h[i],
              low: response.data.l[i],
              close: response.data.c[i],
              adjustedClose: response.data.c[i],
              volume: response.data.v[i]
            });
          }
          
          await storeOHLCData(symbol, priceData);
          return { 
            symbol, 
            success: true, 
            source: 'Finnhub',
            daysAdded: priceData.length
          };
        }
      } catch (error) {
        console.error(`Finnhub API error for ${symbol}: ${error.message}`);
      }
    }
    
    // Try Alpha Vantage API as last resort
    if (apiKeys.alphaVantage && apiKeys.alphaVantage.trim() !== "") {
      try {
        const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${symbol}&outputsize=compact&apikey=${apiKeys.alphaVantage}`;
        
        const response = await retryApiCall(() => axios.get(url, { timeout: 10000 }));
        
        if (response.data && response.data['Time Series (Daily)']) {
          const timeSeriesData = response.data['Time Series (Daily)'];
          const priceData = [];
          
          for (const date in timeSeriesData) {
            const dataDate = new Date(date);
            // Only include dates after our last date
            if (dataDate >= new Date(startDateStr) && dataDate <= new Date(endDateStr)) {
              const dataPoint = timeSeriesData[date];
              priceData.push({
                date,
                open: parseFloat(dataPoint['1. open']),
                high: parseFloat(dataPoint['2. high']),
                low: parseFloat(dataPoint['3. low']),
                close: parseFloat(dataPoint['4. close']),
                adjustedClose: parseFloat(dataPoint['5. adjusted close']),
                volume: parseInt(dataPoint['6. volume'], 10)
              });
            }
          }
          
          if (priceData.length > 0) {
            await storeOHLCData(symbol, priceData);
            return { 
              symbol, 
              success: true, 
              source: 'Alpha Vantage',
              daysAdded: priceData.length
            };
          }
        }
      } catch (error) {
        console.error(`Alpha Vantage API error for ${symbol}: ${error.message}`);
      }
    }
    
    // Try CryptoCompare API for crypto symbols
    if (apiKeys.cryptoCompare && apiKeys.cryptoCompare.trim() !== "") {
      try {
        // Check if symbol might be a crypto (typically shorter symbols, or contain 'BTC', 'ETH', etc.)
        if (symbol.length <= 5 || symbol.includes('BTC') || symbol.includes('ETH') || symbol.includes('USDT')) {
          const cryptoSymbol = symbol.replace('-USD', '').replace('USD', '');
          const days = Math.ceil((new Date(endDateStr) - new Date(startDateStr)) / (1000 * 60 * 60 * 24)) + 1;
          
          const url = `https://min-api.cryptocompare.com/data/v2/histoday?fsym=${cryptoSymbol}&tsym=USD&limit=${days}&api_key=${apiKeys.cryptoCompare}`;
          
          const response = await retryApiCall(() => axios.get(url, { timeout: 10000 }));
          
          if (response.data && response.data.Response === 'Success' && response.data.Data && response.data.Data.Data) {
            const data = response.data.Data.Data;
            const priceData = [];
            
            for (const item of data) {
              const itemDate = new Date(item.time * 1000);
              const dateStr = itemDate.toISOString().split('T')[0];
              
              if (itemDate >= new Date(startDateStr) && itemDate <= new Date(endDateStr)) {
                priceData.push({
                  date: dateStr,
                  open: item.open,
                  high: item.high,
                  low: item.low,
                  close: item.close,
                  adjustedClose: item.close,
                  volume: item.volumeto
                });
              }
            }
            
            if (priceData.length > 0) {
              await storeOHLCData(symbol, priceData);
              return { 
                symbol, 
                success: true, 
                source: 'CryptoCompare',
                daysAdded: priceData.length
              };
            }
          }
        }
      } catch (error) {
        console.error(`CryptoCompare API error for ${symbol}: ${error.message}`);
      }
    }
    
    return { 
      symbol, 
      success: false, 
      message: 'Failed to update data from any API source' 
    };
  } catch (error) {
    console.error(`Error updating ${symbol}: ${error.message}`);
    return { 
      symbol, 
      success: false, 
      error: error.message 
    };
  }
};

const storeOHLCData = async (symbol, data) => {
  if (!data || data.length === 0) {
    return;
  }
  
  const pool = initializePool();
  
  // Create table if it doesn't exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_prices (
      id SERIAL PRIMARY KEY,
      symbol VARCHAR(20) NOT NULL,
      date DATE NOT NULL,
      open NUMERIC(15,4),
      high NUMERIC(15,4),
      low NUMERIC(15,4),
      close NUMERIC(15,4),
      adjusted_close NUMERIC(15,4),
      volume BIGINT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(symbol, date)
    )
  `);
  
  // Create index if it doesn't exist
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_stock_prices_symbol_date 
    ON stock_prices(symbol, date)
  `);
  
  // Insert data in batches
  const batchSize = 100;
  
  for (let i = 0; i < data.length; i += batchSize) {
    const batch = data.slice(i, i + batchSize);
    
    // Build a batch query with parameters
    const values = batch.map((_, index) => {
      const offset = index * 7;
      return `($1, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8})`;
    }).join(', ');
    
    const params = [symbol, ...batch.flatMap(item => [
      item.date,
      item.open,
      item.high,
      item.low,
      item.close,
      item.adjustedClose,
      item.volume
    ])];
    
    const query = `
      INSERT INTO stock_prices (symbol, date, open, high, low, close, adjusted_close, volume)
      VALUES ${values}
      ON CONFLICT (symbol, date) 
      DO UPDATE SET 
        open = EXCLUDED.open,
        high = EXCLUDED.high,
        low = EXCLUDED.low,
        close = EXCLUDED.close,
        adjusted_close = EXCLUDED.adjusted_close,
        volume = EXCLUDED.volume,
        updated_at = CURRENT_TIMESTAMP
    `;
    
    await pool.query(query, params);
  }
  
  console.log(`Stored ${data.length} price records for ${symbol}`);
};

exports.handler = async (event, context) => {
  try {
    console.log('Starting Daily OHLC update process');
    context.callbackWaitsForEmptyEventLoop = false;
    
    const pool = initializePool();
    
    // Get all active symbols from the database
    const symbolsResult = await pool.query(
      'SELECT symbol FROM stock_symbols WHERE active = true ORDER BY symbol'
    );
    
    // Get symbols and limit the batch size if necessary
    let symbols = symbolsResult.rows.map(row => row.symbol);

    // Check if we have a specific limit in the event
    if (event && event.limit && typeof event.limit === 'number') {
      console.log(`Limiting batch to ${event.limit} symbols as requested`);
      symbols = symbols.slice(0, event.limit);
    }

    // Add overall timeout for the lambda to avoid running too long
    const startTime = Date.now();
    const MAX_EXECUTION_TIME = 800000; // 800 seconds (just under the 900s Lambda limit)

    console.log(`Found ${symbols.length} active symbols to update`);
    
    // Process symbols in smaller batches to avoid overwhelming the database and API rate limits
    const batchSize = 5; // Reduced batch size to avoid rate limits
    let processed = 0;
    let successful = 0;
    let failures = 0;
    let alreadyUpToDate = 0;
    
    const results = {
      totalSymbols: symbols.length,
      processed: 0,
      successful: 0,
      alreadyUpToDate: 0,
      failed: 0,
      details: []
    };
    
    // Process symbols in batches
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      
      // Process each symbol in the batch concurrently
      const batchResults = await Promise.all(
        batch.map(symbol => updateSymbolOHLC(symbol))
      );
      
      // Update statistics
      for (const result of batchResults) {
        results.details.push(result);
        
        if (result.success) {
          if (result.message === 'Data already up to date') {
            alreadyUpToDate++;
          } else {
            successful++;
          }
        } else {
          failures++;
        }
      }
      
      processed += batch.length;
      
      // Check if we're approaching the Lambda timeout
      const currentTime = Date.now();
      const elapsedTime = currentTime - startTime;
      if (elapsedTime > MAX_EXECUTION_TIME) {
        console.log(`Approaching Lambda timeout limit. Processed ${processed}/${symbols.length} symbols before stopping.`);
        break;
      }
      
      // Add delay between batches to respect API rate limits
      if (i + batchSize < symbols.length) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // Increased delay to 2 seconds
      }
      
      console.log(`Processed ${processed}/${symbols.length} symbols`);
    }
    
    // Update final stats
    results.processed = processed;
    results.successful = successful;
    results.alreadyUpToDate = alreadyUpToDate;
    results.failed = failures;
    
    console.log(`OHLC update completed. Successful: ${successful}, Already up to date: ${alreadyUpToDate}, Failed: ${failures}`);
    
    return {
      statusCode: 200,
      body: JSON.stringify(results)
    };
  } catch (error) {
    console.error('Lambda execution error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to update OHLC data',
        message: error.message
      })
    };
  } finally {
    // Close the database pool
    if (pool) {
      await pool.end();
      console.log('Database pool closed');
    }
  }
}; 