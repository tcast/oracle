const { TimestreamQueryClient, QueryCommand } = require('@aws-sdk/client-timestream-query');

async function checkScrapedMentions() {
  try {
    const client = new TimestreamQueryClient({
      region: 'us-east-1'
    });

    // First check if the table exists
    const listTablesParams = {
      QueryString: "SHOW tables FROM oracle"
    };
    
    console.log("Checking for tables in oracle database...");
    const listTablesResponse = await client.send(new QueryCommand(listTablesParams));
    console.log("Tables in oracle database:");
    
    if (listTablesResponse.Rows && listTablesResponse.Rows.length > 0) {
      listTablesResponse.Rows.forEach(row => {
        console.log(row.Data[0].ScalarValue);
      });
      
      // Check if scraped_mentions exists
      const tableExists = listTablesResponse.Rows.some(row => 
        row.Data[0].ScalarValue === 'scraped_mentions'
      );
      
      if (tableExists) {
        // If the table exists, check for records
        const countParams = {
          QueryString: "SELECT COUNT(*) FROM oracle.scraped_mentions"
        };
        
        console.log("\nChecking records in scraped_mentions table...");
        const countResponse = await client.send(new QueryCommand(countParams));
        
        if (countResponse.Rows && countResponse.Rows.length > 0) {
          const count = countResponse.Rows[0].Data[0].ScalarValue;
          console.log(`The scraped_mentions table has ${count} records.`);
        }
      } else {
        console.log("\nThe scraped_mentions table does not exist in the oracle database.");
      }
    } else {
      console.log("No tables found in the oracle database.");
    }
    
  } catch (error) {
    console.error("Error querying Timestream:", error);
  }
}

checkScrapedMentions(); 