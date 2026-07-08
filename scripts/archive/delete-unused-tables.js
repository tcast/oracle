const { Pool } = require('pg');

async function main() {
  console.log('Starting table deletion process...');
  
  const pool = new Pool({
    user: 'postgres',
    host: 'oracle-db.cyruxuioaadm.us-east-1.rds.amazonaws.com',
    database: 'oracle',
    password: 'QnEv5TgRxC3LbH7Wd9Kp',
    port: 5432,
    ssl: { rejectUnauthorized: false }
  });
  
  console.log('Pool created');
  
  try {
    console.log('Testing connection...');
    const testResult = await pool.query('SELECT NOW()');
    console.log('Connection successful, current time:', testResult.rows[0].now);
    
    // Tables to delete
    const tablesToDelete = [
      'campaign_accounts',
      'subreddit_styles'
    ];
    
    for (const tableName of tablesToDelete) {
      // Check if table exists
      console.log(`\nChecking if ${tableName} table exists...`);
      const existsResult = await pool.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_name = $1
        )
      `, [tableName]);
      
      if (!existsResult.rows[0].exists) {
        console.log(`Table '${tableName}' does not exist, skipping.`);
        continue;
      }
      
      console.log(`Table '${tableName}' exists, proceeding with deletion...`);
      
      // Get row count before deletion
      const countResult = await pool.query(`SELECT COUNT(*) FROM "${tableName}"`);
      console.log(`Table '${tableName}' contains ${countResult.rows[0].count} rows`);
      
      // Delete the table
      try {
        console.log(`Attempting to drop table '${tableName}'...`);
        await pool.query(`DROP TABLE "${tableName}"`);
        console.log(`Table '${tableName}' has been successfully deleted.`);
      } catch (dropError) {
        console.error(`Error dropping table '${tableName}':`, dropError.message);
        
        if (dropError.message.includes('cannot drop')) {
          console.log(`Cannot drop table directly due to constraints. Attempting to drop with CASCADE...`);
          await pool.query(`DROP TABLE "${tableName}" CASCADE`);
          console.log(`Table '${tableName}' has been successfully deleted with CASCADE.`);
        } else {
          throw dropError;
        }
      }
      
      // Verify deletion
      const verifyResult = await pool.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_name = $1
        )
      `, [tableName]);
      
      const stillExists = verifyResult.rows[0].exists;
      if (!stillExists) {
        console.log(`Verified: Table '${tableName}' has been successfully deleted.`);
      } else {
        console.log(`Warning: Table '${tableName}' still exists after deletion attempt.`);
      }
    }
    
  } catch (err) {
    console.error('Error during database operations:', err);
  } finally {
    console.log('\nClosing pool...');
    await pool.end();
    console.log('Done.');
  }
}

main().catch(err => {
  console.error('Unhandled error in main:', err);
}); 