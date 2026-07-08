const { Pool } = require('pg');
const pool = new Pool({
  user: 'postgres',
  host: 'oracle-db.cyruxuioaadm.us-east-1.rds.amazonaws.com',
  database: 'oracle',
  password: 'QnEv5TgRxC3LbH7Wd9Kp',
  port: 5432,
  ssl: { rejectUnauthorized: false }
});

async function deleteTable() {
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
    
    const tableExists = existsResult.rows[0].exists;
    
    if (!tableExists) {
      console.log('The campaign_platforms table does not exist.');
      return;
    }
    
    console.log('campaign_platforms table exists, proceeding with deletion...');
    
    // Delete the table
    try {
      await pool.query('DROP TABLE campaign_platforms');
      console.log('campaign_platforms table has been successfully deleted.');
    } catch (dropError) {
      if (dropError.message.includes('cannot drop')) {
        console.log('Cannot drop table directly due to constraints. Attempting to drop with CASCADE...');
        await pool.query('DROP TABLE campaign_platforms CASCADE');
        console.log('campaign_platforms table has been successfully deleted with CASCADE.');
      } else {
        throw dropError;
      }
    }
  } catch (err) {
    console.error('Error:', err.message);
    console.error('Error stack:', err.stack);
  } finally {
    console.log('Closing database connection...');
    await pool.end();
    console.log('Done.');
  }
}

console.log('Starting deletion process...');
deleteTable(); 