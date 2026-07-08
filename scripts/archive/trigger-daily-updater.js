const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

// Initialize the Lambda client
const lambdaClient = new LambdaClient({ region: 'us-east-1' });

// Function to get yesterday's date in YYYY-MM-DD format
function getYesterdayDate() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return date.toISOString().split('T')[0];
}

// Function to invoke the Lambda function
async function invokeDailyUpdater() {
  const symbols = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META'];
  const date = process.argv[2] || getYesterdayDate();
  
  console.log(`Invoking polygon-daily-updater for date: ${date} and symbols: ${symbols.join(', ')}`);
  
  const params = {
    FunctionName: 'polygon-daily-updater',
    Payload: JSON.stringify({
      date: date,
      symbols: symbols
    }),
  };

  try {
    const command = new InvokeCommand(params);
    const response = await lambdaClient.send(command);
    
    // Convert the Uint8Array to a string
    const responsePayload = Buffer.from(response.Payload).toString();
    console.log('Lambda function response:', responsePayload);
    
    return responsePayload;
  } catch (error) {
    console.error('Error invoking Lambda function:', error);
    throw error;
  }
}

// Execute the function
invokeDailyUpdater()
  .then(result => console.log('Execution completed successfully'))
  .catch(error => console.error('Execution failed:', error)); 