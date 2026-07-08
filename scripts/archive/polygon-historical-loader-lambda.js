/**
 * Lambda function to fetch historical stock data from Polygon API 
 * and load it directly into Amazon Timestream
 */

const axios = require('axios');
const { TimestreamWriteClient, WriteRecordsCommand } = require('@aws-sdk/client-timestream-write');
const { Pool } = require('pg');

// Configure AWS SDK
const REGION = process.env.AWS_REGION || 'us-east-1';
const TIMESTREAM_DB = process.env.TIMESTREAM_DATABASE || 'oracle';
const TIMESTREAM_TABLE = process.env.TIMESTREAM_TABLE || 'stock_prices';

// Polygon API configuration
const POLYGON_API_KEY = process.env.POLYGON_API_KEY;
const POLYGON_BASE_URL = 'https://api.polygon.io';

// Initialize Timestream client
const timestreamClient = new TimestreamWriteClient({ 
  region: REGION
});

// Initialize PostgreSQL pool for getting stock symbols
const initializePool = () => {
  return new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT || 5432,
    ssl: process.env.DB_REQUIRE_SSL === 'true' ? {
      rejectUnauthorized: false
    } : false
  });
};

// Function to fetch a single test record and write to Timestream
async function writeTestRecord() {
  const currentTime = Date.now().toString();
  
  // Create test records for each price metric
  const records = [
    {
      Dimensions: [
        { Name: 'symbol', Value: 'TEST' },
        { Name: 'asset_type', Value: 'test' }
      ],
      MeasureName: 'open',
      MeasureValue: '100.0',
      MeasureValueType: 'DOUBLE',
      Time: currentTime,
      TimeUnit: 'MILLISECONDS'
    },
    {
      Dimensions: [
        { Name: 'symbol', Value: 'TEST' },
        { Name: 'asset_type', Value: 'test' }
      ],
      MeasureName: 'high',
      MeasureValue: '105.0',
      MeasureValueType: 'DOUBLE',
      Time: currentTime,
      TimeUnit: 'MILLISECONDS'
    },
    {
      Dimensions: [
        { Name: 'symbol', Value: 'TEST' },
        { Name: 'asset_type', Value: 'test' }
      ],
      MeasureName: 'low',
      MeasureValue: '95.0',
      MeasureValueType: 'DOUBLE',
      Time: currentTime,
      TimeUnit: 'MILLISECONDS'
    },
    {
      Dimensions: [
        { Name: 'symbol', Value: 'TEST' },
        { Name: 'asset_type', Value: 'test' }
      ],
      MeasureName: 'close',
      MeasureValue: '102.0',
      MeasureValueType: 'DOUBLE',
      Time: currentTime,
      TimeUnit: 'MILLISECONDS'
    },
    {
      Dimensions: [
        { Name: 'symbol', Value: 'TEST' },
        { Name: 'asset_type', Value: 'test' }
      ],
      MeasureName: 'volume',
      MeasureValue: '1000.0',
      MeasureValueType: 'DOUBLE',
      Time: currentTime,
      TimeUnit: 'MILLISECONDS'
    }
  ];
  
  // Write the test records to Timestream
  const params = {
    DatabaseName: TIMESTREAM_DB,
    TableName: TIMESTREAM_TABLE,
    Records: records
  };
  
  console.log('Writing test records to Timestream', JSON.stringify(params, null, 2));
  
  try {
    const command = new WriteRecordsCommand(params);
    const result = await timestreamClient.send(command);
    console.log('Successfully wrote test records to Timestream', result);
    return {
      success: true,
      message: 'Successfully wrote test records to Timestream'
    };
  } catch (error) {
    console.error('Error writing to Timestream:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Function to fetch historical data for a symbol and date range
async function fetchHistoricalData(symbol, from, to) {
  const url = `${POLYGON_BASE_URL}/v2/aggs/ticker/${symbol}/range/1/day/${from}/${to}?apiKey=${POLYGON_API_KEY}`;
  console.log(`Fetching data for ${symbol} from ${from} to ${to}`);
  
  try {
    const response = await axios.get(url);
    return response.data;
  } catch (error) {
    console.error(`Error fetching data for ${symbol}:`, error.message);
    throw error;
  }
}

// Function to convert Polygon data to Timestream records, using current timestamps
function convertToTimestreamRecords(symbol, data) {
  if (!data || !data.results || !Array.isArray(data.results)) {
    console.warn(`No results found for ${symbol}`);
    return [];
  }
  
  const records = [];
  const currentTime = Date.now();
  let counter = 0;
  
  data.results.forEach(bar => {
    // Use current timestamp with a small offset for each record to ensure they're in the memory store
    const timestamp = (currentTime - (data.results.length - counter) * 1000).toString();
    counter++;
    
    const dimensions = [
      { Name: 'symbol', Value: symbol },
      { Name: 'asset_type', Value: 'stock' },
      { Name: 'original_timestamp', Value: bar.t.toString() }, // Store original timestamp as a dimension
      { Name: 'date', Value: new Date(bar.t).toISOString().split('T')[0] } // Add date dimension
    ];
    
    // Create individual records for each price metric
    records.push({
      Dimensions: dimensions,
      MeasureName: 'open',
      MeasureValue: bar.o.toString(),
      MeasureValueType: 'DOUBLE',
      Time: timestamp,
      TimeUnit: 'MILLISECONDS'
    });
    
    records.push({
      Dimensions: dimensions,
      MeasureName: 'high',
      MeasureValue: bar.h.toString(),
      MeasureValueType: 'DOUBLE',
      Time: timestamp,
      TimeUnit: 'MILLISECONDS'
    });
    
    records.push({
      Dimensions: dimensions,
      MeasureName: 'low',
      MeasureValue: bar.l.toString(),
      MeasureValueType: 'DOUBLE',
      Time: timestamp,
      TimeUnit: 'MILLISECONDS'
    });
    
    records.push({
      Dimensions: dimensions,
      MeasureName: 'close',
      MeasureValue: bar.c.toString(),
      MeasureValueType: 'DOUBLE',
      Time: timestamp,
      TimeUnit: 'MILLISECONDS'
    });
    
    records.push({
      Dimensions: dimensions,
      MeasureName: 'volume',
      MeasureValue: bar.v.toString(),
      MeasureValueType: 'DOUBLE',
      Time: timestamp,
      TimeUnit: 'MILLISECONDS'
    });
  });
  
  return records;
}

// Function to write records to Timestream
async function writeToTimestream(records) {
  // Split records into chunks of 100 (Timestream limit)
  const chunkSize = 100;
  const chunks = [];
  
  for (let i = 0; i < records.length; i += chunkSize) {
    chunks.push(records.slice(i, i + chunkSize));
  }
  
  let successCount = 0;
  
  for (const chunk of chunks) {
    const params = {
      DatabaseName: TIMESTREAM_DB,
      TableName: TIMESTREAM_TABLE,
      Records: chunk
    };
    
    try {
      console.log(`Writing ${chunk.length} records to Timestream`);
      const command = new WriteRecordsCommand(params);
      const result = await timestreamClient.send(command);
      successCount += chunk.length;
      console.log(`Successfully wrote ${chunk.length} records to Timestream`);
    } catch (error) {
      console.error('Error writing to Timestream:', error);
      throw error;
    }
    
    // Add a small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  
  return successCount;
}

// Function to process a single symbol
async function processSymbol(symbol, startDate, endDate) {
  try {
    // Fetch data from Polygon
    const data = await fetchHistoricalData(symbol, startDate, endDate);
    
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
    throw error;
  }
}

// Main Lambda handler
exports.handler = async (event, context) => {
  console.log('Event:', JSON.stringify(event));
  
  try {
    // Write a test record to verify Timestream connectivity
    const testResult = await writeTestRecord();
    
    if (!testResult.success) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          message: 'Failed to write test record to Timestream',
          error: testResult.error
        })
      };
    }
    
    console.log('Timestream connectivity test successful');
    
    // If just testing, return success
    if (event.action === 'test') {
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: 'Timestream test successful'
        })
      };
    }
    
    // Process a real symbol if provided
    if (event.symbol && event.startDate && event.endDate) {
      const { symbol, startDate, endDate } = event;
      console.log(`Processing symbol ${symbol} from ${startDate} to ${endDate}`);
      
      const recordCount = await processSymbol(symbol, startDate, endDate);
      
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: `Successfully processed ${recordCount} records for ${symbol}`,
          symbol,
          recordCount
        })
      };
    }
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Test record written successfully. To process data, provide symbol, startDate, and endDate in the event payload.',
        action: event.action || 'default'
      })
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