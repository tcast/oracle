const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');

// Configure AWS SDK with the region
AWS.config.update({ region: 'us-east-1' });

// Initialize AWS Lambda client
const lambda = new AWS.Lambda();

// Function to update the Lambda code
async function updateLambdaCode() {
  try {
    console.log('Creating the updated Lambda function code');
    
    // Read the original Lambda function code
    const originalCodePath = path.join(__dirname, 'lambda', 'updateDailyOHLC.js');
    let code = fs.readFileSync(originalCodePath, 'utf8');
    
    // Add rate limiting to the Polygon API requests
    code = code.replace(
      'const updateSymbolOHLC = async (symbol) => {',
      `// Helper function to implement exponential backoff for API rate limits
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Add retry mechanism for API calls
const retryApiCall = async (apiCall, maxRetries = 3, initialDelay = 1000) => {
  let delay = initialDelay;
  let retries = 0;
  
  while (retries < maxRetries) {
    try {
      return await apiCall();
    } catch (error) {
      if (error.response && error.response.status === 429) {
        // Rate limit hit, exponential backoff
        retries++;
        console.log(\`Rate limit hit, retrying after \${delay}ms (retry \${retries}/\${maxRetries})\`);
        await sleep(delay);
        delay *= 2; // Exponential backoff
      } else {
        // Other error, just throw it
        throw error;
      }
    }
  }
  
  throw new Error(\`Failed after \${maxRetries} retries\`);
};

const updateSymbolOHLC = async (symbol) => {`
    );
    
    // Update the Polygon API call with retry mechanism
    code = code.replace(
      'const response = await axios.get(url);',
      'const response = await retryApiCall(() => axios.get(url));'
    );
    
    // Update Alpha Vantage call to add some basic handling
    code = code.replace(
      'const response = await axios.get(url);',
      'const response = await axios.get(url, { timeout: 10000 });'
    );
    
    // Make sure we only process a limited number of symbols per run to avoid hitting limits
    code = code.replace(
      'const symbols = symbolsResult.rows.map(row => row.symbol);',
      `// Get symbols and limit the batch size if necessary
let symbols = symbolsResult.rows.map(row => row.symbol);

// Check if we have a specific limit in the event
if (event && event.limit && typeof event.limit === 'number') {
  console.log(\`Limiting batch to \${event.limit} symbols as requested\`);
  symbols = symbols.slice(0, event.limit);
}

// Add overall timeout for the lambda to avoid running too long
const startTime = Date.now();
const MAX_EXECUTION_TIME = 800000; // 800 seconds (just under the 900s Lambda limit)
`
    );
    
    // Add time check to the symbol processing loop
    code = code.replace(
      'processed += batch.length;',
      `processed += batch.length;
      
      // Check if we're approaching the Lambda timeout
      const currentTime = Date.now();
      const elapsedTime = currentTime - startTime;
      if (elapsedTime > MAX_EXECUTION_TIME) {
        console.log(\`Approaching Lambda timeout limit. Processed \${processed}/\${symbols.length} symbols before stopping.\`);
        break;
      }`
    );
    
    // Don't use the API keys if they're empty
    code = code.replace(
      'if (apiKeys.polygon) {',
      'if (apiKeys.polygon && apiKeys.polygon.trim() !== "") {'
    );
    
    code = code.replace(
      'if (apiKeys.finnhub) {',
      'if (apiKeys.finnhub && apiKeys.finnhub.trim() !== "") {'
    );
    
    code = code.replace(
      'if (apiKeys.alphaVantage) {',
      'if (apiKeys.alphaVantage && apiKeys.alphaVantage.trim() !== "") {'
    );
    
    // Write the updated code to a new file
    const updatedCodePath = path.join(__dirname, 'lambda', 'updateDailyOHLC-fixed.js');
    fs.writeFileSync(updatedCodePath, code);
    
    console.log('Creating zip file for Lambda deployment');
    const zipFile = path.join(__dirname, 'updateDailyOHLC-fixed.zip');
    
    // Create the zip file using the archive command
    const { execSync } = require('child_process');
    execSync(`zip -j ${zipFile} ${updatedCodePath}`);
    
    console.log('Updating Lambda function code');
    
    // Read the zip file
    const zipContents = fs.readFileSync(zipFile);
    
    // Update the Lambda function
    const params = {
      FunctionName: 'updateDailyOHLC',
      ZipFile: zipContents
    };
    
    const response = await lambda.updateFunctionCode(params).promise();
    console.log('Lambda function code updated successfully');
    console.log(response);
    
    // Clean up the temporary files
    fs.unlinkSync(updatedCodePath);
    fs.unlinkSync(zipFile);
    
    return response;
  } catch (error) {
    console.error('Error updating Lambda function code:', error);
    throw error;
  }
}

// Main function
async function main() {
  try {
    await updateLambdaCode();
    console.log('Successfully updated the updateDailyOHLC Lambda function with improved rate limiting');
  } catch (error) {
    console.error('Failed to update Lambda function:', error);
  }
}

// Run the main function
main().catch(error => {
  console.error('Error in main function:', error);
  process.exit(1);
});