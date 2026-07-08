const { Pool } = require('pg');
const axios = require('axios');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

// Initialize SNS client
const sns = new SNSClient();

// Database connection pool
let pool = null;

// Environment variables
const scrapeBeeApiKey = process.env.SCRAPEBEE_API_KEY;
const scrapeBeeApiDomain = 'app.scrapingbee.com'; // Default domain

// Initialize the database connection
const initializeDb = async () => {
  if (!pool) {
    console.log('Initializing database connection...');
    try {
      pool = new Pool({
        user: process.env.DB_USER || 'postgres',
        host: process.env.DB_HOST || 'localhost',
        database: process.env.DB_NAME || 'oracle',
        password: process.env.DB_PASSWORD,
        port: 5432,
        ssl: {
          rejectUnauthorized: false
        }
      });
      
      // Test connection
      const client = await pool.connect();
      const result = await client.query('SELECT NOW()');
      console.log(`Database connection successful, server time: ${result.rows[0].now}`);
      client.release();
      
      // Print environment variables (redacted)
      console.log('Environment variables:');
      console.log(`- DB_HOST: ${process.env.DB_HOST || 'not set'}`);
      console.log(`- DB_NAME: ${process.env.DB_NAME || 'not set'}`);
      console.log(`- DB_USER: ${process.env.DB_USER || 'not set'}`);
      console.log(`- DB_PASSWORD: ${process.env.DB_PASSWORD ? '[REDACTED]' : 'not set'}`);
      console.log(`- SCRAPEBEE_API_KEY: ${scrapeBeeApiKey ? '[REDACTED]' : 'not set'}`);
    } catch (error) {
      console.error('Database connection error:', error.message);
      throw error;
    }
  }
  return pool;
};

// Scrape Reddit for a symbol
async function scrapeRedditForSymbol(symbol, type = 'stock') {
  console.log(`Scraping Reddit for ${symbol} (${type})`);
  
  // List of subreddits to check
  let subreddits = [];
  
  if (type === 'stock') {
    subreddits = ['wallstreetbets', 'stocks', 'investing', 'stockmarket'];
    if (symbol.length <= 4) {
      // Only include ticker-specific subreddits for shorter symbols (likely real tickers)
      subreddits.push(`${symbol.toLowerCase()}_stock`, `${symbol.toLowerCase()}stock`);
    }
  } else if (type === 'crypto') {
    subreddits = ['cryptocurrency', 'cryptomarkets', 'crypto_general'];
    if (symbol.length <= 5) {
      // For cryptocurrencies, add symbol-specific subreddits
      subreddits.push(symbol.toLowerCase(), `${symbol.toLowerCase()}coin`);
    }
  }
  
  const mentions = [];
  
  // Process each subreddit
  for (const subreddit of subreddits) {
    try {
      console.log(`Checking subreddit: r/${subreddit} for ${symbol}`);
      
      // Use ScrapeBee to scrape the subreddit
      const url = `https://www.reddit.com/r/${subreddit}/search/?q=${symbol}&restrict_sr=1&sr_nsfw=`;
      
      const response = await scrapeWithScrapeBee(url, {
        render_js: true,
        premium_proxy: true,
        country_code: 'us'
      });
      
      if (!response || !response.html) {
        console.log(`No data returned for ${symbol} from r/${subreddit}`);
        continue;
      }
      
      const html = response.html;
      
      // Extract posts that mention the symbol
      // Very simple extraction for demonstration
      const titleRegex = new RegExp(`<h3[^>]*>(.*?${symbol}.*?)</h3>`, 'gi');
      const linkRegex = /href="(\/r\/[^"]+)"/gi;
      
      let match;
      const seen = new Set();
      
      console.log(`Extracting mentions from r/${subreddit} HTML...`);
      
      while ((match = titleRegex.exec(html)) !== null) {
        const title = match[1].replace(/<[^>]*>/g, ' ').trim();
        
        if (seen.has(title)) continue;
        seen.add(title);
        
        // Find the post URL
        let url = '';
        linkRegex.lastIndex = match.index;
        const linkMatch = linkRegex.exec(html);
        if (linkMatch) {
          url = `https://www.reddit.com${linkMatch[1]}`;
        }
        
        // Calculate sentiment
        const sentiment = calculateSentiment(title);
        
        console.log(`Found mention in r/${subreddit}: "${title.substring(0, 50)}..."`);
        
        mentions.push({
          symbol,
          type,
          platform: 'reddit',
          content: title,
          url,
          sentiment: sentiment.score,
          subreddit
        });
      }
      
      console.log(`Found ${mentions.length} mentions for ${symbol} in r/${subreddit}`);
      
    } catch (error) {
      console.error(`Error scraping r/${subreddit} for ${symbol}:`, error.message);
    }
  }
  
  return mentions;
}

// Simple sentiment analysis
function calculateSentiment(text) {
  const positiveWords = ['buy', 'bull', 'bullish', 'long', 'up', 'upside', 'green', 'moon', 'rocket', 'gain', 'gains'];
  const negativeWords = ['sell', 'bear', 'bearish', 'short', 'down', 'downside', 'red', 'crash', 'tank', 'loss', 'losses'];
  
  const lowerText = text.toLowerCase();
  let score = 0;
  
  for (const word of positiveWords) {
    if (lowerText.includes(word)) score += 1;
  }
  
  for (const word of negativeWords) {
    if (lowerText.includes(word)) score -= 1;
  }
  
  // Normalize between -1 and 1
  if (score !== 0) {
    score = score / Math.max(positiveWords.length, negativeWords.length);
  }
  
  return {
    score: parseFloat(score.toFixed(2)),
    label: score > 0 ? 'positive' : (score < 0 ? 'negative' : 'neutral')
  };
}

// Store mentions in database
async function storeMentionsInDatabase(mentions) {
  if (!mentions || mentions.length === 0) {
    console.log('No mentions to store in database');
    return 0;
  }
  
  try {
    console.log(`Attempting to store ${mentions.length} mentions in database`);
    
    const pool = await initializeDb();
    const client = await pool.connect();
    
    try {
      // Start transaction
      await client.query('BEGIN');
      
      // Check if table exists
      const tableExistsResult = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_name = 'scraped_mentions'
        )
      `);
      
      const tableExists = tableExistsResult.rows[0].exists;
      console.log(`scraped_mentions table exists: ${tableExists}`);
      
      if (!tableExists) {
        // Create the table if it doesn't exist
        console.log('Creating scraped_mentions table...');
        await client.query(`
          CREATE TABLE scraped_mentions (
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
        console.log('Table created successfully');
      } else {
        // Get current schema for logging
        const schemaResult = await client.query(`
          SELECT column_name, data_type 
          FROM information_schema.columns 
          WHERE table_name = 'scraped_mentions'
          ORDER BY ordinal_position
        `);
        
        console.log('Current table schema:');
        schemaResult.rows.forEach(column => {
          console.log(`- ${column.column_name} (${column.data_type})`);
        });
      }
      
      // Insert mentions one by one for better error tracking
      let insertedCount = 0;
      
      for (const mention of mentions) {
        try {
          const query = `
            INSERT INTO scraped_mentions (symbol, type, platform, content, url, sentiment)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id
          `;
          
          const params = [
            mention.symbol,
            mention.type,
            mention.platform,
            mention.content,
            mention.url,
            mention.sentiment
          ];
          
          const result = await client.query(query, params);
          insertedCount++;
          
          if (insertedCount % 10 === 0 || insertedCount === mentions.length) {
            console.log(`Inserted ${insertedCount} of ${mentions.length} mentions`);
          }
        } catch (insertError) {
          console.error(`Error inserting mention for ${mention.symbol}:`, insertError.message);
          // Continue with next mention instead of failing the whole batch
        }
      }
      
      // Commit transaction
      await client.query('COMMIT');
      
      console.log(`Successfully inserted ${insertedCount} of ${mentions.length} mentions`);
      return insertedCount;
    } catch (error) {
      // Rollback on error
      await client.query('ROLLBACK');
      console.error('Error in transaction, rolled back:', error.message);
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error storing mentions in database:', error.message);
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

// Lambda handler
exports.handler = async (event, context) => {
  console.log('Reddit scraper Lambda started');
  console.log('Event:', JSON.stringify(event));
  
  try {
    // Extract symbols from event (direct invocation or SNS)
    let symbols = [];
    
    if (event.Records && event.Records.length > 0) {
      // Processing SNS message
      console.log('Processing SNS message');
      const message = JSON.parse(event.Records[0].Sns.Message);
      if (message.symbols) {
        symbols = message.symbols;
      }
    } else if (event.symbols) {
      // Direct invocation with symbols
      console.log('Processing direct invocation');
      symbols = event.symbols;
    }
    
    if (!symbols || symbols.length === 0) {
      console.log('No symbols provided, exiting');
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No symbols provided' })
      };
    }
    
    console.log(`Processing ${symbols.length} symbols: ${symbols.map(s => s.symbol).join(', ')}`);
    
    // Process each symbol
    let totalMentions = 0;
    let savedMentions = 0;
    
    for (const symbolData of symbols) {
      const { symbol, type } = symbolData;
      
      // Scrape Reddit for the symbol
      const mentions = await scrapeRedditForSymbol(symbol, type);
      
      totalMentions += mentions.length;
      
      if (mentions.length > 0) {
        // Store mentions in database
        try {
          const inserted = await storeMentionsInDatabase(mentions);
          savedMentions += inserted;
        } catch (dbError) {
          console.error(`Failed to store mentions for ${symbol}:`, dbError.message);
        }
      }
      
      // Delay between symbols to avoid rate limiting
      if (symbols.length > 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    console.log(`Completed processing ${symbols.length} symbols`);
    console.log(`Found ${totalMentions} mentions, saved ${savedMentions} to database`);
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        symbolsProcessed: symbols.length,
        totalMentions,
        savedMentions
      })
    };
  } catch (error) {
    console.error('Error in Reddit scraper Lambda:', error);
    console.error('Stack trace:', error.stack);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: error.message,
        stack: error.stack 
      })
    };
  } finally {
    // Close the database connection
    if (pool) {
      console.log('Closing database connection pool');
      await pool.end();
    }
  }
}; 