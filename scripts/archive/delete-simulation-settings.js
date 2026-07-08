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
    // First check if the table exists
    const checkResult = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'simulation_settings'
      )
    `);
    
    const tableExists = checkResult.rows[0].exists;
    
    if (tableExists) {
      console.log('simulation_settings table exists, proceeding with deletion...');
      
      // Drop the table
      await pool.query('DROP TABLE simulation_settings');
      console.log('simulation_settings table has been successfully deleted.');
    } else {
      console.log('simulation_settings table does not exist.');
    }
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    pool.end();
  }
}

deleteTable(); 