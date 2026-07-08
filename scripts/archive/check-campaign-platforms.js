const { Pool } = require('pg');
const pool = new Pool({
  user: 'postgres',
  host: 'oracle-db.cyruxuioaadm.us-east-1.rds.amazonaws.com',
  database: 'oracle',
  password: 'QnEv5TgRxC3LbH7Wd9Kp',
  port: 5432,
  ssl: { rejectUnauthorized: false }
});

async function checkTable() {
  try {
    console.log('Connecting to database...');
    
    // Check if table exists
    console.log('Checking if campaign_platforms table exists...');
    const existsResult = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'campaign_platforms'
      )
    `);
    
    console.log('Exists result:', existsResult.rows);
    const tableExists = existsResult.rows[0].exists;
    
    if (!tableExists) {
      console.log('The campaign_platforms table does not exist.');
      return;
    }
    
    // Get table structure
    console.log('Getting table structure...');
    const structureResult = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'campaign_platforms'
    `);
    
    console.log('Campaign platforms table structure:');
    console.log(structureResult.rows);
    
    // Check for foreign key constraints
    console.log('Checking foreign key constraints...');
    const constraintResult = await pool.query(`
      SELECT tc.constraint_name, tc.table_name, kcu.column_name, 
             ccu.table_name AS foreign_table_name,
             ccu.column_name AS foreign_column_name 
      FROM information_schema.table_constraints AS tc 
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage AS ccu 
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND
            (tc.table_name = 'campaign_platforms' OR ccu.table_name = 'campaign_platforms')
    `);
    
    console.log('\nForeign key constraints:');
    console.log(constraintResult.rows);
    
    // Get data
    console.log('Getting data...');
    const dataResult = await pool.query('SELECT * FROM campaign_platforms LIMIT 10');
    console.log('\nCampaign platforms data (up to 10 rows):');
    console.log(dataResult.rows);
    
    // Count total rows
    console.log('Counting rows...');
    const countResult = await pool.query('SELECT COUNT(*) FROM campaign_platforms');
    console.log(`\nTotal rows: ${countResult.rows[0].count}`);
    
  } catch (err) {
    console.error('Error:', err.message);
    console.error('Error stack:', err.stack);
  } finally {
    console.log('Closing database connection...');
    await pool.end();
    console.log('Done.');
  }
}

console.log('Starting check...');
checkTable(); 