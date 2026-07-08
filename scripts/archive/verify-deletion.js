const { Pool } = require('pg');

async function main() {
  console.log('Starting verification process...');
  
  const pool = new Pool({
    user: 'postgres',
    host: 'oracle-db.cyruxuioaadm.us-east-1.rds.amazonaws.com',
    database: 'oracle',
    password: 'QnEv5TgRxC3LbH7Wd9Kp',
    port: 5432,
    ssl: { rejectUnauthorized: false }
  });
  
  try {
    console.log('Connected to database, retrieving tables list...');
    
    // Get all tables
    const result = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    
    console.log('\nCurrent tables in database:');
    result.rows.forEach(row => {
      console.log(`- ${row.table_name}`);
    });
    
    // Check specific tables
    const tablesToCheck = ['campaign_accounts', 'subreddit_styles'];
    
    console.log('\nVerifying deleted tables:');
    for (const table of tablesToCheck) {
      const existsResult = await pool.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_name = $1
        )
      `, [table]);
      
      if (existsResult.rows[0].exists) {
        console.log(`❌ Table '${table}' still exists!`);
      } else {
        console.log(`✅ Table '${table}' has been successfully deleted.`);
      }
    }
  } catch (err) {
    console.error('Error during verification:', err);
  } finally {
    await pool.end();
    console.log('\nVerification complete.');
  }
}

main(); 