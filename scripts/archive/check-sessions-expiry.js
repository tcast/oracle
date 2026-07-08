const { Pool } = require('pg');

async function main() {
  console.log('Starting sessions expiry analysis...');
  
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
    
    // Get sample data with future expiry dates
    console.log('\nSample sessions with future expiry dates:');
    const futureSamplesResult = await pool.query(`
      SELECT id, user_id, expires_at, created_at, 
            EXTRACT(EPOCH FROM (expires_at - created_at))/3600 AS hours_valid
      FROM sessions 
      WHERE expires_at > NOW()
      ORDER BY expires_at ASC
      LIMIT 10
    `);
    
    futureSamplesResult.rows.forEach(row => {
      console.log(`  Session ID: ${row.id}, User ID: ${row.user_id}`);
      console.log(`    Created: ${row.created_at}`);
      console.log(`    Expires: ${row.expires_at}`);
      console.log(`    Valid for: ${row.hours_valid.toFixed(2)} hours`);
      console.log('');
    });
    
    // Analyze expiry distribution
    console.log('\nExpiry time distribution analysis:');
    
    // Get min, max, avg expiry interval
    const expiryStatsResult = await pool.query(`
      SELECT 
        MIN(EXTRACT(EPOCH FROM (expires_at - created_at))/3600) as min_hours,
        MAX(EXTRACT(EPOCH FROM (expires_at - created_at))/3600) as max_hours,
        AVG(EXTRACT(EPOCH FROM (expires_at - created_at))/3600) as avg_hours,
        MODE() WITHIN GROUP (ORDER BY 
          FLOOR(EXTRACT(EPOCH FROM (expires_at - created_at))/3600/24)
        ) as most_common_days
      FROM sessions
      WHERE expires_at > created_at
    `);
    
    const stats = expiryStatsResult.rows[0];
    console.log(`  Minimum expiry time: ${stats.min_hours.toFixed(2)} hours`);
    console.log(`  Maximum expiry time: ${stats.max_hours.toFixed(2)} hours`);
    console.log(`  Average expiry time: ${stats.avg_hours.toFixed(2)} hours`);
    console.log(`  Most common expiry period: ~${stats.most_common_days} days`);
    
    // Get distribution of intervals
    console.log('\nExpiry interval distribution:');
    const intervalDistributionResult = await pool.query(`
      SELECT 
        CASE 
          WHEN hours < 24 THEN 'Less than 1 day'
          WHEN hours >= 24 AND hours < 168 THEN '1-7 days'
          WHEN hours >= 168 AND hours < 720 THEN '1-4 weeks'
          WHEN hours >= 720 AND hours < 2160 THEN '1-3 months'
          ELSE 'More than 3 months'
        END as interval_bucket,
        COUNT(*) as count
      FROM (
        SELECT EXTRACT(EPOCH FROM (expires_at - created_at))/3600 as hours
        FROM sessions
        WHERE expires_at > created_at
      ) as hour_intervals
      GROUP BY interval_bucket
      ORDER BY 
        CASE 
          WHEN interval_bucket = 'Less than 1 day' THEN 1
          WHEN interval_bucket = '1-7 days' THEN 2
          WHEN interval_bucket = '1-4 weeks' THEN 3
          WHEN interval_bucket = '1-3 months' THEN 4
          ELSE 5
        END
    `);
    
    intervalDistributionResult.rows.forEach(row => {
      console.log(`  ${row.interval_bucket}: ${row.count} sessions`);
    });
    
    // Check for very far future expirations
    const farFutureResult = await pool.query(`
      SELECT COUNT(*) 
      FROM sessions 
      WHERE expires_at > NOW() + INTERVAL '1 year'
    `);
    
    console.log(`\nSessions expiring more than 1 year in the future: ${farFutureResult.rows[0].count}`);
    
    if (farFutureResult.rows[0].count > 0) {
      const farFutureSamplesResult = await pool.query(`
        SELECT id, user_id, expires_at, created_at,
              expires_at - NOW() as time_until_expiry
        FROM sessions 
        WHERE expires_at > NOW() + INTERVAL '1 year'
        ORDER BY expires_at DESC
        LIMIT 5
      `);
      
      console.log('Sample far-future expiring sessions:');
      farFutureSamplesResult.rows.forEach(row => {
        const yearsUntilExpiry = (row.time_until_expiry.days || 0) / 365.25;
        console.log(`  Session ID: ${row.id}, User ID: ${row.user_id}`);
        console.log(`    Created: ${row.created_at}`);
        console.log(`    Expires: ${row.expires_at}`);
        console.log(`    Time until expiry: ~${yearsUntilExpiry.toFixed(1)} years`);
        console.log('');
      });
    }
    
    // Check related code in backend (find how sessions are created)
    console.log('\nChecking for related code in the application:');
    const codeCheckResult = await pool.query(`
      SELECT id, user_id
      FROM sessions
      WHERE expires_at > NOW() + INTERVAL '1 year'
      ORDER BY expires_at DESC
      LIMIT 1
    `);
    
    if (codeCheckResult.rows.length > 0) {
      console.log(`  Exceptional session found: ID ${codeCheckResult.rows[0].id}, User ID: ${codeCheckResult.rows[0].user_id}`);
      console.log('  To understand how these long sessions are created, check the authentication system in your application code');
    }
    
  } catch (err) {
    console.error('Error during analysis:', err);
  } finally {
    await pool.end();
    console.log('\nAnalysis complete.');
  }
}

main(); 