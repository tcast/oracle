/**
 * AWS Lambda function to scrape StockTwits for stock and crypto mentions
 * and store the results in Amazon Timestream
 */

const axios = require('axios');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { writeMentionsToTimestream } = require('./timestream-mentions');

// Initialize SNS client
const sns = new SNSClient();

// Environment variables
const SCRAPEBEE_API_KEY = process.env.SCRAPEBEE_API_KEY;

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
    
    if (!response || !response.html) {
      console.log(`No data returned for ${symbol} from StockTwits`);
      return [];
    }
    
    const html = response.html;
    
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
        post_id: message.id,
        url: message.url || url,
        content: message.text,
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
              id: `st-${symbol}-${Date.now()}-${count}`,
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
  
  let positiveScore = 0;
  let negativeScore = 0;
  
  positiveWords.forEach(word => {
    if (lowerText.includes(word)) positiveScore++;
  });
  
  negativeWords.forEach(word => {
    if (lowerText.includes(word)) negativeScore++;
  });
  
  // Calculate score between -1 and 1
  let score = 0;
  if (positiveScore > 0 || negativeScore > 0) {
    score = (positiveScore - negativeScore) / (positiveScore + negativeScore);
  }
  
  // Determine label
  let label = 'neutral';
  if (score > 0.2) label = 'positive';
  if (score < -0.2) label = 'negative';
  
  return { score, label };
}

/**
 * Scrape with ScrapeBee
 * @param {string} url - URL to scrape
 * @param {Object} options - Scraping options
 * @returns {Promise<Object>} - Scraped data
 */
async function scrapeWithScrapeBee(url, options = {}) {
  try {
    if (!SCRAPEBEE_API_KEY) {
      console.error('ScrapeBee API key is missing');
      return null;
    }
    
    // Build the ScrapeBee API URL with proper API key and options
    let scrapeBeeUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPEBEE_API_KEY}&url=${encodeURIComponent(url)}`;
    
    // Add options to URL
    if (options.render_js) scrapeBeeUrl += '&render_js=true';
    if (options.premium_proxy) scrapeBeeUrl += '&premium_proxy=true';
    if (options.country_code) scrapeBeeUrl += `&country_code=${options.country_code}`;
    if (options.wait) scrapeBeeUrl += `&wait=${options.wait}`;
    
    console.log(`Calling ScrapeBee API for ${url}`);
    
    const response = await axios.get(scrapeBeeUrl, {
      timeout: 30000 // 30 second timeout
    });
    
    if (response.status === 200) {
      console.log(`Successfully scraped data from ${url}`);
      return {
        success: true,
        html: response.data,
        status: response.status
      };
    } else {
      console.error(`Error scraping ${url}: HTTP ${response.status}`);
      return null;
    }
  } catch (error) {
    console.error(`Error scraping data from ${url}:`, error.message);
    return null;
  }
}

/**
 * Main Lambda handler
 */
exports.handler = async (event, context) => {
  try {
    console.log('Starting StockTwits scraper run with Timestream integration');
    
    // Parse input symbols from event
    let symbols = [];
    
    if (event.Records && event.Records[0] && event.Records[0].Sns) {
      // Event from SNS
      const message = JSON.parse(event.Records[0].Sns.Message);
      symbols = message.symbols || [];
    } else if (event.symbols) {
      // Direct invocation
      symbols = event.symbols;
    }
    
    if (symbols.length === 0) {
      console.log('No symbols provided, exiting');
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'No symbols to process' })
      };
    }
    
    console.log(`Processing ${symbols.length} symbols`);
    
    let allMentions = [];
    
    // Process each symbol
    for (const symbolData of symbols) {
      let symbol, type;
      
      if (typeof symbolData === 'string') {
        symbol = symbolData;
        type = 'stock'; // Default to stock
      } else {
        symbol = symbolData.symbol;
        type = symbolData.type || 'stock';
      }
      
      if (!symbol) {
        console.log('Invalid symbol data, skipping');
        continue;
      }
      
      // Scrape StockTwits for this symbol
      const mentions = await scrapeStockTwitsForSymbol(symbol, type);
      allMentions = allMentions.concat(mentions);
    }
    
    console.log(`Total mentions found: ${allMentions.length}`);
    
    // Store mentions in Timestream
    if (allMentions.length > 0) {
      const result = await writeMentionsToTimestream(allMentions);
      console.log(`Stored ${result.processedCount} mentions in Timestream`);
      
      if (!result.success) {
        console.error('There were errors writing to Timestream:', result.errors);
      }
    }
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Processing complete',
        mentions_found: allMentions.length,
        symbols_processed: symbols.length
      })
    };
  } catch (error) {
    console.error('Error in Lambda handler:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Error processing request',
        error: error.message
      })
    };
  }
}; 