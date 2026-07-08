const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Database configuration
const dbConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: { 
        require: true, 
        rejectUnauthorized: false 
      }
    }
  : {
      user: process.env.DB_USER,
      host: process.env.DB_HOST,
      database: process.env.DB_NAME,
      password: process.env.DB_PASSWORD,
      port: process.env.DB_PORT,
      ssl: process.env.DB_SSL === 'true' ? {
        require: true,
        rejectUnauthorized: false
      } : false
    };

const pool = new Pool(dbConfig);

async function runMigration() {
  const client = await pool.connect();
  
  try {
    // Read the migration file
    const migrationPath = path.join(__dirname, '..', '..', 'database', 'migrations', '020_add_proxy_config.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    
    console.log('Running proxy_config migration...');
    
    // Start a transaction
    await client.query('BEGIN');
    
    // Run the migration
    await client.query(sql);
    
    // Commit the transaction
    await client.query('COMMIT');
    
    console.log('✅ Proxy config migration completed successfully');
    
    // Verify the column was added
    const result = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'social_accounts' 
      AND column_name = 'proxy_config'
    `);
    
    if (result.rows.length > 0) {
      console.log('✅ Verified: proxy_config column exists in social_accounts table');
    }
    
  } catch (error) {
    // Rollback the transaction on error
    await client.query('ROLLBACK');
    console.error('❌ Error running migration:', error);
  } finally {
    // Release the client
    client.release();
    
    // Close the pool
    await pool.end();
  }
}

// Run the migration
runMigration();
