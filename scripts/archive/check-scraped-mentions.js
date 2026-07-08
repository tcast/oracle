const { Pool } = require('pg');

async function main() {
  console.log('Checking scraped_mentions table...');
  
  const pool = new Pool({
    user: 'postgres',
    host: 'oracle-db.cyruxuioaadm.us-east-1.rds.amazonaws.com',
    database: 'oracle',
    password: 'QnEv5TgRxC3LbH7Wd9Kp',
    port: 5432,
    ssl: { rejectUnauthorized: false }
  });
  
  try {
    // Check if table exists
    const tableExistsResult = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'scraped_mentions'
      )
    `);
    
    const tableExists = tableExistsResult.rows[0].exists;
    console.log(`Table exists: ${tableExists}`);
    
    if (!tableExists) {
      console.log('The scraped_mentions table does not exist');
      return;
    }
    
    // Get table structure
    const structureResult = await pool.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'scraped_mentions'
      ORDER BY ordinal_position
    `);
    
    console.log('\nTable structure:');
    structureResult.rows.forEach(column => {
      console.log(`- ${column.column_name} (${column.data_type}, ${column.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}${column.column_default ? `, default: ${column.column_default}` : ''})`);
    });
    
    // Count rows
    const countResult = await pool.query('SELECT COUNT(*) FROM scraped_mentions');
    console.log(`\nTotal rows: ${countResult.rows[0].count}`);
    
    // Get latest 5 records
    const latestResult = await pool.query(`
      SELECT * FROM scraped_mentions
      ORDER BY id DESC
      LIMIT 5
    `);
    
    console.log('\nLatest records:');
    latestResult.rows.forEach(row => {
      console.log(row);
    });
    
    // Check for records in the last day
    const recentResult = await pool.query(`
      SELECT COUNT(*) 
      FROM scraped_mentions 
      WHERE scraped_at > NOW() - INTERVAL '1 day'
    `);
    
    console.log(`\nRecords in the last 24 hours: ${recentResult.rows[0].count}`);
    
    // Check platforms distribution
    const platformsResult = await pool.query(`
      SELECT platform, COUNT(*) 
      FROM scraped_mentions 
      GROUP BY platform
      ORDER BY COUNT(*) DESC
    `);
    
    console.log('\nRecords by platform:');
    platformsResult.rows.forEach(row => {
      console.log(`- ${row.platform}: ${row.count}`);
    });
    
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
    console.log('\nDone.');
  }
}

main(); 