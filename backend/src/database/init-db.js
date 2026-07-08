const fs = require('fs');
const path = require('path');
const pool = require('../services/db');

// Read the SQL file
const sql = fs.readFileSync(path.join(__dirname, 'create-tables.sql'), 'utf8');

async function initDb() {
  try {
    console.log('Initializing database tables...');
    await pool.query(sql);
    console.log('Database tables created successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
  } finally {
    // Don't end the pool if it's used elsewhere in the application
    // pool.end();
  }
}

// Run init if executed directly
if (require.main === module) {
  initDb().catch(console.error);
}

module.exports = initDb;