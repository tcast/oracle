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
    console.log('Checking if campaigns_accounts table exists...');
    const existsResult = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'campaigns_accounts'
      )
    `);
    
    console.log('Exists result:', existsResult.rows);
    const tableExists = existsResult.rows[0].exists;
    
    if (!tableExists) {
      console.log('The campaigns_accounts table does not exist.');
      return;
    }
    
    // Get table structure
    console.log('Getting table structure...');
    const structureResult = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'campaigns_accounts'
    `);
    
    console.log('Campaigns accounts table structure:');
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
            (tc.table_name = 'campaigns_accounts' OR ccu.table_name = 'campaigns_accounts')
    `);
    
    console.log('\nForeign key constraints:');
    console.log(constraintResult.rows);
    
    // Get data
    console.log('Getting data...');
    const dataResult = await pool.query('SELECT * FROM campaigns_accounts LIMIT 10');
    console.log('\nCampaigns accounts data (up to 10 rows):');
    console.log(dataResult.rows);
    
    // Count total rows
    console.log('Counting rows...');
    const countResult = await pool.query('SELECT COUNT(*) FROM campaigns_accounts');
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