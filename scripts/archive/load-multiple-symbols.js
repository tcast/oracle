/**
 * Script to load historical stock data for multiple symbols
 * Uses the local script to load data directly to Timestream
 */

const { spawn } = require('child_process');
const fs = require('fs');

// List of symbols to process
const symbols = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META'];

// Date range to process
const startDate = '2023-01-01';
const endDate = '2025-03-12';

// Function to process a single symbol
async function processSymbol(symbol) {
  return new Promise((resolve, reject) => {
    console.log(`Processing ${symbol} from ${startDate} to ${endDate}`);
    
    // Create a temporary script file for this symbol
    const scriptContent = `
const axios = require('axios');
const { TimestreamWriteClient, WriteRecordsCommand } = require('@aws-sdk/client-timestream-write');

// Configure AWS SDK
const REGION = 'us-east-1';
const TIMESTREAM_DB = 'oracle';
const TIMESTREAM_TABLE = 'stock_prices';
const timestreamClient = new TimestreamWriteClient({ region: REGION });

// Polygon API configuration
const POLYGON_API_KEY = 'GamH9ewSNWT6BeUM19cdtlCzyNCfVHWx';
const POLYGON_BASE_URL = 'https://api.polygon.io';

// Function to fetch historical data for a symbol and date range
async function fetchHistoricalData(symbol, from, to) {
  const url = \`\${POLYGON_BASE_URL}/v2/aggs/ticker/\${symbol}/range/1/day/\${from}/\${to}?apiKey=\${POLYGON_API_KEY}\`;
  console.log(\`Fetching data for \${symbol} from \${from} to \${to}\`);
  console.log(\`URL: \${url}\`);
  
  try {
    const response = await axios.get(url);
    return response.data;
  } catch (error) {
    console.error(\`Error fetching data for \${symbol}:\`, error.message);
    throw error;
  }
}

// Function to convert Polygon data to Timestream records, using current timestamps
function convertToTimestreamRecords(symbol, data) {
  if (!data || !data.results || !Array.isArray(data.results)) {
    console.warn(\`No results found for \${symbol}\`);
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
      console.log(\`Writing \${chunk.length} records to Timestream\`);
      const command = new WriteRecordsCommand(params);
      const result = await timestreamClient.send(command);
      successCount += chunk.length;
      console.log(\`Successfully wrote \${chunk.length} records to Timestream\`);
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
    
    // Convert to Timestream records using current timestamps
    const records = convertToTimestreamRecords(symbol, data);
    
    console.log(\`Converted \${records.length} records for \${symbol}\`);
    
    if (records.length === 0) {
      console.log(\`No records to write for \${symbol}\`);
      return 0;
    }
    
    // Write to Timestream
    const written = await writeToTimestream(records);
    console.log(\`Successfully processed \${written} records for \${symbol}\`);
    return written;
  } catch (error) {
    console.error(\`Error processing \${symbol}:\`, error);
    return 0;
  }
}

// Run the script with the specified symbol
const symbol = '${symbol}';
const startDate = '${startDate}';
const endDate = '${endDate}';

console.log(\`Processing \${symbol} from \${startDate} to \${endDate}\`);

processSymbol(symbol, startDate, endDate)
  .then(count => {
    console.log(\`Total records processed: \${count}\`);
    process.exit(0);
  })
  .catch(error => {
    console.error('Script execution failed:', error);
    process.exit(1);
  });
`;
    
    const scriptFile = `process-${symbol}.js`;
    fs.writeFileSync(scriptFile, scriptContent);
    
    // Run the script
    const process = spawn('node', [scriptFile]);
    
    let output = '';
    let errorOutput = '';
    
    process.stdout.on('data', (data) => {
      const chunk = data.toString();
      output += chunk;
      console.log(`[${symbol}] ${chunk}`);
    });
    
    process.stderr.on('data', (data) => {
      const chunk = data.toString();
      errorOutput += chunk;
      console.error(`[${symbol}] ERROR: ${chunk}`);
    });
    
    process.on('close', (code) => {
      // Clean up the temporary script file
      fs.unlinkSync(scriptFile);
      
      if (code === 0) {
        console.log(`[${symbol}] Process completed successfully`);
        resolve({
          symbol,
          success: true,
          output
        });
      } else {
        console.error(`[${symbol}] Process failed with code ${code}`);
        reject({
          symbol,
          success: false,
          error: errorOutput,
          code
        });
      }
    });
  });
}

// Process symbols sequentially
async function processSymbols() {
  const results = [];
  
  for (const symbol of symbols) {
    try {
      const result = await processSymbol(symbol);
      results.push(result);
      
      // Add a delay between symbols to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`Error processing ${symbol}:`, error);
      results.push({
        symbol,
        success: false,
        error: error.message || JSON.stringify(error)
      });
      
      // Still add a delay before the next symbol
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  return results;
}

// Run the script
processSymbols()
  .then(results => {
    console.log('Processing completed. Results:');
    
    const successful = results.filter(r => r.success).length;
    const failed = results.length - successful;
    
    console.log(`Successfully processed ${successful} symbols, ${failed} failed.`);
    process.exit(0);
  })
  .catch(error => {
    console.error('Script execution failed:', error);
    process.exit(1);
  }); 