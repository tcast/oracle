/**
 * AWS Lambda function to scrape Reddit for stock and crypto mentions
 * and store the results in Amazon Timestream
 */

const axios = require('axios');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { writeMentionsToTimestream } = require('./timestream-mentions');

// Initialize SNS client
const sns = new SNSClient();

// Environment variables
const scrapeBeeApiKey = process.env.SCRAPEBEE_API_KEY;
const scrapeBeeApiDomain = 'app.scrapingbee.com';

/**
 * Scrape Reddit for a symbol
 * @param {string} symbol - Stock or crypto symbol
 * @param {string} type - Asset type ('stock' or 'crypto')
 * @returns {Promise<Array>} - Array of mentions
 */
async function scrapeRedditForSymbol(symbol, type = 'stock') {
  console.log(`Scraping Reddit for symbol: ${symbol}, type: ${type}`);
  
  // Define relevant subreddits to check based on the asset type
  const subreddits = type === 'stock' 
    ? ['wallstreetbets', 'stocks', 'investing', 'stockmarket'] 
    : ['cryptocurrency', 'cryptomarkets', 'bitcoin', 'altcoin'];
  
  const searchTerm = type === 'stock' ? `$${symbol}` : symbol;
  let mentions = [];

  // Try to get data from each relevant subreddit
  for (const subreddit of subreddits) {
    try {
      // Construct the Reddit search URL
      const redditUrl = `https://www.reddit.com/r/${subreddit}/search/?q=${encodeURIComponent(searchTerm)}&sort=new&t=week`;
      
      // Reddit-specific advanced scraping options to avoid blocks
      const scrapingOptions = {
        render_js: true,       // Enable JavaScript rendering
        premium_proxy: true,   // Use premium proxy to avoid blocks
        country_code: 'us',    // Use US IP addresses
        stealth_proxy: true    // Use stealth mode for Reddit
      };
      
      console.log(`Scraping r/${subreddit} for ${searchTerm}...`);
      const scrapedData = await scrapeWithScrapeBee(redditUrl, scrapingOptions);
      
      if (!scrapedData || !scrapedData.html) {
        console.log(`No data returned from ScrapeBee for r/${subreddit}`);
        continue;
      }
      
      const html = scrapedData.html;
      
      // Extract posts using regex - this is simplified and might need refinement
      const postRegex = /<div class="Post[^>]*>[\s\S]*?<h3[^>]*>(.*?)<\/h3>[\s\S]*?<\/div>/g;
      let match;
      let postsFound = 0;
      
      while ((match = postRegex.exec(html)) !== null) {
        postsFound++;
        const title = match[1].replace(/<[^>]*>/g, ''); // Strip HTML tags
        const url = redditUrl;
        
        // Simple sentiment analysis
        const sentiment = calculateSentiment(title);
        
        mentions.push({
          symbol,
          asset_type: type,
          platform: 'reddit',
          subreddit,
          content: title,
          url,
          sentiment_score: sentiment.score,
          sentiment_label: sentiment.label,
          post_id: `reddit-${symbol}-${subreddit}-${Date.now()}-${postsFound}`,
          post_date: new Date().toISOString()
        });
      }
      
      console.log(`Found ${postsFound} posts in r/${subreddit}`);
    } catch (error) {
      console.error(`Error scraping r/${subreddit}:`, error.message);
    }
  }
  
  return mentions;
}

/**
 * Calculate sentiment based on text
 * @param {string} text - Text to analyze
 * @returns {Object} - Sentiment analysis result
 */
function calculateSentiment(text) {
  const positiveWords = ["up", "bull", "buy", "moon", "rocket", "gain", "profit", "good", "great"];
  const negativeWords = ["down", "bear", "sell", "crash", "tank", "drop", "loss", "bad", "terrible"];
  
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
    if (!scrapeBeeApiKey) {
      console.error('ScrapeBee API key is missing');
      return null;
    }
    
    // Build the ScrapeBee API URL
    let scrapeBeeUrl = `https://${scrapeBeeApiDomain}/api/v1/?api_key=${scrapeBeeApiKey}&url=${encodeURIComponent(url)}`;
    
    // Add options to URL
    if (options.render_js) scrapeBeeUrl += '&render_js=true';
    if (options.premium_proxy) scrapeBeeUrl += '&premium_proxy=true';
    if (options.country_code) scrapeBeeUrl += `&country_code=${options.country_code}`;
    if (options.stealth_proxy) scrapeBeeUrl += '&stealth_proxy=true';
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
    console.log('Starting Reddit scraper run with Timestream integration');
    
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
      
      // Scrape Reddit for this symbol
      const mentions = await scrapeRedditForSymbol(symbol, type);
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