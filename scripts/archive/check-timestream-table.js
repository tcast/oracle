const { TimestreamQueryClient, QueryCommand } = require('@aws-sdk/client-timestream-query');

// Configuration
const REGION = 'us-east-1';
const TIMESTREAM_DB = 'oracle';
const TIMESTREAM_TABLE = 'stock_prices';

// Initialize client
const queryClient = new TimestreamQueryClient({ region: REGION });

async function describeTable() {
    try {
        console.log(`Describing table: ${TIMESTREAM_DB}.${TIMESTREAM_TABLE}`);
        
        const params = {
            QueryString: `DESCRIBE "${TIMESTREAM_DB}"."${TIMESTREAM_TABLE}"`
        };
        
        console.log('Executing query:', params.QueryString);
        const command = new QueryCommand(params);
        const response = await queryClient.send(command);
        
        console.log('Got response:', JSON.stringify(response, null, 2));
        
        if (response.QueryStatus) {
            console.log(`Query Status: ${response.QueryStatus.ProgressPercentage}% complete`);
        }
        
        console.log('\nTable Structure:');
        console.log('-----------------');
        
        if (response.Rows && response.Rows.length > 0) {
            // Get column names from the column info
            const columnNames = response.ColumnInfo.map(col => col.Name);
            
            // Print each row with column names
            response.Rows.forEach(row => {
                const rowData = {};
                row.Data.forEach((data, index) => {
                    rowData[columnNames[index]] = data.ScalarValue || 'NULL';
                });
                console.log(rowData);
            });
        } else {
            console.log('No rows returned from the query.');
        }
        
    } catch (error) {
        console.error('Error describing table:', error);
        if (error.$metadata) {
            console.error('Error metadata:', error.$metadata);
        }
        console.error('Full error:', JSON.stringify(error, null, 2));
    }
}

async function showSampleData() {
    try {
        console.log(`\nRetrieving sample data from: ${TIMESTREAM_DB}.${TIMESTREAM_TABLE}`);
        
        const params = {
            QueryString: `SELECT * FROM "${TIMESTREAM_DB}"."${TIMESTREAM_TABLE}" LIMIT 10`
        };
        
        console.log('Executing query:', params.QueryString);
        const command = new QueryCommand(params);
        const response = await queryClient.send(command);
        
        if (response.QueryStatus) {
            console.log(`Query Status: ${response.QueryStatus.ProgressPercentage}% complete`);
        }
        
        console.log('\nSample Data:');
        console.log('------------');
        
        if (response.Rows && response.Rows.length > 0) {
            // Get column names from the column info
            const columnNames = response.ColumnInfo.map(col => col.Name);
            console.log('Columns:', columnNames.join(', '));
            
            // Print each row
            response.Rows.forEach(row => {
                const rowValues = row.Data.map(data => data.ScalarValue || 'NULL');
                console.log(rowValues.join(', '));
            });
        } else {
            console.log('No data available in the table.');
        }
        
    } catch (error) {
        console.error('Error retrieving sample data:', error);
        if (error.$metadata) {
            console.error('Error metadata:', error.$metadata);
        }
    }
}

// Check table schema details
async function checkTableSchema() {
    try {
        console.log('\nChecking information schema for table details');
        
        const params = {
            QueryString: `
                SELECT *
                FROM information_schema.columns
                WHERE table_schema = '${TIMESTREAM_DB}'
                AND table_name = '${TIMESTREAM_TABLE}'
            `
        };
        
        console.log('Executing query:', params.QueryString);
        const command = new QueryCommand(params);
        const response = await queryClient.send(command);
        
        console.log('\nTable Schema Details:');
        console.log('---------------------');
        
        if (response.Rows && response.Rows.length > 0) {
            // Get column names from the column info
            const columnNames = response.ColumnInfo.map(col => col.Name);
            
            // Print each row with column names
            response.Rows.forEach(row => {
                const rowData = {};
                row.Data.forEach((data, index) => {
                    rowData[columnNames[index]] = data.ScalarValue || 'NULL';
                });
                console.log(rowData);
            });
        } else {
            console.log('No schema information available.');
        }
        
    } catch (error) {
        console.error('Error checking table schema:', error);
        if (error.$metadata) {
            console.error('Error metadata:', error.$metadata);
        }
    }
}

// Run functions in sequence
async function main() {
    try {
        await describeTable();
        await checkTableSchema();
        await showSampleData();
        console.log('\nTable check complete.');
    } catch (error) {
        console.error('Error in main execution:', error);
    }
}

main().catch(console.error); 