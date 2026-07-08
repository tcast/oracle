const { Pool } = require('pg');
const pool = new Pool({
  user: 'postgres',
  host: 'oracle-db.cyruxuioaadm.us-east-1.rds.amazonaws.com',
  database: 'oracle',
  password: 'QnEv5TgRxC3LbH7Wd9Kp',
  port: 5432,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  try {
    console.log('Checking if campaigns_accounts table exists...');
    const res = await pool.query("SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'campaigns_accounts')");
    console.log(`Table exists: ${res.rows[0].exists}`);
    
    if (res.rows[0].exists) {
      // Table exists, get more info
      const tableInfo = await pool.query("SELECT * FROM information_schema.columns WHERE table_name = 'campaigns_accounts'");
      console.log("Table structure:", tableInfo.rows);
    }
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
})(); 