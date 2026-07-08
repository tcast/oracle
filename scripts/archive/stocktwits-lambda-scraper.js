const { Pool } = require('pg');
const axios = require('axios');
const cheerio = require('cheerio');
const { TimestreamWriteClient, WriteRecordsCommand } = require('@aws-sdk/client-timestream-write');
const crypto = require('crypto');

// Configuration - these will come from Lambda environment variables
const SCRAPINGBEE_API_KEY = process.env.SCRAPEBEE_API_KEY;
const TIMESTREAM_DATABASE = 'oracle';
const TIMESTREAM_TABLE = 'scraped_mentions';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const MAX_SYMBOLS_PER_RUN = 50; // Process 50 symbols per execution to stay within Lambda time limits
const MAX_CONTENT_PER_SYMBOL = 20; // Limit to 20 pieces of content per symbol

// Create a timestamp for the execution start
const runTimestamp = new Date().toISOString();

// RDS database configuration
const dbConfig = {
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT || '5432'),
  ssl: process.env.DB_REQUIRE_SSL === 'true' ? { rejectUnauthorized: false } : false,
};

// Logger that includes timestamps
const log = (message) => {
  console.log(`${new Date().toISOString()} - ${message}`);
};

// Initialize PostgreSQL client
let pool;

// Initialize Timestream client
const timestreamClient = new TimestreamWriteClient({
  region: AWS_REGION,
});

// Function to fetch random symbols from RDS
async function fetchRandomSymbols(lastProcessedSymbol = null) {
  if (!pool) {
    pool = new Pool(dbConfig);
  }
  
  try {
    const client = await pool.connect();
    log('Connected to database successfully');
    
    // Query to get the next batch of symbols, starting after the last processed symbol
    let query;
    if (lastProcessedSymbol) {
      query = `
        SELECT symbol, name 
        FROM stock_symbols 
        WHERE symbol > $1
        ORDER BY symbol 
        LIMIT ${MAX_SYMBOLS_PER_RUN}
      `;
      log(`Fetching symbols after ${lastProcessedSymbol}`);
    } else {
      query = `
        SELECT symbol, name 
        FROM stock_symbols 
        ORDER BY symbol 
        LIMIT ${MAX_SYMBOLS_PER_RUN}
      `;
      log('Fetching first batch of symbols');
    }
    
    const result = await client.query(
      lastProcessedSymbol ? query : query,
      lastProcessedSymbol ? [lastProcessedSymbol] : []
    );
    log(`Query returned ${result.rowCount} symbols`);
    client.release();
    
    return result.rows;
  } catch (err) {
    log(`Error fetching symbols from RDS: ${err.message}`);
    if (err.stack) log(err.stack);
    return [];
  }
}

// Function to scrape Stocktwits for a symbol
async function scrapeStocktwits(symbol) {
  try {
    // Calculate date one week ago
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    
    log(`Scraping Stocktwits for ${symbol}...`);
    
    const url = `https://stocktwits.com/symbol/${symbol}`;
    
    log(`Making request to ScrapingBee for URL: ${url}`);
    
    const response = await axios.get('https://app.scrapingbee.com/api/v1', {
      params: {
        'api_key': SCRAPINGBEE_API_KEY,
        'url': url,
        'render_js': 'true', // Enable JavaScript rendering
        'wait': '3000', // Wait for 3 seconds for content to load
        'premium_proxy': 'true', // Use premium proxy for better success rate
      },
      responseType: 'arraybuffer',
      timeout: 30000 // 30 second timeout (Lambda has limits)
    });
    
    log('ScrapingBee response status: ' + response.status);
    
    if (response.headers && response.headers['x-credit']) {
      log(`Remaining ScrapingBee credits: ${response.headers['x-credit']}`);
    }
    
    const html = response.data.toString('utf-8');
    const $ = cheerio.load(html);
    
    // For debugging, check how many message containers we found
    const messageContainers = $('.st_3L9Hzo7m');
    log(`Found ${messageContainers.length} message containers for ${symbol}`);
    
    const mentions = [];
    
    // If we can't find any messages with the original class, try a more generic approach
    if (messageContainers.length === 0) {
      log('No messages found with primary selector, trying alternative selectors...');
      
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
            // Calculate post date based on timestamp text
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
          log(`Error parsing alternative Stocktwits message for ${symbol}: ${err.message}`);
        }
      });
      
      log(`Found ${mentions.length} mentions using alternative selectors for ${symbol}`);
      return mentions;
    }
    
    // Targeting the message stream container and individual messages with the primary selectors
    messageContainers.each((i, messageContainer) => {
      if (mentions.length >= MAX_CONTENT_PER_SYMBOL) return false; // Stop if we've reached our limit
      
      try {
        // Extract username
        const username = $(messageContainer).find('.st_1EPytmwB').text().trim();
        if (!username) {
          const altUsername = $(messageContainer).find('a[class*="user"], span[class*="user"], a[href^="/user"]').text().trim();
          if (!altUsername) {
            return; // Skip this message
          }
        }
        
        // Extract message text
        const messageText = $(messageContainer).find('.st_2HqScKoO').text().trim();
        if (!messageText) {
          const altMessageText = $(messageContainer).find('div[class*="body"], div[class*="content"], p').text().trim();
          if (!altMessageText) {
            return; // Skip this message
          }
        }
        
        // Extract timestamp
        const timestampElement = $(messageContainer).find('.st_3UIJMGbp');
        const timestamp = timestampElement.text().trim() || '';
        
        // Extract likes
        const likes = $(messageContainer).find('.st_24X6TVr4').text().trim() || '0';
        
        // Calculate time based on timestamp text
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
        log(`Error parsing Stocktwits message for ${symbol}: ${err.message}`);
      }
    });
    
    log(`Found ${mentions.length} mentions for ${symbol}`);
    return mentions;
  } catch (err) {
    log(`Error scraping Stocktwits for ${symbol}: ${err.message}`);
    if (err.stack) log(err.stack);
    return [];
  }
}

// Function to write mentions to Timestream
async function writeToTimestream(mentions) {
  if (mentions.length === 0) {
    log('No mentions to write to Timestream');
    return { success: true, count: 0 };
  }
  
  try {
    log(`Preparing to write ${mentions.length} mentions to Timestream...`);
    
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
          { Name: 'mention_id', Value: mentionId },
          { Name: 'run_id', Value: runTimestamp }
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
    let successCount = 0;
    let failureCount = 0;
    
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      log(`Writing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(records.length/batchSize)} (${batch.length} records)`);
      
      const params = {
        DatabaseName: TIMESTREAM_DATABASE,
        TableName: TIMESTREAM_TABLE,
        Records: batch
      };
      
      try {
        await timestreamClient.send(new WriteRecordsCommand(params));
        log(`Successfully wrote batch ${Math.floor(i/batchSize) + 1}`);
        successCount += batch.length;
      } catch (err) {
        log(`Error writing batch to Timestream: ${err.message}`);
        
        // If RejectedRecordsException, some records might have been written
        if (err.name === 'RejectedRecordsException' && err.RejectedRecords) {
          const rejectedCount = err.RejectedRecords.length;
          log(`${rejectedCount} records were rejected, ${batch.length - rejectedCount} were successful`);
          successCount += (batch.length - rejectedCount);
          failureCount += rejectedCount;
          
          // Log details about rejected records
          for (const rejected of err.RejectedRecords) {
            log(`Record ${rejected.RecordIndex} rejected: ${rejected.Reason}`);
          }
        } else {
          failureCount += batch.length;
        }
      }
    }
    
    log(`Timestream write summary: ${successCount} successful, ${failureCount} failed`);
    return { success: true, count: successCount };
  } catch (err) {
    log(`Error in writeToTimestream: ${err.message}`);
    if (err.stack) log(err.stack);
    return { success: false, error: err.message };
  }
}

// Helper to add a small delay
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Main handler function for Lambda
exports.handler = async (event, context) => {
  try {
    log('Lambda function started');
    log(`Invocation event: ${JSON.stringify(event)}`);
    
    // Parse the state from the previous invocation if it exists
    const state = event.lastProcessedSymbol ? 
      { lastProcessedSymbol: event.lastProcessedSymbol } : 
      { lastProcessedSymbol: null };
    
    log(`Starting with state: ${JSON.stringify(state)}`);
    
    // 1. Fetch symbols from RDS
    const symbols = await fetchRandomSymbols(state.lastProcessedSymbol);
    
    if (symbols.length === 0) {
      log('No symbols returned from database, ending execution');
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: 'No symbols to process',
          nextState: { lastProcessedSymbol: null } // Reset to start from beginning next time
        })
      };
    }
    
    log(`Fetched ${symbols.length} symbols: ${symbols.map(s => s.symbol).join(', ')}`);
    
    // 2. For each symbol, scrape Stocktwits
    let allMentions = [];
    let lastProcessedSymbol = state.lastProcessedSymbol;
    
    for (const symbolObj of symbols) {
      log(`Processing symbol: ${symbolObj.symbol} (${symbolObj.name || 'Unknown'})`);
      const mentions = await scrapeStocktwits(symbolObj.symbol);
      allMentions = [...allMentions, ...mentions];
      lastProcessedSymbol = symbolObj.symbol;
      
      // Add a small delay between requests
      await delay(1000);
    }
    
    log(`Scraping complete. Found ${allMentions.length} mentions across ${symbols.length} symbols.`);
    
    // 3. Write mentions to Timestream
    let writeResult = { success: true, count: 0 };
    if (allMentions.length > 0) {
      log('Writing mentions to Timestream...');
      writeResult = await writeToTimestream(allMentions);
    } else {
      log('No mentions found, nothing to write to Timestream');
    }
    
    // Determine if we need to process more symbols
    const moreSymbolsAvailable = symbols.length === MAX_SYMBOLS_PER_RUN;
    const nextState = moreSymbolsAvailable ? 
      { lastProcessedSymbol } : 
      { lastProcessedSymbol: null }; // Reset for next run
    
    // Return result with state for next invocation
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Stocktwits scraping completed',
        mentions: allMentions.length,
        written: writeResult.count,
        lastProcessedSymbol,
        moreSymbolsAvailable,
        nextState
      })
    };
  } catch (err) {
    log(`Error in Lambda handler: ${err.message}`);
    if (err.stack) log(err.stack);
    
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Error processing Stocktwits data',
        error: err.message
      })
    };
  } finally {
    // Close the database pool if it exists
    if (pool) {
      log('Closing database connection pool');
      await pool.end();
    }
  }
}; 