require('dotenv').config();
const { TimestreamQueryClient, QueryCommand } = require('@aws-sdk/client-timestream-query');

async function checkScrapedMentions() {
  try {
    const client = new TimestreamQueryClient({
      region: process.env.AWS_REGION || 'us-east-1'
    });

    // Count all mentions
    const countQuery = {
      QueryString: "SELECT COUNT(*) AS total_mentions FROM oracle.scraped_mentions"
    };
    
    console.log("Checking record count in scraped_mentions table...");
    const countResponse = await client.send(new QueryCommand(countQuery));
    
    if (countResponse.Rows && countResponse.Rows.length > 0) {
      const totalCount = countResponse.Rows[0].Data[0].ScalarValue;
      console.log(`The scraped_mentions table has ${totalCount} total records.`);
    }

    // Count mentions by symbol
    const symbolCountQuery = {
      QueryString: "SELECT symbol, COUNT(*) as count FROM oracle.scraped_mentions GROUP BY symbol ORDER BY count DESC LIMIT 10"
    };
    
    console.log("\nTop 10 symbols by mention count:");
    const symbolCountResponse = await client.send(new QueryCommand(symbolCountQuery));
    
    if (symbolCountResponse.Rows && symbolCountResponse.Rows.length > 0) {
      console.log("Symbol | Count");
      console.log("-------|------");
      symbolCountResponse.Rows.forEach(row => {
        const symbol = row.Data[0].ScalarValue;
        const count = row.Data[1].ScalarValue;
        console.log(`${symbol.padEnd(7)} | ${count}`);
      });
    }

    // Count mentions by platform
    const platformCountQuery = {
      QueryString: "SELECT platform, COUNT(*) as count FROM oracle.scraped_mentions GROUP BY platform"
    };
    
    console.log("\nMention count by platform:");
    const platformCountResponse = await client.send(new QueryCommand(platformCountQuery));
    
    if (platformCountResponse.Rows && platformCountResponse.Rows.length > 0) {
      console.log("Platform    | Count");
      console.log("------------|------");
      platformCountResponse.Rows.forEach(row => {
        const platform = row.Data[0].ScalarValue;
        const count = row.Data[1].ScalarValue;
        console.log(`${platform.padEnd(12)} | ${count}`);
      });
    }
    
    // Get most recent mentions
    const recentQuery = {
      QueryString: "SELECT time, symbol, username, measure_value::varchar as message FROM oracle.scraped_mentions ORDER BY time DESC LIMIT 5"
    };
    
    console.log("\nMost recent mentions:");
    const recentResponse = await client.send(new QueryCommand(recentQuery));
    
    if (recentResponse.Rows && recentResponse.Rows.length > 0) {
      recentResponse.Rows.forEach(row => {
        const time = new Date(parseInt(row.Data[0].ScalarValue)).toISOString();
        const symbol = row.Data[1].ScalarValue;
        const username = row.Data[2].ScalarValue;
        const message = row.Data[3].ScalarValue;
        
        console.log(`[${time}] ${symbol} - ${username}: ${message.substring(0, 100)}${message.length > 100 ? '...' : ''}`);
      });
    }
    
  } catch (error) {
    console.error("Error querying Timestream:", error);
  }
}

// Run the function
checkScrapedMentions(); 