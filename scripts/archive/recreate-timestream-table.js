const { TimestreamWriteClient, DeleteTableCommand, CreateTableCommand, DescribeTableCommand } = require('@aws-sdk/client-timestream-write');

// Configuration
const REGION = 'us-east-1';
const TIMESTREAM_DB = 'oracle';
const TIMESTREAM_TABLE = 'stock_prices';
const DELETE_RETRY_COUNT = 3;
const CREATE_RETRY_COUNT = 3;

// Initialize Timestream client
const timestream = new TimestreamWriteClient({ region: REGION });

// Function to delete the existing table
async function deleteTimestreamTable() {
  console.log(`Deleting existing Timestream table: ${TIMESTREAM_DB}.${TIMESTREAM_TABLE}`);
  
  let retries = 0;
  
  while (retries < DELETE_RETRY_COUNT) {
    try {
      // First check if table exists
      try {
        const describeParams = {
          DatabaseName: TIMESTREAM_DB,
          TableName: TIMESTREAM_TABLE
        };
        
        const describeCommand = new DescribeTableCommand(describeParams);
        await timestream.send(describeCommand);
        console.log('Table exists, proceeding with deletion');
      } catch (error) {
        if (error.name === 'ResourceNotFoundException') {
          console.log('Table does not exist, nothing to delete');
          return true;
        }
        // For other errors, continue with deletion attempt
      }
      
      // Attempt to delete
      const deleteParams = {
        DatabaseName: TIMESTREAM_DB,
        TableName: TIMESTREAM_TABLE
      };
      
      const command = new DeleteTableCommand(deleteParams);
      await timestream.send(command);
      console.log('Table deletion initiated successfully');
      
      // Wait for table deletion to complete
      console.log('Waiting 30 seconds for deletion to propagate...');
      await new Promise(resolve => setTimeout(resolve, 30000));
      
      console.log('Checking if table was actually deleted...');
      try {
        const checkCommand = new DescribeTableCommand({
          DatabaseName: TIMESTREAM_DB,
          TableName: TIMESTREAM_TABLE
        });
        
        await timestream.send(checkCommand);
        console.log('Table still exists, deletion not yet complete. Waiting longer...');
        await new Promise(resolve => setTimeout(resolve, 15000));
        
        // Check one more time
        try {
          await timestream.send(checkCommand);
          console.log('Table still exists after additional wait. Deletion may be processing or failed.');
          retries++;
        } catch (error) {
          if (error.name === 'ResourceNotFoundException') {
            console.log('Table successfully deleted after additional wait');
            return true;
          }
        }
      } catch (error) {
        if (error.name === 'ResourceNotFoundException') {
          console.log('Table successfully deleted');
          return true;
        }
      }
    } catch (error) {
      console.error(`Error deleting table (attempt ${retries + 1}):`, error);
      retries++;
      if (retries < DELETE_RETRY_COUNT) {
        console.log(`Retrying deletion in 10 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }
  }
  
  console.error(`Failed to delete table after ${DELETE_RETRY_COUNT} attempts`);
  return false;
}

// Function to create a new table with specified schema
async function createTimestreamTable() {
  console.log(`Creating new Timestream table: ${TIMESTREAM_DB}.${TIMESTREAM_TABLE}`);
  
  let retries = 0;
  
  while (retries < CREATE_RETRY_COUNT) {
    try {
      const createParams = {
        DatabaseName: TIMESTREAM_DB,
        TableName: TIMESTREAM_TABLE,
        RetentionProperties: {
          MemoryStoreRetentionPeriodInHours: 24,
          MagneticStoreRetentionPeriodInDays: 365 * 10 // 10 years retention
        }
      };
      
      const command = new CreateTableCommand(createParams);
      await timestream.send(command);
      console.log('Table creation initiated successfully');
      
      // Wait for table creation to complete
      console.log('Waiting 20 seconds for table creation to propagate...');
      await new Promise(resolve => setTimeout(resolve, 20000));
      
      // Verify table creation
      try {
        const checkCommand = new DescribeTableCommand({
          DatabaseName: TIMESTREAM_DB,
          TableName: TIMESTREAM_TABLE
        });
        
        const response = await timestream.send(checkCommand);
        console.log('Table created successfully');
        console.log('Table details:', JSON.stringify(response, null, 2));
        return true;
      } catch (error) {
        console.error('Error verifying table creation:', error);
        retries++;
      }
    } catch (error) {
      console.error(`Error creating table (attempt ${retries + 1}):`, error);
      retries++;
      if (retries < CREATE_RETRY_COUNT) {
        console.log(`Retrying creation in 10 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }
  }
  
  console.error(`Failed to create table after ${CREATE_RETRY_COUNT} attempts`);
  return false;
}

// Main function to orchestrate the process
async function recreateTimestreamTable() {
  console.log('Starting Timestream table recreation process');
  
  // Delete existing table
  const tableDeleted = await deleteTimestreamTable();
  if (!tableDeleted) {
    console.error('Failed to delete the table. Aborting recreation process.');
    return { success: false, error: 'Failed to delete table' };
  }
  
  // Create new table
  const tableCreated = await createTimestreamTable();
  if (!tableCreated) {
    console.error('Failed to create the table. Recreation process incomplete.');
    return { success: false, error: 'Failed to create table' };
  }
  
  console.log('\nTimestream table recreation completed successfully!');
  console.log(`Table ${TIMESTREAM_DB}.${TIMESTREAM_TABLE} has been recreated with fresh schema`);
  console.log('\nNext steps:');
  console.log('1. Use the parallel-timestream-importer.js script to load data directly');
  console.log('   - Command: node parallel-timestream-importer.js');
  console.log('2. Or use the load-into-s3-then-timestream.js script for S3 staging');
  console.log('   - Command: node load-into-s3-then-timestream.js');
  
  return { success: true };
}

// Run the main function
recreateTimestreamTable()
  .then(result => {
    if (result.success) {
      console.log('Table recreation process completed successfully');
      process.exit(0);
    } else {
      console.error('Table recreation process failed:', result.error);
      process.exit(1);
    }
  })
  .catch(error => {
    console.error('Unexpected error during table recreation:', error);
    process.exit(1);
  });