const { Pool } = require('pg');

async function main() {
  console.log('Checking for schema mismatches...');
  
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
    
    // Expected schema from lambda-reddit-fix.js
    const expectedSchema = `
      CREATE TABLE IF NOT EXISTS scraped_mentions (
        id SERIAL PRIMARY KEY,
        symbol VARCHAR(20) NOT NULL,
        type VARCHAR(10) NOT NULL,
        platform VARCHAR(20) NOT NULL,
        content TEXT,
        url TEXT,
        sentiment NUMERIC(4,2),
        scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    
    console.log('Expected schema from Lambda code:');
    console.log(expectedSchema);
    
    // Check if table exists
    const tableExistsResult = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'scraped_mentions'
      )
    `);
    
    if (!tableExistsResult.rows[0].exists) {
      console.log('\nTable does not exist in database');
      return;
    }
    
    // Get actual schema from database
    const actualSchemaResult = await pool.query(`
      SELECT column_name, data_type, character_maximum_length, 
             is_nullable, column_default, udt_name
      FROM information_schema.columns
      WHERE table_name = 'scraped_mentions'
      ORDER BY ordinal_position
    `);
    
    console.log('\nActual schema in database:');
    actualSchemaResult.rows.forEach(column => {
      const nullable = column.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
      const default_value = column.column_default ? `DEFAULT ${column.column_default}` : '';
      const type = column.udt_name === 'varchar' && column.character_maximum_length 
                  ? `VARCHAR(${column.character_maximum_length})` 
                  : column.data_type.toUpperCase();
                  
      console.log(`  ${column.column_name} ${type} ${nullable} ${default_value}`.trim());
    });
    
    // Check for missing or extra columns
    const expectedColumns = [
      'id', 'symbol', 'type', 'platform', 'content', 'url', 'sentiment', 'scraped_at'
    ];
    
    const actualColumns = actualSchemaResult.rows.map(row => row.column_name);
    
    console.log('\nSchema comparison:');
    
    // Check missing columns
    const missingColumns = expectedColumns.filter(col => !actualColumns.includes(col));
    if (missingColumns.length > 0) {
      console.log('❌ Missing columns in database:', missingColumns.join(', '));
    } else {
      console.log('✅ All expected columns exist');
    }
    
    // Check extra columns
    const extraColumns = actualColumns.filter(col => !expectedColumns.includes(col));
    if (extraColumns.length > 0) {
      console.log('ℹ️ Extra columns in database (not in Lambda code):', extraColumns.join(', '));
    }
    
    // Check for column type mismatches
    console.log('\nChecking column type mismatches:');
    const typeMap = {
      'id': 'integer',
      'symbol': 'character varying',
      'type': 'character varying',
      'platform': 'character varying',
      'content': 'text',
      'url': 'text',
      'sentiment': 'numeric',
      'scraped_at': 'timestamp'
    };
    
    let hasMismatch = false;
    
    for (const column of actualSchemaResult.rows) {
      if (expectedColumns.includes(column.column_name)) {
        const expectedType = typeMap[column.column_name];
        const actualType = column.data_type.toLowerCase();
        
        if (expectedType && expectedType !== actualType) {
          console.log(`❌ Type mismatch for ${column.column_name}: expected ${expectedType}, got ${actualType}`);
          hasMismatch = true;
        }
      }
    }
    
    if (!hasMismatch) {
      console.log('✅ No type mismatches found');
    }
    
    // Get table constraints
    const constraintsResult = await pool.query(`
      SELECT
        tc.constraint_name,
        tc.constraint_type,
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      LEFT JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.table_name = 'scraped_mentions'
    `);
    
    console.log('\nTable constraints:');
    constraintsResult.rows.forEach(constraint => {
      console.log(`  ${constraint.constraint_name} (${constraint.constraint_type}) on ${constraint.column_name}`);
      if (constraint.foreign_table_name) {
        console.log(`    References ${constraint.foreign_table_name}.${constraint.foreign_column_name}`);
      }
    });
    
    // Count records
    const countResult = await pool.query('SELECT COUNT(*) FROM scraped_mentions');
    console.log(`\nTotal records: ${countResult.rows[0].count}`);
    
  } catch (err) {
    console.error('Error during analysis:', err);
  } finally {
    await pool.end();
    console.log('\nAnalysis complete');
  }
}

main(); 