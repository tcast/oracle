const { TimestreamQueryClient, QueryCommand } = require('@aws-sdk/client-timestream-query');

// Configuration
const REGION = 'us-east-1';
const TIMESTREAM_DB = 'oracle';
const TIMESTREAM_TABLE = 'stock_prices';

// Initialize client
const queryClient = new TimestreamQueryClient({ region: REGION });

// Count records in the table
async function countRecords() {
    try {
        console.log(`Counting records in ${TIMESTREAM_DB}.${TIMESTREAM_TABLE}...`);
        
        const params = {
            QueryString: `
                SELECT COUNT(*) AS record_count
                FROM "${TIMESTREAM_DB}"."${TIMESTREAM_TABLE}"
            `
        };
        
        console.log('Executing query:', params.QueryString);
        const command = new QueryCommand(params);
        const response = await queryClient.send(command);
        
        if (response.Rows && response.Rows.length > 0) {
            const count = response.Rows[0].Data[0].ScalarValue;
            console.log(`Total records: ${count}`);
        } else {
            console.log('No records found.');
        }
    } catch (error) {
        console.error('Error counting records:', error);
    }
}

// Sample data by date
async function sampleDataByDate(date) {
    try {
        console.log(`\nSampling data for date: ${date}`);
        
        const params = {
            QueryString: `
                SELECT ticker, date, measure_name, measure_value::double
                FROM "${TIMESTREAM_DB}"."${TIMESTREAM_TABLE}"
                WHERE date = '${date}'
                LIMIT 20
            `
        };
        
        console.log('Executing query:', params.QueryString);
        const command = new QueryCommand(params);
        const response = await queryClient.send(command);
        
        if (response.Rows && response.Rows.length > 0) {
            console.log(`Found ${response.Rows.length} records for ${date}:`);
            
            // Get column names
            const columnNames = response.ColumnInfo.map(col => col.Name);
            console.log(columnNames.join(', '));
            
            // Print each row
            response.Rows.forEach(row => {
                const values = row.Data.map(data => data.ScalarValue || 'NULL');
                console.log(values.join(', '));
            });
        } else {
            console.log(`No data found for date: ${date}`);
        }
    } catch (error) {
        console.error(`Error sampling data for ${date}:`, error);
    }
}

// Count records by measure name
async function countByMeasureName() {
    try {
        console.log('\nCounting records by measure name...');
        
        const params = {
            QueryString: `
                SELECT measure_name, COUNT(*) as count
                FROM "${TIMESTREAM_DB}"."${TIMESTREAM_TABLE}"
                GROUP BY measure_name
                ORDER BY count DESC
            `
        };
        
        console.log('Executing query:', params.QueryString);
        const command = new QueryCommand(params);
        const response = await queryClient.send(command);
        
        if (response.Rows && response.Rows.length > 0) {
            console.log('Measure name counts:');
            
            // Get column names
            const columnNames = response.ColumnInfo.map(col => col.Name);
            console.log(columnNames.join(', '));
            
            // Print each row
            response.Rows.forEach(row => {
                const values = row.Data.map(data => data.ScalarValue || 'NULL');
                console.log(values.join(', '));
            });
        } else {
            console.log('No data found.');
        }
    } catch (error) {
        console.error('Error counting by measure name:', error);
    }
}

// Count records by date
async function countByDate() {
    try {
        console.log('\nCounting records by date...');
        
        const params = {
            QueryString: `
                SELECT date, COUNT(*) as count
                FROM "${TIMESTREAM_DB}"."${TIMESTREAM_TABLE}"
                GROUP BY date
                ORDER BY date DESC
                LIMIT 20
            `
        };
        
        console.log('Executing query:', params.QueryString);
        const command = new QueryCommand(params);
        const response = await queryClient.send(command);
        
        if (response.Rows && response.Rows.length > 0) {
            console.log('Date counts (most recent 20):');
            
            // Get column names
            const columnNames = response.ColumnInfo.map(col => col.Name);
            console.log(columnNames.join(', '));
            
            // Print each row
            response.Rows.forEach(row => {
                const values = row.Data.map(data => data.ScalarValue || 'NULL');
                console.log(values.join(', '));
            });
        } else {
            console.log('No data found.');
        }
    } catch (error) {
        console.error('Error counting by date:', error);
    }
}

// Run all queries
async function main() {
    try {
        await countRecords();
        await countByMeasureName();
        await countByDate();
        
        // Sample data from different years
        await sampleDataByDate('2013-03-08'); // First date in our dataset
        await sampleDataByDate('2023-12-29'); // Last date in our dataset
        
        console.log('\nData check complete!');
    } catch (error) {
        console.error('Error in main execution:', error);
    }
}

main().catch(console.error); 