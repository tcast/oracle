const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

// Force reload environment variables to make sure we have the latest values
const dotenv = require('dotenv');
const envPath = path.resolve(__dirname, '../../.env');

// Load .env file explicitly from the correct path
if (fs.existsSync(envPath)) {
  console.log(`✓ Loading environment variables from: ${envPath}`);
  const result = dotenv.config({ path: envPath });
  if (result.error) {
    console.error(`❌ Error loading .env file: ${result.error.message}`);
  }
} else {
  console.error(`❌ .env file not found at: ${envPath}`);
}

// Database configuration from environment variables
const DB_CONFIG = {
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'oracle',
  useSSL: process.env.DB_SSL === 'true'
};

console.log('📊 DATABASE CONNECTION CONFIGURATION:');
console.log(`- DB_USER: ${DB_CONFIG.user}`);
console.log(`- DB_HOST: ${DB_CONFIG.host}`);
console.log(`- DB_NAME: ${DB_CONFIG.database}`);
console.log(`- DB_PORT: ${DB_CONFIG.port}`);
console.log(`- DB_SSL: ${DB_CONFIG.useSSL}`);

const connectionType = DB_CONFIG.host.includes('amazonaws.com') ? 'RDS' : 'Local';
console.log(`🔒 Connecting to ${connectionType} database...`);

// Create pool with SSL enabled if required
const createPool = (ssl) => new Pool({
  user: DB_CONFIG.user,
  password: DB_CONFIG.password,
  host: DB_CONFIG.host,
  port: DB_CONFIG.port,
  database: DB_CONFIG.database,
  ssl: ssl ? {
    rejectUnauthorized: false // This allows self-signed certificates
  } : false,
});

// Create the initial pool based on settings
let pool = createPool(DB_CONFIG.useSSL);

// Log any connection errors
pool.on('error', (err) => {
  console.error('💥 Unexpected database connection error:', err);
});

// Test the connection and try without SSL if it fails with SSL
(async () => {
  try {
    // Try connecting with the current settings
    const client = await pool.connect();
    console.log(`✅ Database connection successful at ${DB_CONFIG.host} with SSL ${DB_CONFIG.useSSL ? 'enabled' : 'disabled'}`);
    client.release();
  } catch (err) {
    console.error(`❌ Database connection test failed: ${err.message}`);
    
    // If SSL is enabled and the connection failed, try without SSL
    if (DB_CONFIG.useSSL && (err.message.includes('SSL') || err.message.includes('ssl'))) {
      console.log('⚠️ SSL connection failed. Falling back to non-SSL connection...');
      
      // Create a new pool without SSL
      pool = createPool(false);
      
      try {
        // Test the non-SSL connection
        const client = await pool.connect();
        console.log(`✅ Database connection successful at ${DB_CONFIG.host} with SSL disabled (fallback mode)`);
        client.release();
      } catch (fallbackErr) {
        console.error(`❌ Database connection also failed without SSL: ${fallbackErr.message}`);
      }
    }
  }
})();

module.exports = pool;