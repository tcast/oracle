const { Pool } = require('pg');

async function main() {
  console.log('Starting sessions table analysis...');
  
  const pool = new Pool({
    user: 'postgres',
    host: 'oracle-db.cyruxuioaadm.us-east-1.rds.amazonaws.com',
    database: 'oracle',
    password: 'QnEv5TgRxC3LbH7Wd9Kp',
    port: 5432,
    ssl: { rejectUnauthorized: false }
  });
  
  try {
    console.log('Connected to database');
    
    // Check table structure
    console.log('\nSessions table structure:');
    const structureResult = await pool.query(`
      SELECT column_name, data_type, character_maximum_length 
      FROM information_schema.columns 
      WHERE table_name = 'sessions'
      ORDER BY ordinal_position
    `);
    
    structureResult.rows.forEach(column => {
      console.log(`- ${column.column_name} (${column.data_type}${column.character_maximum_length ? `(${column.character_maximum_length})` : ''})`);
    });
    
    // Get row count
    const countResult = await pool.query('SELECT COUNT(*) FROM sessions');
    console.log(`\nSessions table contains ${countResult.rows[0].count} rows`);
    
    // Check for future dates
    console.log('\nChecking for dates in the future:');
    const futureResult = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'sessions' 
        AND data_type IN ('timestamp with time zone', 'timestamp without time zone', 'date')
    `);
    
    const dateColumns = futureResult.rows.map(row => row.column_name);
    console.log(`Date columns found: ${dateColumns.join(', ')}`);
    
    for (const column of dateColumns) {
      const futureDatesResult = await pool.query(`
        SELECT COUNT(*) as future_count 
        FROM sessions 
        WHERE ${column} > NOW()
      `);
      
      console.log(`Column '${column}' has ${futureDatesResult.rows[0].future_count} dates in the future`);
      
      if (futureDatesResult.rows[0].future_count > 0) {
        // Get a sample of future dates
        const samplesResult = await pool.query(`
          SELECT sid, ${column} 
          FROM sessions 
          WHERE ${column} > NOW()
          ORDER BY ${column} ASC
          LIMIT 5
        `);
        
        console.log(`Sample future dates in '${column}':`);
        samplesResult.rows.forEach(row => {
          console.log(`  Session ID: ${row.sid}, Date: ${row[column]}`);
        });
      }
    }
    
    // Check if the table is used for Express sessions
    console.log('\nChecking if this appears to be an Express sessions table:');
    const sessionDataResult = await pool.query(`
      SELECT COUNT(*) 
      FROM information_schema.columns 
      WHERE table_name = 'sessions' 
        AND column_name IN ('sid', 'sess', 'expire')
    `);
    
    if (sessionDataResult.rows[0].count >= 3) {
      console.log('This appears to be an Express/Connect session store table');
      
      // Sample the latest sessions
      const latestSessionsResult = await pool.query(`
        SELECT sid, expire 
        FROM sessions 
        ORDER BY expire DESC 
        LIMIT 5
      `);
      
      console.log('\nLatest sessions:');
      latestSessionsResult.rows.forEach(row => {
        const isPast = new Date(row.expire) < new Date();
        console.log(`  Session ID: ${row.sid.substring(0, 20)}... (expires: ${row.expire}) ${isPast ? '[EXPIRED]' : '[ACTIVE]'}`);
      });
      
      // Check session data format
      const sessionDataFormatResult = await pool.query(`
        SELECT sess 
        FROM sessions 
        LIMIT 1
      `);
      
      if (sessionDataFormatResult.rows.length > 0) {
        const sessionData = sessionDataFormatResult.rows[0].sess;
        console.log('\nSession data format sample:');
        try {
          if (typeof sessionData === 'string') {
            // It might be JSON or another serialization format
            console.log('  String format, possibly JSON');
            try {
              const parsed = JSON.parse(sessionData);
              console.log('  Successfully parsed as JSON');
              console.log('  Session contains keys:', Object.keys(parsed).join(', '));
            } catch (e) {
              console.log('  Not valid JSON');
            }
          } else if (typeof sessionData === 'object') {
            console.log('  Object format');
            console.log('  Session contains keys:', Object.keys(sessionData).join(', '));
          } else {
            console.log(`  Unknown format: ${typeof sessionData}`);
          }
        } catch (e) {
          console.log(`  Error parsing session data: ${e.message}`);
        }
      }
    }
    
    // Distribution of expiration dates
    if (dateColumns.includes('expire')) {
      console.log('\nDistribution of expiration dates:');
      
      const bucketDefinitions = [
        { name: 'Expired more than a month ago', condition: "expire < NOW() - INTERVAL '30 days'" },
        { name: 'Expired within last month', condition: "expire < NOW() AND expire >= NOW() - INTERVAL '30 days'" },
        { name: 'Expires within a day', condition: "expire >= NOW() AND expire < NOW() + INTERVAL '1 day'" },
        { name: 'Expires within a week', condition: "expire >= NOW() + INTERVAL '1 day' AND expire < NOW() + INTERVAL '7 days'" },
        { name: 'Expires within a month', condition: "expire >= NOW() + INTERVAL '7 days' AND expire < NOW() + INTERVAL '30 days'" },
        { name: 'Expires more than a month from now', condition: "expire >= NOW() + INTERVAL '30 days'" }
      ];
      
      for (const bucket of bucketDefinitions) {
        const result = await pool.query(`
          SELECT COUNT(*) 
          FROM sessions 
          WHERE ${bucket.condition}
        `);
        
        console.log(`  ${bucket.name}: ${result.rows[0].count} sessions`);
      }
    }
    
  } catch (err) {
    console.error('Error during analysis:', err);
  } finally {
    await pool.end();
    console.log('\nAnalysis complete.');
  }
}

main(); 