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
    const result = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'simulation_settings'");
    console.log('Simulation settings table structure:');
    console.log(result.rows);
    
    const data = await pool.query('SELECT * FROM simulation_settings');
    console.log('\nSimulation settings data:');
    console.log(data.rows);
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    pool.end();
  }
}

checkTable(); 