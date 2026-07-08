const { Pool } = require('pg');

async function main() {
  console.log('Starting basic sessions check...');
  
  const pool = new Pool({
    user: 'postgres',
    host: 'oracle-db.cyruxuioaadm.us-east-1.rds.amazonaws.com',
    database: 'oracle',
    password: 'QnEv5TgRxC3LbH7Wd9Kp',
    port: 5432,
    ssl: { rejectUnauthorized: false }
  });
  
  try {
    // Simple count of sessions with future expiry
    const futureCount = await pool.query(`
      SELECT COUNT(*) as count
      FROM sessions 
      WHERE expires_at > NOW()
    `);
    
    console.log(`Sessions with future expiry: ${futureCount.rows[0].count}`);
    
    // Max expiry date
    const maxExpiry = await pool.query(`
      SELECT MAX(expires_at) as max_date
      FROM sessions
    `);
    
    console.log(`Latest expiry date: ${maxExpiry.rows[0].max_date}`);
    
    // Current date on the server
    const currentDate = await pool.query(`SELECT NOW() as current_date`);
    console.log(`Current date on server: ${currentDate.rows[0].current_date}`);
    
    // Years difference calculation for the furthest expiry
    const yearsDiff = await pool.query(`
      SELECT EXTRACT(YEAR FROM MAX(expires_at)) - EXTRACT(YEAR FROM NOW()) as years_diff
      FROM sessions
    `);
    
    console.log(`Years into the future for furthest expiry: ${yearsDiff.rows[0].years_diff}`);
    
    // Sample of sessions with expiry more than 1 year in the future
    const longSessions = await pool.query(`
      SELECT id, user_id, expires_at, created_at
      FROM sessions
      WHERE expires_at > NOW() + INTERVAL '1 year'
      ORDER BY expires_at DESC
      LIMIT 5
    `);
    
    if (longSessions.rows.length > 0) {
      console.log('\nSessions with expiry more than 1 year in the future:');
      longSessions.rows.forEach(row => {
        console.log(`ID: ${row.id}, User: ${row.user_id}, Created: ${row.created_at}, Expires: ${row.expires_at}`);
      });
    }
    
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
    console.log('Done.');
  }
}

main(); 