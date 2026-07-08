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
  let client;
  try {
    console.log('Connecting to database...');
    client = await pool.connect();
    console.log('Connected successfully');
    
    // Check if table exists
    console.log('Checking if campaigns_accounts table exists...');
    const existsResult = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'campaigns_accounts'
      )
    `);
    
    const tableExists = existsResult.rows[0].exists;
    console.log(`Table exists: ${tableExists}`);
    
    if (!tableExists) {
      console.log('The campaigns_accounts table does not exist.');
      return;
    }
    
    // Check table structure before deleting
    const structureResult = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'campaigns_accounts'
    `);
    
    console.log('Table structure before deletion:');
    console.log(structureResult.rows);
    
    // Check for data
    const countResult = await client.query('SELECT COUNT(*) FROM campaigns_accounts');
    console.log(`Table contains ${countResult.rows[0].count} rows`);
    
    // Delete the table
    try {
      console.log('Attempting to drop table...');
      await client.query('DROP TABLE campaigns_accounts');
      console.log('campaigns_accounts table has been successfully deleted.');
    } catch (dropError) {
      console.error('Error dropping table:', dropError.message);
      
      if (dropError.message.includes('cannot drop')) {
        console.log('Cannot drop table directly due to constraints. Attempting to drop with CASCADE...');
        await client.query('DROP TABLE campaigns_accounts CASCADE');
        console.log('campaigns_accounts table has been successfully deleted with CASCADE.');
      } else {
        throw dropError;
      }
    }
    
    // Verify deletion
    const verifyResult = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'campaigns_accounts'
      )
    `);
    
    const stillExists = verifyResult.rows[0].exists;
    if (!stillExists) {
      console.log('Verified: Table has been successfully deleted.');
    } else {
      console.log('Warning: Table still exists after deletion attempt.');
    }
    
  } catch (err) {
    console.error('Error:', err.message);
    console.error('Error stack:', err.stack);
  } finally {
    if (client) {
      client.release();
    }
    console.log('Closing database connection...');
    await pool.end();
    console.log('Done.');
  }
}

// Execute the function
deleteTable(); 