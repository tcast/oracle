const { Pool } = require('pg');
const axios = require('axios');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

// Initialize SNS client
const sns = new SNSClient();
let pool;

// Environment variables
const SCRAPEBEE_API_KEY = process.env.SCRAPEBEE_API_KEY;
const SCRAPEBEE_DOMAIN = 'stocktwits.com';

/**
 * Initialize the database connection
 */
const initializeDb = async () => {
  if (!pool) {
    pool = new Pool({
      user: process.env.DB_USER,
      host: process.env.DB_HOST,
      database: process.env.DB_NAME,
      password: process.env.DB_PASSWORD,
      port: 5432,
      ssl: {
        rejectUnauthorized: false
      }
    });
  }
  return pool;
};

/**
 * Scrape StockTwits for a given symbol
 * @param {string} symbol - Stock or crypto symbol
 * @param {string} type - Type of asset ('stock' or 'crypto')
 * @returns {Promise<Array>} - Array of mentions
 */
async function scrapeStockTwitsForSymbol(symbol, type = 'stock') {
  console.log(`Scraping StockTwits for ${symbol} (${type})`);
  
  const url = `https://stocktwits.com/symbol/${symbol}`;
  
  try {
    const response = await scrapeWithScrapeBee(url, {
      render_js: true,
      premium_proxy: true,
      wait: 5000
    });
    
    if (!response || !response.data) {
      console.log(`No data returned for ${symbol} from StockTwits`);
      return [];
    }
    
    const html = response.data;
    
    // Extract messages from the HTML
    const messages = extractStockTwitMessages(html, symbol);
    
    if (!messages || messages.length === 0) {
      console.log(`No messages found for ${symbol} on StockTwits`);
      return [];
    }
    
    // Process messages and calculate sentiment
    const mentions = messages.map(message => {
      const sentiment = calculateSentiment(message.text);
      
      return {
        symbol,
        platform: 'stocktwits',
        post_id: message.id || `st-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
        post_url: message.url || url,
        post_text: message.text,
        post_date: message.date || new Date().toISOString(),
        sentiment_score: sentiment.score,
        sentiment_label: sentiment.label,
        user_followers: message.user_followers || 0,
        asset_type: type
      };
    });
    
    console.log(`Found ${mentions.length} mentions for ${symbol} on StockTwits`);
    return mentions;
  } catch (error) {
    console.error(`Error scraping StockTwits for ${symbol}:`, error.message);
    return [];
  }
}

/**
 * Extract messages from StockTwits HTML
 * @param {string} html - HTML content
 * @param {string} symbol - Stock symbol
 * @returns {Array} - Array of message objects
 */
function extractStockTwitMessages(html, symbol) {
  try {
    // This is a simple extraction - in a real scenario, use more robust parsing
    const messages = [];
    const messageRegex = /<div class="[^"]*message-container[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    const messageContentRegex = /<div class="[^"]*message__content[^"]*"[^>]*>([\s\S]*?)<\/div>/i;
    const messageTextRegex = /<div class="[^"]*message__body[^"]*"[^>]*>([\s\S]*?)<\/div>/i;
    const userFollowersRegex = /<span class="[^"]*user-followers[^"]*"[^>]*>(\d+)<\/span>/i;
    
    let match;
    let count = 0;
    const maxMessages = 20; // Limit the number of messages to extract
    
    while ((match = messageRegex.exec(html)) !== null && count < maxMessages) {
      const messageBlock = match[0];
      const contentMatch = messageContentRegex.exec(messageBlock);
      
      if (contentMatch) {
        const content = contentMatch[1];
        const textMatch = messageTextRegex.exec(content);
        const followersMatch = userFollowersRegex.exec(messageBlock);
        
        if (textMatch) {
          const text = stripHtml(textMatch[1]);
          
          // Only include messages that mention the symbol
          if (text.includes(`$${symbol}`)) {
            messages.push({
              id: `st-${count}-${Date.now()}`,
              text,
              user_followers: followersMatch ? parseInt(followersMatch[1], 10) : 0,
              date: new Date().toISOString(),
              url: `https://stocktwits.com/symbol/${symbol}`
            });
            count++;
          }
        }
      }
    }
    
    return messages;
  } catch (error) {
    console.error(`Error extracting StockTwits messages:`, error.message);
    return [];
  }
}

/**
 * Strip HTML tags from text
 * @param {string} html - HTML content
 * @returns {string} - Plain text
 */
function stripHtml(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Calculate sentiment score and label for text
 * @param {string} text - Text to analyze
 * @returns {Object} - Object with score and label
 */
function calculateSentiment(text) {
  // Simple sentiment analysis based on keywords
  const positiveWords = ['buy', 'bullish', 'long', 'up', 'moon', 'rocket', 'gain', 'profit', 'green', 'good', 'great', 'awesome', 'win', 'positive'];
  const negativeWords = ['sell', 'bearish', 'short', 'down', 'crash', 'fall', 'drop', 'loss', 'red', 'bad', 'terrible', 'awful', 'lose', 'negative'];
  
  const lowerText = text.toLowerCase();
  
  let score = 0;
  
  positiveWords.forEach(word => {
    if (lowerText.includes(word)) score += 1;
  });
  
  negativeWords.forEach(word => {
    if (lowerText.includes(word)) score -= 1;
  });
  
  let label = 'neutral';
  if (score > 0) label = 'positive';
  if (score < 0) label = 'negative';
  
  return { score, label };
}

/**
 * Store mentions in the database
 * @param {Array} mentions - Array of mentions
 * @returns {Promise<boolean>} - Success or failure
 */
async function storeMentionsInDatabase(mentions) {
  if (!mentions || mentions.length === 0) {
    console.log('No mentions to store');
    return true;
  }
  
  const client = await (await initializeDb()).connect();
  
  try {
    // Create table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS scraped_mentions (
        id SERIAL PRIMARY KEY,
        symbol VARCHAR(20) NOT NULL,
        platform VARCHAR(20) NOT NULL,
        post_id VARCHAR(100) NOT NULL,
        post_url TEXT,
        post_text TEXT,
        post_date TIMESTAMP,
        sentiment_score FLOAT,
        sentiment_label VARCHAR(20),
        user_followers INTEGER,
        asset_type VARCHAR(10),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(platform, post_id)
      )
    `);
    
    // Insert mentions in batches
    console.log(`Storing ${mentions.length} mentions in database`);
    
    const insertQuery = `
      INSERT INTO scraped_mentions
        (symbol, platform, post_id, post_url, post_text, post_date, sentiment_score, sentiment_label, user_followers, asset_type)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (platform, post_id) DO NOTHING
    `;
    
    for (const mention of mentions) {
      await client.query(insertQuery, [
        mention.symbol,
        mention.platform,
        mention.post_id,
        mention.post_url,
        mention.post_text,
        mention.post_date,
        mention.sentiment_score,
        mention.sentiment_label,
        mention.user_followers,
        mention.asset_type
      ]);
    }
    
    console.log(`Successfully stored mentions in database`);
    return true;
  } catch (error) {
    console.error(`Error storing mentions in database:`, error.message);
    return false;
  } finally {
    client.release();
  }
}

/**
 * Scrape StockTwits using ScrapeBee API
 * @param {string} url - URL to scrape
 * @param {Object} options - ScrapeBee options
 * @returns {Promise<Object>} - Response data
 */
async function scrapeWithScrapeBee(url, options = {}) {
  if (!SCRAPEBEE_API_KEY) {
    throw new Error('ScrapeBee API key is not set');
  }
  
  const apiUrl = 'https://app.scrapingbee.com/api/v1/';
  
  const params = {
    api_key: SCRAPEBEE_API_KEY,
    url,
    ...options
  };
  
  try {
    console.log(`Scraping ${url} with ScrapeBee`);
    const response = await axios.get(apiUrl, { params });
    
    if (response.status !== 200) {
      console.error(`ScrapeBee API returned status ${response.status}`);
      return null;
    }
    
    return response;
  } catch (error) {
    console.error(`Error calling ScrapeBee API:`, error.message);
    throw error;
  }
}

/**
 * Lambda handler function
 * @param {Object} event - Lambda event
 * @param {Object} context - Lambda context
 * @returns {Promise<Object>} - Response object
 */
exports.handler = async (event, context) => {
  console.log('StockTwits scraper Lambda started');
  console.log('Event:', JSON.stringify(event));
  
  try {
    // Extract symbols from SNS message
    let symbols = [];
    
    if (event.Records && event.Records.length > 0) {
      // Processing SNS message
      const message = JSON.parse(event.Records[0].Sns.Message);
      if (message.symbols) {
        symbols = message.symbols;
      }
    } else if (event.symbols) {
      // Direct invocation with symbols
      symbols = event.symbols;
    }
    
    if (!symbols || symbols.length === 0) {
      console.log('No symbols provided, exiting early');
      return { statusCode: 200, body: 'No symbols to process' };
    }
    
    console.log(`Processing ${symbols.length} symbols for StockTwits data`);
    
    let totalMentions = 0;
    
    // Process each symbol
    for (const symbolObj of symbols) {
      const { symbol, type = 'stock' } = symbolObj;
      
      if (!symbol) {
        console.log('Invalid symbol entry, skipping');
        continue;
      }
      
      // Scrape StockTwits for the symbol
      const mentions = await scrapeStockTwitsForSymbol(symbol, type);
      
      if (mentions && mentions.length > 0) {
        // Store mentions in database
        await storeMentionsInDatabase(mentions);
        totalMentions += mentions.length;
      }
    }
    
    console.log(`Successfully processed ${symbols.length} symbols, found ${totalMentions} mentions`);
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'StockTwits scraping completed successfully',
        symbolsProcessed: symbols.length,
        mentionsFound: totalMentions
      })
    };
  } catch (error) {
    console.error('Error in StockTwits scraper Lambda:', error.message);
    
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Error in StockTwits scraper Lambda',
        error: error.message
      })
    };
  } finally {
    // Close database connection
    if (pool) {
      await pool.end();
    }
  }
}; 