require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');
const cheerio = require('cheerio');
const { TimestreamWriteClient, WriteRecordsCommand } = require('@aws-sdk/client-timestream-write');
const crypto = require('crypto');

// Configuration
const SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY || process.env.SCRAPEBEE_API_KEY || 'YOUR_SCRAPINGBEE_API_KEY';
const TIMESTREAM_DATABASE = 'oracle';
const TIMESTREAM_TABLE = 'scraped_mentions';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const TEST_MODE = false; // Set to false for production
const MAX_SYMBOLS = TEST_MODE ? 5 : 10000; // Limit to 5 for testing
const MAX_CONTENT_PER_SYMBOL = TEST_MODE ? 4 : 50; // Limit to 20 pieces of content for testing (4 per symbol)

// RDS database configuration
const dbConfig = {
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT || '5432'),
  ssl: process.env.DB_REQUIRE_SSL === 'true' ? { rejectUnauthorized: false } : false,
};

console.log('Using database config:', {
  host: dbConfig.host,
  database: dbConfig.database,
  user: dbConfig.user,
  port: dbConfig.port,
  ssl: !!dbConfig.ssl
});

console.log('Using ScrapingBee API key:', SCRAPINGBEE_API_KEY ? `${SCRAPINGBEE_API_KEY.substring(0, 5)}...` : 'Not set');

// Initialize PostgreSQL client
const pool = new Pool(dbConfig);

// Initialize Timestream client
const timestreamClient = new TimestreamWriteClient({
  region: AWS_REGION,
});

// Function to fetch random symbols from RDS
async function fetchRandomSymbols() {
  try {
    const client = await pool.connect();
    console.log('Connected to database successfully');
    
    let query;
    if (TEST_MODE) {
      // In test mode, get 5 popular symbols that are likely to have mentions
      query = `
        SELECT symbol, name 
        FROM stock_symbols 
        WHERE symbol IN ('AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA')
        LIMIT ${MAX_SYMBOLS}
      `;
    } else {
      // In production mode, get random symbols
      query = `
        SELECT symbol, name 
        FROM stock_symbols 
        ORDER BY RANDOM() 
        LIMIT ${MAX_SYMBOLS}
      `;
    }
    
    console.log('Executing query:', query);
    const result = await client.query(query);
    console.log(`Query returned ${result.rowCount} rows`);
    client.release();
    
    return result.rows;
  } catch (err) {
    console.error('Error fetching symbols from RDS:', err);
    return [];
  }
}

// Function to scrape Stocktwits for a symbol
async function scrapeStocktwits(symbol) {
  try {
    // Calculate date one week ago
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    
    console.log(`Scraping Stocktwits for ${symbol}...`);
    
    const url = `https://stocktwits.com/symbol/${symbol}`;
    
    // Log request details for debugging
    console.log(`Making request to ScrapingBee for URL: ${url}`);
    
    const response = await axios.get('https://app.scrapingbee.com/api/v1', {
      params: {
        'api_key': SCRAPINGBEE_API_KEY,
        'url': url,
        'render_js': 'true', // Enable JavaScript rendering
        'wait': '5000', // Wait for 5 seconds for content to load
        'premium_proxy': 'true', // Use premium proxy for better success rate
      },
      responseType: 'arraybuffer',
      timeout: 60000 // 60 second timeout
    });
    
    console.log('ScrapingBee response status:', response.status);
    
    if (response.headers && response.headers['x-credit']) {
      console.log(`Remaining ScrapingBee credits: ${response.headers['x-credit']}`);
    }
    
    const html = response.data.toString('utf-8');
    const $ = cheerio.load(html);
    
    // For debugging, check how many message containers we found
    const messageContainers = $('.st_3L9Hzo7m');
    console.log(`Found ${messageContainers.length} message containers for ${symbol}`);
    
    // If we can't find any messages with the original class, try a more generic approach
    if (messageContainers.length === 0) {
      console.log('No messages found with primary selector, trying alternative selectors...');
      
      // Save HTML for debugging
      // fs.writeFileSync(`stocktwits_${symbol}.html`, html);
      
      // Try to find messages by looking for common structural elements
      // This is a simplified approach since we don't have the exact classes
      const mentions = [];
      
      // Look for message streams by finding divs that might contain messages
      $('div.message, div[class*="message"], div[class*="stream"] > div').each((i, element) => {
        if (mentions.length >= MAX_CONTENT_PER_SYMBOL) return false;
        
        try {
          // Try to find the username, message, and timestamp in nearby elements
          const container = $(element);
          
          // Username is often in an anchor tag with a user profile URL
          const usernameElement = container.find('a[href*="/user"], a[class*="user"], span[class*="user"]').first();
          const username = usernameElement.text().trim() || 'Unknown';
          
          // Message is usually in a paragraph or div
          const messageElement = container.find('p, div[class*="body"], div[class*="content"]').first();
          const messageText = messageElement.text().trim() || 'No message content';
          
          // Timestamp is often in a small text element or span
          const timestampElement = container.find('span[class*="time"], small, time, span[class*="date"]').first();
          const timestamp = timestampElement.text().trim() || '';
          
          // Likes might be in a span with a number
          const likesElement = container.find('span[class*="like"], div[class*="like"]').first();
          const likes = likesElement.text().trim().replace(/\D/g, '') || '0';
          
          // Only include if we have at least a username and message
          if (username !== 'Unknown' && messageText !== 'No message content') {
            // Calculate post date similar to before
            let postDate = new Date();
            if (timestamp.includes('min')) {
              const mins = parseInt(timestamp.split(' ')[0]);
              postDate.setMinutes(postDate.getMinutes() - mins);
            } else if (timestamp.includes('hour')) {
              const hours = parseInt(timestamp.split(' ')[0]);
              postDate.setHours(postDate.getHours() - hours);
            } else if (timestamp.includes('day')) {
              const days = parseInt(timestamp.split(' ')[0]);
              postDate.setDate(postDate.getDate() - days);
            }
            
            // Only include if within the past week
            if (postDate >= oneWeekAgo) {
              mentions.push({
                symbol,
                username,
                message: messageText,
                timestamp: postDate.toISOString(),
                likes: parseInt(likes || '0'),
                platform: 'stocktwits'
              });
            }
          }
        } catch (err) {
          console.error(`Error parsing alternative Stocktwits message for ${symbol}:`, err);
        }
      });
      
      console.log(`Found ${mentions.length} mentions using alternative selectors for ${symbol}`);
      return mentions;
    }
    
    const mentions = [];
    
    // Targeting the message stream container and individual messages
    messageContainers.each((i, messageContainer) => {
      if (mentions.length >= MAX_CONTENT_PER_SYMBOL) return false; // Stop if we've reached our limit
      
      try {
        // Extract username
        const username = $(messageContainer).find('.st_1EPytmwB').text().trim();
        if (!username) {
          console.log('Username not found, trying alternative selector');
          const altUsername = $(messageContainer).find('a[class*="user"], span[class*="user"], a[href^="/user"]').text().trim();
          if (!altUsername) {
            console.log('Skipping message - no username found');
            return; // Skip this message
          }
        }
        
        // Extract message text
        const messageText = $(messageContainer).find('.st_2HqScKoO').text().trim();
        if (!messageText) {
          console.log('Message text not found, trying alternative selector');
          const altMessageText = $(messageContainer).find('div[class*="body"], div[class*="content"], p').text().trim();
          if (!altMessageText) {
            console.log('Skipping message - no message content found');
            return; // Skip this message
          }
        }
        
        // Extract timestamp
        const timestampElement = $(messageContainer).find('.st_3UIJMGbp');
        const timestamp = timestampElement.text().trim() || '';
        if (!timestamp) {
          console.log('Timestamp not found, trying alternative selector');
          const altTimestamp = $(messageContainer).find('span[class*="time"], time, small').text().trim();
          if (!altTimestamp) {
            console.log('Using current time as fallback');
          }
        }
        
        // Extract likes
        const likes = $(messageContainer).find('.st_24X6TVr4').text().trim() || '0';
        
        // Calculate time - crude approximation based on text
        let postDate = new Date();
        const timeText = timestamp || 'now';
        
        if (timeText.includes('min')) {
          const mins = parseInt(timeText.split(' ')[0]);
          postDate.setMinutes(postDate.getMinutes() - mins);
        } else if (timeText.includes('hour')) {
          const hours = parseInt(timeText.split(' ')[0]);
          postDate.setHours(postDate.getHours() - hours);
        } else if (timeText.includes('day')) {
          const days = parseInt(timeText.split(' ')[0]);
          postDate.setDate(postDate.getDate() - days);
        }
        
        // Only include if within the past week
        if (postDate >= oneWeekAgo) {
          mentions.push({
            symbol,
            username: username || 'Unknown User',
            message: messageText || 'No content',
            timestamp: postDate.toISOString(),
            likes: parseInt(likes || '0'),
            platform: 'stocktwits'
          });
        }
      } catch (err) {
        console.error(`Error parsing Stocktwits message for ${symbol}:`, err);
      }
    });
    
    console.log(`Found ${mentions.length} mentions for ${symbol}`);
    return mentions;
  } catch (err) {
    console.error(`Error scraping Stocktwits for ${symbol}:`, err);
    return [];
  }
}

// Function to write mentions to Timestream
async function writeToTimestream(mentions) {
  if (mentions.length === 0) {
    console.log('No mentions to write to Timestream');
    return;
  }
  
  try {
    console.log(`Preparing to write ${mentions.length} mentions to Timestream...`);
    
    // Transform mentions to Timestream records
    const records = mentions.map(mention => {
      // Generate a unique ID for this mention
      const mentionId = crypto.createHash('md5').update(`${mention.symbol}_${mention.username}_${mention.timestamp}`).digest('hex');
      
      // Convert ISO timestamp to milliseconds for Timestream
      const timeInMs = new Date(mention.timestamp).getTime();
      
      return {
        Dimensions: [
          { Name: 'symbol', Value: mention.symbol },
          { Name: 'username', Value: mention.username },
          { Name: 'platform', Value: mention.platform },
          { Name: 'mention_id', Value: mentionId }
        ],
        MeasureName: 'post',
        MeasureValue: mention.message,
        MeasureValueType: 'VARCHAR',
        Time: timeInMs.toString(),
        TimeUnit: 'MILLISECONDS'
      };
    });
    
    // Split records into batches of 100 (Timestream limit)
    const batchSize = 100;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      console.log(`Writing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(records.length/batchSize)} (${batch.length} records)`);
      
      const params = {
        DatabaseName: TIMESTREAM_DATABASE,
        TableName: TIMESTREAM_TABLE,
        Records: batch
      };
      
      try {
        await timestreamClient.send(new WriteRecordsCommand(params));
        console.log(`Successfully wrote batch ${Math.floor(i/batchSize) + 1}`);
      } catch (err) {
        console.error(`Error writing batch ${Math.floor(i/batchSize) + 1} to Timestream:`, err);
      }
    }
    
    console.log(`Successfully wrote ${records.length} mentions to Timestream`);
  } catch (err) {
    console.error('Error writing to Timestream:', err);
  }
}

// Main function
async function main() {
  try {
    console.log('Starting Stocktwits scraper in', TEST_MODE ? 'TEST MODE' : 'PRODUCTION MODE');
    
    // 1. Fetch symbols from RDS
    const symbols = await fetchRandomSymbols();
    console.log(`Fetched ${symbols.length} symbols from RDS:`, symbols.map(s => s.symbol).join(', '));
    
    if (symbols.length === 0) {
      console.error('No symbols found, exiting');
      return;
    }
    
    // 2. For each symbol, scrape Stocktwits
    let allMentions = [];
    for (const symbolObj of symbols) {
      console.log(`\n--- Processing symbol: ${symbolObj.symbol} (${symbolObj.name || 'Unknown'}) ---`);
      const mentions = await scrapeStocktwits(symbolObj.symbol);
      allMentions = [...allMentions, ...mentions];
      
      // Add a small delay between requests to avoid rate limiting
      const delay = TEST_MODE ? 2000 : 5000;
      console.log(`Waiting ${delay/1000} seconds before next request...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    
    console.log(`\nScraping complete. Found ${allMentions.length} total mentions across ${symbols.length} symbols.`);
    
    // 3. Write mentions to Timestream
    if (allMentions.length > 0) {
      console.log('Writing mentions to Timestream...');
      await writeToTimestream(allMentions);
    } else {
      console.log('No mentions found, nothing to write to Timestream');
    }
    
    console.log('Process complete');
  } catch (err) {
    console.error('Error in main function:', err);
  } finally {
    // Close the PostgreSQL pool
    console.log('Closing database pool');
    await pool.end();
  }
}

// Run the main function
console.log('Starting script...');
main().catch(err => {
  console.error('Uncaught error:', err);
}); 