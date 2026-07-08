/**
 * Test script for historical performance data
 * 
 * This script tests the historical performance data generation and adds sample data to the database.
 */

// Import the database pool and service
const pool = require('./services/db');
const investmentScreenerService = require('./services/investmentScreenerService');

/**
 * Add sample historical data to the database for testing
 */
async function addSampleHistoricalData() {
  try {
    console.log('Adding sample historical data...');
    
    // Sample stocks and crypto to add data for
    const assets = [
      { symbol: 'AAPL', type: 'stock' },
      { symbol: 'MSFT', type: 'stock' },
      { symbol: 'GOOGL', type: 'stock' },
      { symbol: 'AMZN', type: 'stock' },
      { symbol: 'TSLA', type: 'stock' },
      { symbol: 'NVDA', type: 'stock' },
      { symbol: 'META', type: 'stock' },
      { symbol: 'PLTR', type: 'stock' },
      { symbol: 'BTC', type: 'crypto' },
      { symbol: 'ETH', type: 'crypto' }
    ];
    
    // Sample dates (going back about 6 months)
    const dates = [
      new Date('2025-03-05'),
      new Date('2025-02-15'),
      new Date('2025-01-28'),
      new Date('2025-01-10'),
      new Date('2024-12-23'),
      new Date('2024-12-05'),
      new Date('2024-11-17'),
      new Date('2024-10-30'),
      new Date('2024-10-12'),
      new Date('2024-09-24')
    ];
    
    // Check if the table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'investment_screener_results'
      )
    `);
    
    if (!tableCheck.rows[0].exists) {
      // Create the table if it doesn't exist
      await pool.query(`
        CREATE TABLE investment_screener_results (
          id SERIAL PRIMARY KEY,
          symbol VARCHAR(10) NOT NULL,
          asset_type VARCHAR(10) NOT NULL,
          sentiment_score DECIMAL(4,1) NOT NULL,
          news_sentiment DECIMAL(4,1),
          social_sentiment DECIMAL(4,1),
          upward_probability INTEGER NOT NULL,
          downward_probability INTEGER NOT NULL,
          sideways_probability INTEGER NOT NULL,
          explanation TEXT,
          key_factors TEXT,
          social_data JSONB,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          news_count INTEGER,
          social_mentions_count INTEGER
        )
      `);
    } else {
      // Check if news_count and social_mentions_count columns exist
      const columnCheck = await pool.query(`
        SELECT 
          COUNT(*) as count
        FROM 
          information_schema.columns 
        WHERE 
          table_name = 'investment_screener_results' AND 
          column_name IN ('news_count', 'social_mentions_count')
      `);
      
      // If columns don't exist, add them
      if (parseInt(columnCheck.rows[0].count) < 2) {
        console.log('Adding missing columns to investment_screener_results table...');
        
        try {
          await pool.query(`
            ALTER TABLE investment_screener_results 
            ADD COLUMN IF NOT EXISTS news_count INTEGER,
            ADD COLUMN IF NOT EXISTS social_mentions_count INTEGER
          `);
          console.log('Columns added successfully');
        } catch (error) {
          console.error('Error adding columns:', error);
        }
      }
    }
    
    // Add sample data for each asset
    for (const asset of assets) {
      for (const date of dates) {
        // Generate random sentiment scores
        const newsSentiment = (Math.random() * 6 + 4).toFixed(1); // Between 4.0 and 10.0
        const socialSentiment = (Math.random() * 6 + 4).toFixed(1);
        const overallSentiment = ((parseFloat(newsSentiment) * 0.6 + parseFloat(socialSentiment) * 0.4)).toFixed(1);
        
        // Generate random probabilities that sum to 100
        let upwardProb = Math.floor(Math.random() * 60) + 20; // Between 20 and 80
        let downwardProb = Math.floor(Math.random() * (100 - upwardProb - 10)) + 5; // At least 5
        let sidewaysProb = 100 - upwardProb - downwardProb;
        
        // Generate random key factors
        const keyFactorsArray = [
          `Strong ${asset.type === 'stock' ? 'quarterly earnings' : 'market adoption'}`,
          `Positive analyst coverage`,
          `Increasing social media mentions`,
          `New product announcements`,
          `Technical indicators show bullish pattern`
        ].slice(0, Math.floor(Math.random() * 3) + 2);
        
        // Convert to JSON string
        const keyFactors = JSON.stringify(keyFactorsArray);
        
        // Generate random social data
        const socialData = JSON.stringify([
          {
            platform: 'Twitter',
            count: Math.floor(Math.random() * 1000) + 100,
            sentiment: Math.random() > 0.5 ? 'positive' : 'negative',
            trending: Math.random() > 0.7
          },
          {
            platform: 'Reddit',
            count: Math.floor(Math.random() * 500) + 50,
            sentiment: Math.random() > 0.5 ? 'positive' : 'negative',
            trending: Math.random() > 0.8,
            subreddits: ['investing', 'stocks', 'wallstreetbets'].slice(0, Math.floor(Math.random() * 3) + 1)
          }
        ]);
        
        try {
          // Insert the data with news_count and social_mentions_count
          await pool.query(`
            INSERT INTO investment_screener_results 
            (symbol, asset_type, sentiment_score, news_sentiment, social_sentiment, 
             upward_probability, downward_probability, sideways_probability, 
             explanation, key_factors, social_data, created_at, news_count, social_mentions_count)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          `, [
            asset.symbol,
            asset.type,
            overallSentiment,
            newsSentiment,
            socialSentiment,
            upwardProb,
            downwardProb,
            sidewaysProb,
            `Based on our analysis of recent news and social media sentiment, ${asset.symbol} shows ${overallSentiment > 7 ? 'strong positive' : overallSentiment > 5 ? 'moderate positive' : 'neutral'} indicators.`,
            keyFactors,
            socialData,
            date.toISOString(),
            Math.floor(Math.random() * 50) + 10,
            Math.floor(Math.random() * 1000) + 100
          ]);
        } catch (error) {
          // If error is about missing columns, try without those columns
          if (error.code === '42703') { // Column does not exist
            console.log(`Falling back to insert without news_count and social_mentions_count for ${asset.symbol}`);
            await pool.query(`
              INSERT INTO investment_screener_results 
              (symbol, asset_type, sentiment_score, news_sentiment, social_sentiment, 
               upward_probability, downward_probability, sideways_probability, 
               explanation, key_factors, social_data, created_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            `, [
              asset.symbol,
              asset.type,
              overallSentiment,
              newsSentiment,
              socialSentiment,
              upwardProb,
              downwardProb,
              sidewaysProb,
              `Based on our analysis of recent news and social media sentiment, ${asset.symbol} shows ${overallSentiment > 7 ? 'strong positive' : overallSentiment > 5 ? 'moderate positive' : 'neutral'} indicators.`,
              keyFactors,
              socialData,
              date.toISOString()
            ]);
          } else {
            throw error; // Re-throw if it's a different error
          }
        }
        
        console.log(`Added historical entry for ${asset.symbol} (${asset.type}) on ${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`);
      }
    }
    
    console.log('Sample historical data added successfully!');
  } catch (error) {
    console.error('Error adding sample data:', error);
  }
}

/**
 * Test the historical performance data for various assets
 */
async function testHistoricalPerformance() {
  try {
    console.log('Testing historical performance data...\n');
    
    // Sample assets to test
    const assets = [
      { symbol: 'AAPL', type: 'stock' },
      { symbol: 'MSFT', type: 'stock' },
      { symbol: 'GOOGL', type: 'stock' },
      { symbol: 'AMZN', type: 'stock' },
      { symbol: 'TSLA', type: 'stock' },
      { symbol: 'NVDA', type: 'stock' },
      { symbol: 'META', type: 'stock' },
      { symbol: 'PLTR', type: 'stock' },
      { symbol: 'BTC', type: 'crypto' },
      { symbol: 'ETH', type: 'crypto' }
    ];
    
    // Test each asset
    for (const asset of assets) {
      console.log(`\nTesting ${asset.symbol} (${asset.type})...`);
      
      const performance = await investmentScreenerService.getHistoricalPerformance(asset.symbol, asset.type, 6);
      
      console.log(`Total predictions: ${performance.totalPredictions}`);
      console.log(`Accuracy rate: ${performance.accuracyRate}%`);
      console.log(`Is mock data: ${performance.isMockData ? 'Yes' : 'No'}`);
      console.log(`Data points: ${performance.data.length}`);
      
      if (performance.data.length > 0) {
        console.log('Sample data point:');
        console.log(JSON.stringify(performance.data[0], null, 2));
        
        // Count how many predictions were enhanced with historical news/social data
        const enhancedCount = performance.data.filter(item => 
          item.news_data_count > 0 || item.social_data_count > 0
        ).length;
        
        if (enhancedCount > 0) {
          console.log(`Enhanced predictions: ${enhancedCount}/${performance.data.length} (${((enhancedCount/performance.data.length)*100).toFixed(1)}%)`);
        }
      }
    }
    
    console.log('\nHistorical performance testing completed!');
  } catch (error) {
    console.error('Error testing historical performance:', error);
  }
}

/**
 * Run all tests
 */
async function runTests() {
  try {
    // Add sample data
    await addSampleHistoricalData();
    
    // Test historical performance
    await testHistoricalPerformance();
    
    // Close the database connection
    await pool.end();
  } catch (error) {
    console.error('Error running tests:', error);
    process.exit(1);
  }
}

// Run the tests
runTests(); 