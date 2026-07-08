/**
 * Script to update daily price data for multiple symbols
 * This can be run as a Lambda function or locally
 */

const axios = require('axios');
const { TimestreamWriteClient, WriteRecordsCommand } = require('@aws-sdk/client-timestream-write');

// Configure AWS SDK
const REGION = process.env.AWS_REGION || 'us-east-1';
const TIMESTREAM_DB = process.env.TIMESTREAM_DATABASE || 'oracle';
const TIMESTREAM_TABLE = process.env.TIMESTREAM_TABLE || 'stock_prices';

// Polygon API configuration
const POLYGON_API_KEY = process.env.POLYGON_API_KEY || 'GamH9ewSNWT6BeUM19cdtlCzyNCfVHWx';
const POLYGON_BASE_URL = 'https://api.polygon.io';

// Initialize Timestream client
const timestreamClient = new TimestreamWriteClient({ 
  region: REGION
});

// List of symbols to process
const DEFAULT_SYMBOLS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META'];

// Function to get the previous trading day
function getPreviousTradingDay() {
  const today = new Date();
  let previousDay = new Date(today);
  
  // Go back one day
  previousDay.setDate(previousDay.getDate() - 1);
  
  // If it's Sunday, go back to Friday
  if (previousDay.getDay() === 0) {
    previousDay.setDate(previousDay.getDate() - 2);
  }
  // If it's Monday, go back to Friday
  else if (previousDay.getDay() === 1) {
    previousDay.setDate(previousDay.getDate() - 3);
  }
  
  return previousDay.toISOString().split('T')[0];
}

// Function to fetch daily data for a symbol
async function fetchDailyData(symbol, date) {
  const url = `${POLYGON_BASE_URL}/v1/open-close/${symbol}/${date}?apiKey=${POLYGON_API_KEY}`;
  console.log(`Fetching daily data for ${symbol} on ${date}`);
  console.log(`URL: ${url}`);
  
  try {
    const response = await axios.get(url);
    return response.data;
  } catch (error) {
    console.error(`Error fetching data for ${symbol} on ${date}:`, error.message);
    return null;
  }
}

// Function to convert daily data to Timestream records
function convertToTimestreamRecords(symbol, data) {
  if (!data || data.status !== 'OK') {
    console.warn(`No valid data found for ${symbol}`);
    return [];
  }
  
  const timestamp = Date.now().toString();
  const originalTimestamp = new Date(data.from).getTime().toString();
  const date = data.from;
  
  const dimensions = [
    { Name: 'symbol', Value: symbol },
    { Name: 'asset_type', Value: 'stock' },
    { Name: 'original_timestamp', Value: originalTimestamp },
    { Name: 'date', Value: date }
  ];
  
  // Create records for each price metric
  const records = [
    {
      Dimensions: dimensions,
      MeasureName: 'open',
      MeasureValue: data.open.toString(),
      MeasureValueType: 'DOUBLE',
      Time: timestamp,
      TimeUnit: 'MILLISECONDS'
    },
    {
      Dimensions: dimensions,
      MeasureName: 'high',
      MeasureValue: data.high.toString(),
      MeasureValueType: 'DOUBLE',
      Time: timestamp,
      TimeUnit: 'MILLISECONDS'
    },
    {
      Dimensions: dimensions,
      MeasureName: 'low',
      MeasureValue: data.low.toString(),
      MeasureValueType: 'DOUBLE',
      Time: timestamp,
      TimeUnit: 'MILLISECONDS'
    },
    {
      Dimensions: dimensions,
      MeasureName: 'close',
      MeasureValue: data.close.toString(),
      MeasureValueType: 'DOUBLE',
      Time: timestamp,
      TimeUnit: 'MILLISECONDS'
    },
    {
      Dimensions: dimensions,
      MeasureName: 'volume',
      MeasureValue: data.volume.toString(),
      MeasureValueType: 'DOUBLE',
      Time: timestamp,
      TimeUnit: 'MILLISECONDS'
    }
  ];
  
  return records;
}

// Function to write records to Timestream
async function writeToTimestream(records) {
  if (records.length === 0) {
    return 0;
  }
  
  const params = {
    DatabaseName: TIMESTREAM_DB,
    TableName: TIMESTREAM_TABLE,
    Records: records
  };
  
  try {
    console.log(`Writing ${records.length} records to Timestream`);
    const command = new WriteRecordsCommand(params);
    const result = await timestreamClient.send(command);
    console.log(`Successfully wrote ${records.length} records to Timestream`);
    return records.length;
  } catch (error) {
    console.error('Error writing to Timestream:', error);
    throw error;
  }
}

// Function to process a single symbol
async function processSymbol(symbol, date) {
  try {
    // Fetch data from Polygon
    const data = await fetchDailyData(symbol, date);
    
    if (!data) {
      console.log(`No data available for ${symbol} on ${date}`);
      return 0;
    }
    
    // Convert to Timestream records
    const records = convertToTimestreamRecords(symbol, data);
    
    if (records.length === 0) {
      console.log(`No records to write for ${symbol}`);
      return 0;
    }
    
    // Write to Timestream
    const written = await writeToTimestream(records);
    console.log(`Successfully processed ${written} records for ${symbol}`);
    return written;
  } catch (error) {
    console.error(`Error processing ${symbol}:`, error);
    return 0;
  }
}

// Main function to process all symbols
async function processSymbols(symbols, date) {
  const results = {
    date,
    symbols: [],
    totalRecords: 0,
    successCount: 0,
    errorCount: 0
  };
  
  for (const symbol of symbols) {
    try {
      const recordCount = await processSymbol(symbol, date);
      
      results.symbols.push({
        symbol,
        success: recordCount > 0,
        recordCount
      });
      
      results.totalRecords += recordCount;
      
      if (recordCount > 0) {
        results.successCount++;
      } else {
        results.errorCount++;
      }
      
      // Add a delay between symbols to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
      console.error(`Error processing ${symbol}:`, error);
      
      results.symbols.push({
        symbol,
        success: false,
        error: error.message
      });
      
      results.errorCount++;
      
      // Still add a delay before the next symbol
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  return results;
}

// Lambda handler
exports.handler = async (event, context) => {
  console.log('Event:', JSON.stringify(event));
  
  try {
    // Get the date to process (either from the event or the previous trading day)
    const date = event.date || getPreviousTradingDay();
    
    // Get the symbols to process (either from the event or the default list)
    const symbols = event.symbols || DEFAULT_SYMBOLS;
    
    console.log(`Processing ${symbols.length} symbols for date ${date}`);
    
    // Process all symbols
    const results = await processSymbols(symbols, date);
    
    console.log('Processing completed:', JSON.stringify(results, null, 2));
    
    return {
      statusCode: 200,
      body: JSON.stringify(results)
    };
  } catch (error) {
    console.error('Lambda execution error:', error);
    
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Lambda execution error',
        error: error.message
      })
    };
  }
};

// If running locally, execute the handler
if (require.main === module) {
  const date = process.argv[2] || getPreviousTradingDay();
  const symbols = process.argv.slice(3).length > 0 ? process.argv.slice(3) : DEFAULT_SYMBOLS;
  
  console.log(`Running locally for date ${date} with symbols: ${symbols.join(', ')}`);
  
  exports.handler({ date, symbols })
    .then(result => {
      console.log('Execution completed:', JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch(error => {
      console.error('Execution failed:', error);
      process.exit(1);
    });
} 