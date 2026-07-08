const { TimestreamWriteClient } = require('@aws-sdk/client-timestream-write');
const { TimestreamQueryClient, QueryCommand } = require('@aws-sdk/client-timestream-query');

// Configure AWS SDK
const REGION = 'us-east-1';
const TIMESTREAM_DB = 'oracle';
const TIMESTREAM_TABLE = 'stock_prices';

// Initialize Timestream clients
const writeClient = new TimestreamWriteClient({ region: REGION });
const queryClient = new TimestreamQueryClient({ region: REGION });

async function clearData() {
  console.log(`Deleting all data from ${TIMESTREAM_DB}.${TIMESTREAM_TABLE}...`);
  
  // In Timestream, we delete by writing records to the deletion table
  const params = {
    QueryString: `DELETE FROM "${TIMESTREAM_DB}"."${TIMESTREAM_TABLE}" WHERE time BETWEEN ago(20y) AND now()`
  };
  
  try {
    console.log('Executing query:', params.QueryString);
    const command = new QueryCommand(params);
    const result = await queryClient.send(command);
    console.log('Delete query executed. This query runs asynchronously and may take some time to complete.');
    
    console.log('Please query the table in a few minutes to confirm all data has been deleted.');
    return true;
  } catch (error) {
    console.error('Error clearing Timestream data:', error);
    return false;
  }
}

// Run the deletion
clearData()
  .then(success => {
    console.log('Clear operation initiated with success:', success);
    process.exit(success ? 0 : 1);
  })
  .catch(err => {
    console.error('Script execution failed:', err);
    process.exit(1);
  }); 