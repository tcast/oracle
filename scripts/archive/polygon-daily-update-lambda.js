const { TimestreamWriteClient, WriteRecordsCommand } = require('@aws-sdk/client-timestream-write');
const axios = require('axios');

// Configuration
const POLYGON_API_KEY = process.env.POLYGON_API_KEY; // Set in Lambda environment variables
const TIMESTREAM_REGION = 'us-east-1';
const TIMESTREAM_DB = 'oracle';
const TIMESTREAM_TABLE = 'stock_prices';
const BATCH_SIZE = 100; // Maximum number of records per Timestream write request
const MAX_CONCURRENT_BATCHES = 20; // Maximum number of concurrent API calls

// Initialize Timestream client
const timestreamClient = new TimestreamWriteClient({ region: TIMESTREAM_REGION });

/**
 * Get yesterday's date in format YYYY-MM-DD
 */
function getYesterdayDate() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  
  // Skip weekends as markets are closed
  const day = date.getDay(); // 0 = Sunday, 6 = Saturday
  if (day === 0) date.setDate(date.getDate() - 2); // If Sunday, go to Friday
  if (day === 6) date.setDate(date.getDate() - 1); // If Saturday, go to Friday
  
  return date.toISOString().split('T')[0];
}

/**
 * Fetch tickers that we want to track from Polygon API
 */
async function fetchTickers() {
  console.log('Fetching active tickers from Polygon...');
  
  // Only get active stocks traded on major US exchanges
  const tickersUrl = `https://api.polygon.io/v3/reference/tickers?market=stocks&active=true&limit=1000&apiKey=${POLYGON_API_KEY}`;
  
  try {
    const response = await axios.get(tickersUrl);
    const tickers = response.data.results.map(result => result.ticker);
    console.log(`Retrieved ${tickers.length} active tickers`);
    return tickers;
  } catch (error) {
    console.error('Error fetching tickers:', error.message);
    throw new Error(`Failed to fetch tickers: ${error.message}`);
  }
}

/**
 * Fetch stock data for a specific date and ticker
 */
async function fetchStockData(date, ticker) {
  const url = `https://api.polygon.io/v1/open-close/${ticker}/${date}?adjusted=true&apiKey=${POLYGON_API_KEY}`;
  
  try {
    const response = await axios.get(url);
    return response.data;
  } catch (error) {
    // Markets are closed on holidays, so 404s are expected for some dates
    if (error.response && error.response.status === 404) {
      console.log(`No data for ${ticker} on ${date} (market may have been closed)`);
      return null;
    }
    
    // Handle rate limiting by waiting and retrying
    if (error.response && error.response.status === 429) {
      console.log(`Rate limit hit for ${ticker}, waiting and retrying...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      return fetchStockData(date, ticker);
    }
    
    console.error(`Error fetching data for ${ticker} on ${date}:`, error.message);
    return null;
  }
}

/**
 * Convert a single stock data object to Timestream records
 */
function convertToTimestreamRecords(stockData) {
  if (!stockData || !stockData.symbol || !stockData.from) {
    return [];
  }
  
  const ticker = stockData.symbol;
  const dateStr = stockData.from; // YYYY-MM-DD format
  const timestamp = Date.now().toString(); // Current time in milliseconds
  
  const records = [];
  
  // Only add records for fields that exist and are not zero
  if (stockData.volume) {
    records.push({
      Dimensions: [
        { Name: 'ticker', Value: ticker },
        { Name: 'date', Value: dateStr }
      ],
      MeasureName: 'volume',
      MeasureValue: stockData.volume.toString(),
      MeasureValueType: 'DOUBLE',
      Time: timestamp,
      TimeUnit: 'MILLISECONDS'
    });
  }
  
  if (stockData.open) {
    records.push({
      Dimensions: [
        { Name: 'ticker', Value: ticker },
        { Name: 'date', Value: dateStr }
      ],
      MeasureName: 'open',
      MeasureValue: stockData.open.toString(),
      MeasureValueType: 'DOUBLE',
      Time: (Number(timestamp) + 1).toString(), // Offset by 1ms to avoid conflicts
      TimeUnit: 'MILLISECONDS'
    });
  }
  
  if (stockData.close) {
    records.push({
      Dimensions: [
        { Name: 'ticker', Value: ticker },
        { Name: 'date', Value: dateStr }
      ],
      MeasureName: 'close',
      MeasureValue: stockData.close.toString(),
      MeasureValueType: 'DOUBLE',
      Time: (Number(timestamp) + 2).toString(), // Offset by 2ms
      TimeUnit: 'MILLISECONDS'
    });
  }
  
  if (stockData.high) {
    records.push({
      Dimensions: [
        { Name: 'ticker', Value: ticker },
        { Name: 'date', Value: dateStr }
      ],
      MeasureName: 'high',
      MeasureValue: stockData.high.toString(),
      MeasureValueType: 'DOUBLE',
      Time: (Number(timestamp) + 3).toString(), // Offset by 3ms
      TimeUnit: 'MILLISECONDS'
    });
  }
  
  if (stockData.low) {
    records.push({
      Dimensions: [
        { Name: 'ticker', Value: ticker },
        { Name: 'date', Value: dateStr }
      ],
      MeasureName: 'low',
      MeasureValue: stockData.low.toString(),
      MeasureValueType: 'DOUBLE',
      Time: (Number(timestamp) + 4).toString(), // Offset by 4ms
      TimeUnit: 'MILLISECONDS'
    });
  }
  
  // Some APIs provide transactions count, include it if available
  if (stockData.transactions) {
    records.push({
      Dimensions: [
        { Name: 'ticker', Value: ticker },
        { Name: 'date', Value: dateStr }
      ],
      MeasureName: 'transactions',
      MeasureValue: stockData.transactions.toString(),
      MeasureValueType: 'DOUBLE',
      Time: (Number(timestamp) + 5).toString(), // Offset by 5ms
      TimeUnit: 'MILLISECONDS'
    });
  }
  
  return records;
}

/**
 * Write records to Timestream with retry logic
 */
async function writeRecordsToTimestream(records) {
  if (!records || records.length === 0) {
    return { success: 0, failure: 0 };
  }
  
  try {
    const params = {
      DatabaseName: TIMESTREAM_DB,
      TableName: TIMESTREAM_TABLE,
      Records: records
    };
    
    const command = new WriteRecordsCommand(params);
    const response = await timestreamClient.send(command);
    
    // Check for rejected records
    if (response.RejectedRecords && response.RejectedRecords.length > 0) {
      console.warn(`${response.RejectedRecords.length} records were rejected`);
      
      return {
        success: records.length - response.RejectedRecords.length,
        failure: response.RejectedRecords.length
      };
    }
    
    return {
      success: records.length,
      failure: 0
    };
  } catch (error) {
    // Implement retry for throttling errors
    if (error.name === 'ThrottlingException') {
      console.log('API call was throttled. Waiting and retrying...');
      await new Promise(resolve => setTimeout(resolve, 1000));
      return writeRecordsToTimestream(records);
    }
    
    console.error('Error writing to Timestream:', error);
    return {
      success: 0,
      failure: records.length
    };
  }
}

/**
 * Process batches of records with controlled concurrency
 */
async function processBatches(batches) {
  let totalSuccess = 0;
  let totalFailure = 0;
  
  // Process batches with limited concurrency
  for (let i = 0; i < batches.length; i += MAX_CONCURRENT_BATCHES) {
    const currentBatches = batches.slice(i, Math.min(i + MAX_CONCURRENT_BATCHES, batches.length));
    
    const batchPromises = currentBatches.map(batch => writeRecordsToTimestream(batch));
    const results = await Promise.all(batchPromises);
    
    // Sum up the successes and failures
    results.forEach(result => {
      totalSuccess += result.success;
      totalFailure += result.failure;
    });
    
    // If not the last batch, add a small delay to avoid throttling
    if (i + MAX_CONCURRENT_BATCHES < batches.length) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  
  return { success: totalSuccess, failure: totalFailure };
}

/**
 * Main Lambda handler function
 */
exports.handler = async (event, context) => {
  try {
    // Get yesterday's date (or last trading day)
    const date = getYesterdayDate();
    console.log(`Fetching stock data for date: ${date}`);
    
    // Get list of tickers to fetch
    const tickers = await fetchTickers();
    
    // For large numbers of tickers, we may need to process in chunks to avoid Lambda timeout
    const TICKER_CHUNK_SIZE = 100; // Process 100 tickers at a time
    let successCount = 0;
    let failureCount = 0;
    
    for (let i = 0; i < tickers.length; i += TICKER_CHUNK_SIZE) {
      const tickerChunk = tickers.slice(i, i + TICKER_CHUNK_SIZE);
      console.log(`Processing tickers ${i + 1} to ${i + tickerChunk.length} of ${tickers.length}`);
      
      // Fetch data for each ticker in parallel
      const stockDataPromises = tickerChunk.map(ticker => fetchStockData(date, ticker));
      const stockDataResults = await Promise.all(stockDataPromises);
      
      // Convert to Timestream records
      let allRecords = [];
      stockDataResults.forEach(stockData => {
        if (stockData) {
          const records = convertToTimestreamRecords(stockData);
          allRecords = allRecords.concat(records);
        }
      });
      
      // Split records into batches of BATCH_SIZE
      const batches = [];
      for (let j = 0; j < allRecords.length; j += BATCH_SIZE) {
        batches.push(allRecords.slice(j, j + BATCH_SIZE));
      }
      
      // Write batches to Timestream
      if (batches.length > 0) {
        console.log(`Writing ${allRecords.length} records to Timestream in ${batches.length} batches`);
        const result = await processBatches(batches);
        successCount += result.success;
        failureCount += result.failure;
      }
    }
    
    console.log(`Process complete. Successfully written ${successCount} records. Failed: ${failureCount}`);
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Daily stock data update completed',
        date: date,
        success: successCount,
        failure: failureCount
      })
    };
  } catch (error) {
    console.error('Error in Lambda handler:', error);
    
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Error updating stock data',
        error: error.message
      })
    };
  }
};

// For local testing
if (require.main === module) {
  // Set API key for local testing (don't commit your real key!)
  process.env.POLYGON_API_KEY = 'YOUR_POLYGON_API_KEY';
  
  exports.handler({}, {})
    .then(result => console.log('Result:', result))
    .catch(error => console.error('Error:', error));
} 