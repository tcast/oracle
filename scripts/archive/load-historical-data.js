/**
 * Script to load historical stock data for multiple symbols
 * Uses the polygon-historical-loader Lambda function
 */

const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

// Configure AWS SDK
const REGION = 'us-east-1';
const LAMBDA_FUNCTION = 'polygon-historical-loader';

// Initialize Lambda client
const lambdaClient = new LambdaClient({ region: REGION });

// List of symbols to process
const symbols = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META'];

// Date range to process
const startDate = '2023-01-01';
const endDate = '2025-03-12';

// Function to invoke the Lambda function for a symbol
async function processSymbol(symbol) {
  const params = {
    FunctionName: LAMBDA_FUNCTION,
    Payload: JSON.stringify({
      symbol,
      startDate,
      endDate
    })
  };
  
  try {
    console.log(`Invoking Lambda for ${symbol} from ${startDate} to ${endDate}`);
    const command = new InvokeCommand(params);
    const response = await lambdaClient.send(command);
    
    // Parse the response
    const payload = JSON.parse(Buffer.from(response.Payload).toString());
    console.log(`Lambda response for ${symbol}:`, payload);
    
    return {
      symbol,
      success: response.StatusCode === 200,
      payload
    };
  } catch (error) {
    console.error(`Error invoking Lambda for ${symbol}:`, error);
    return {
      symbol,
      success: false,
      error: error.message
    };
  }
}

// Process symbols sequentially
async function processSymbols() {
  const results = [];
  
  for (const symbol of symbols) {
    try {
      const result = await processSymbol(symbol);
      results.push(result);
      
      // Add a delay between invocations to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      console.error(`Error processing ${symbol}:`, error);
      results.push({
        symbol,
        success: false,
        error: error.message
      });
    }
  }
  
  return results;
}

// Run the script
processSymbols()
  .then(results => {
    console.log('Processing completed. Results:');
    console.log(JSON.stringify(results, null, 2));
    
    const successful = results.filter(r => r.success).length;
    const failed = results.length - successful;
    
    console.log(`Successfully processed ${successful} symbols, ${failed} failed.`);
    process.exit(0);
  })
  .catch(error => {
    console.error('Script execution failed:', error);
    process.exit(1);
  }); 