const { Pool } = require('pg');
const axios = require('axios');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

// Initialize clients
const sns = new SNSClient();
let pool;

// Environment variables
const scrapeBeeApiKey = process.env.SCRAPEBEE_API_KEY;
const scrapeBeeApiDomain = 'app.scrapingbee.com';

// Initialize database connection
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

// Scrape Reddit for a symbol
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
          type,
          platform: 'reddit',
          subreddit,
          content: title,
          url,
          sentiment
        });
      }
      
      console.log(`Found ${postsFound} posts in r/${subreddit}`);
    } catch (error) {
      console.error(`Error scraping r/${subreddit}:`, error.message);
    }
  }
  
  return mentions;
}

// Calculate sentiment based on text
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
  
  // Return a value between -1 and 1
  if (positiveScore === negativeScore) return 0;
  return positiveScore > negativeScore ? 0.5 : -0.5;
}

// Store mentions in database
async function storeMentionsInDatabase(mentions) {
  if (!mentions || mentions.length === 0) {
    console.log('No mentions to store in database');
    return 0;
  }
  
  const pool = await initializeDb();
  
  try {
    // Create the table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS scraped_mentions (
        id SERIAL PRIMARY KEY,
        symbol VARCHAR(20) NOT NULL,
        type VARCHAR(10) NOT NULL,
        platform VARCHAR(20) NOT NULL,
        content TEXT,
        url TEXT,
        sentiment NUMERIC(4,2),
        scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Insert mentions in batches
    const batchSize = 100;
    let insertedCount = 0;
    
    for (let i = 0; i < mentions.length; i += batchSize) {
      const batch = mentions.slice(i, i + batchSize);
      
      const values = batch.map((_, index) => 
        `($${index * 6 + 1}, $${index * 6 + 2}, $${index * 6 + 3}, $${index * 6 + 4}, $${index * 6 + 5}, $${index * 6 + 6})`
      ).join(', ');
      
      const params = batch.flatMap(mention => [
        mention.symbol,
        mention.type,
        mention.platform,
        mention.content,
        mention.url,
        mention.sentiment
      ]);
      
      const query = `
        INSERT INTO scraped_mentions (symbol, type, platform, content, url, sentiment)
        VALUES ${values}
        ON CONFLICT DO NOTHING
      `;
      
      const result = await pool.query(query, params);
      insertedCount += result.rowCount;
    }
    
    console.log(`Inserted ${insertedCount} mentions into database`);
    return insertedCount;
  } catch (error) {
    console.error('Error storing mentions in database:', error);
    throw error;
  }
}

// Scrape with ScrapeBee
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

// Main Lambda handler
exports.handler = async (event, context) => {
  try {
    console.log('Starting Reddit scraper run');
    context.callbackWaitsForEmptyEventLoop = false;
    
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
    
    // Process each symbol
    let totalMentions = 0;
    
    for (const symbolData of symbols) {
      const { symbol, type } = symbolData;
      
      // Scrape Reddit for the symbol
      const mentions = await scrapeRedditForSymbol(symbol, type);
      
      if (mentions.length > 0) {
        // Store mentions in database
        await storeMentionsInDatabase(mentions);
        totalMentions += mentions.length;
      }
      
      // Delay between symbols to avoid rate limiting
      if (symbols.length > 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    console.log(`Completed processing ${symbols.length} symbols with ${totalMentions} total mentions`);
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        symbolsProcessed: symbols.length,
        totalMentions
      })
    };
  } catch (error) {
    console.error('Error in Reddit scraper Lambda:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  } finally {
    // Close the database connection
    if (pool) await pool.end();
  }
}; 