// Manual script to add a test mention to scraped_mentions table
const { Pool } = require('pg');
require('dotenv').config();

async function main() {
  console.log('=== Adding Test Mention to Database ===');
  
  const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'oracle',
    password: process.env.DB_PASSWORD,
    port: 5432,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
  });
  
  try {
    // Connect to database
    const client = await pool.connect();
    console.log('Connected to database successfully');
    
    // Start transaction
    await client.query('BEGIN');
    
    // Create a test mention
    const testMention = {
      symbol: 'TEST',
      type: 'stock',
      platform: 'manual',
      content: 'This is a manual test mention created at ' + new Date().toISOString(),
      url: 'https://example.com/test',
      sentiment: 0.5
    };
    
    console.log('\nInserting test mention:');
    console.log(JSON.stringify(testMention, null, 2));
    
    // Insert the test mention
    const insertResult = await client.query(`
      INSERT INTO scraped_mentions (symbol, type, platform, content, url, sentiment, scraped_at)
      VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
      RETURNING id, scraped_at
    `, [
      testMention.symbol,
      testMention.type,
      testMention.platform,
      testMention.content,
      testMention.url,
      testMention.sentiment
    ]);
    
    // Get the inserted ID
    const insertedId = insertResult.rows[0].id;
    const scrapedAt = insertResult.rows[0].scraped_at;
    
    console.log(`\nTest mention inserted successfully with ID: ${insertedId}`);
    console.log(`Scraped at: ${scrapedAt}`);
    
    // Verify the insert by retrieving the record
    const verifyResult = await client.query(`
      SELECT * FROM scraped_mentions WHERE id = $1
    `, [insertedId]);
    
    console.log('\nVerified inserted record:');
    console.log(JSON.stringify(verifyResult.rows[0], null, 2));
    
    // Commit the transaction
    await client.query('COMMIT');
    
    // Count total mentions in the table
    const countResult = await client.query(`
      SELECT COUNT(*) FROM scraped_mentions
    `);
    
    console.log(`\nTotal mentions in table: ${countResult.rows[0].count}`);
    
    // Release client
    client.release();
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
  } finally {
    // Close pool
    await pool.end();
    console.log('\nDatabase connection closed');
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
}); 