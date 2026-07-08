const { TimestreamQueryClient, QueryCommand } = require('@aws-sdk/client-timestream-query');

// Configure AWS SDK
const REGION = 'us-east-1';
const TIMESTREAM_DB = 'oracle';
const TIMESTREAM_TABLE = 'stock_prices';

// Initialize Timestream query client
const queryClient = new TimestreamQueryClient({ region: REGION });

async function queryTimestream() {
  // Query to get older historical records (from 2023)
  const params = {
    QueryString: `SELECT symbol, date, measure_name, time, measure_value::double 
                 FROM ${TIMESTREAM_DB}.${TIMESTREAM_TABLE} 
                 WHERE date LIKE '2023%'
                 ORDER BY time ASC LIMIT 4`
  };
  
  try {
    console.log('Executing query:', params.QueryString);
    const command = new QueryCommand(params);
    const result = await queryClient.send(command);
    console.log('Query result:', JSON.stringify(result, null, 2));
    
    if (result.Rows && result.Rows.length > 0) {
      console.log('Historical Records:');
      result.Rows.forEach((row, index) => {
        const symbol = row.Data[0].ScalarValue;
        const date = row.Data[1].ScalarValue;
        const measure = row.Data[2].ScalarValue;
        const timestamp = row.Data[3].ScalarValue;
        const value = row.Data[4].ScalarValue;
        
        console.log(`Record ${index + 1}: Symbol=${symbol}, Date=${date}, Measure=${measure}, Timestamp=${timestamp}, Value=${value}`);
      });
    }
    
    return true;
  } catch (error) {
    console.error('Error querying Timestream:', error);
    return false;
  }
}

// Run the query
queryTimestream()
  .then(success => {
    console.log('Query completed with success:', success);
    process.exit(success ? 0 : 1);
  })
  .catch(err => {
    console.error('Script execution failed:', err);
    process.exit(1);
  }); 