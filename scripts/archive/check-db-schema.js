// Simple script to check database schema
const { Pool } = require('pg');
require('dotenv').config();

// Utility to output clean JSON
function prettyJson(obj) {
  return JSON.stringify(obj, null, 2);
}

async function main() {
  console.log('=== PostgreSQL Database Schema Inspector ===');
  
  const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: 5432,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
  });
  
  try {
    // Connect to database
    const client = await pool.connect();
    console.log('Connected to database successfully');
    
    // Log connection info
    console.log(`- Host: ${process.env.DB_HOST}`);
    console.log(`- Database: ${process.env.DB_NAME}`);
    console.log(`- User: ${process.env.DB_USER}`);
    
    // Get tables
    console.log('\n=== Tables ===');
    const tables = await client.query(`
      SELECT 
        table_name,
        (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = t.table_name) AS column_count
      FROM 
        information_schema.tables t
      WHERE 
        table_schema = 'public'
      ORDER BY 
        table_name
    `);
    
    if (tables.rows.length === 0) {
      console.log('No tables found in the database');
    } else {
      console.log(`Found ${tables.rows.length} tables:`);
      for (const table of tables.rows) {
        console.log(`- ${table.table_name} (${table.column_count} columns)`);
      }
    }
    
    // Inspect the scraped_mentions table
    console.log('\n=== scraped_mentions Table ===');
    
    // Check if table exists
    const checkTable = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public'
        AND table_name = 'scraped_mentions'
      ) AS exists
    `);
    
    if (!checkTable.rows[0].exists) {
      console.log('Table scraped_mentions does not exist');
    } else {
      // Get columns
      const columns = await client.query(`
        SELECT 
          column_name, 
          data_type, 
          is_nullable,
          column_default,
          character_maximum_length
        FROM 
          information_schema.columns
        WHERE 
          table_schema = 'public'
          AND table_name = 'scraped_mentions'
        ORDER BY 
          ordinal_position
      `);
      
      console.log('Columns:');
      columns.rows.forEach(col => {
        console.log(`- ${col.column_name}: ${col.data_type}${col.character_maximum_length ? `(${col.character_maximum_length})` : ''} ${col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'} ${col.column_default ? `DEFAULT ${col.column_default}` : ''}`);
      });
      
      // Get constraints
      const constraints = await client.query(`
        SELECT
          tc.constraint_name,
          tc.constraint_type,
          kcu.column_name,
          ccu.table_name AS referenced_table,
          ccu.column_name AS referenced_column
        FROM
          information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
          LEFT JOIN information_schema.constraint_column_usage ccu
            ON tc.constraint_name = ccu.constraint_name
        WHERE
          tc.table_name = 'scraped_mentions'
        ORDER BY
          tc.constraint_name;
      `);
      
      if (constraints.rows.length > 0) {
        console.log('\nConstraints:');
        constraints.rows.forEach(constraint => {
          const type = {
            'PRIMARY KEY': 'PK',
            'FOREIGN KEY': 'FK',
            'UNIQUE': 'UQ',
            'CHECK': 'CK'
          }[constraint.constraint_type] || constraint.constraint_type;
          
          let description = `- ${type} ${constraint.constraint_name} on ${constraint.column_name}`;
          if (constraint.referenced_table) {
            description += ` → ${constraint.referenced_table}(${constraint.referenced_column})`;
          }
          console.log(description);
        });
      }
      
      // Get record count
      const countResult = await client.query('SELECT COUNT(*) FROM scraped_mentions');
      console.log(`\nTotal records: ${countResult.rows[0].count}`);
      
      // Get a sample record if table is not empty
      if (parseInt(countResult.rows[0].count) > 0) {
        const sampleRecord = await client.query('SELECT * FROM scraped_mentions ORDER BY id DESC LIMIT 1');
        console.log('\nSample record:');
        console.log(prettyJson(sampleRecord.rows[0]));
      }
      
      // Test insert a record
      console.log('\nTesting insert capability...');
      try {
        await client.query('BEGIN');
        
        const insertResult = await client.query(`
          INSERT INTO scraped_mentions (symbol, type, platform, content, url, sentiment)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id
        `, ['TEST', 'stock', 'test', 'Schema test record', 'https://example.com', 0]);
        
        console.log(`Successfully inserted test record with ID: ${insertResult.rows[0].id}`);
        
        // Delete the test record immediately
        await client.query('DELETE FROM scraped_mentions WHERE id = $1', [insertResult.rows[0].id]);
        console.log('Test record deleted');
        
        await client.query('COMMIT');
      } catch (insertError) {
        await client.query('ROLLBACK');
        console.error(`Error testing insert: ${insertError.message}`);
      }
    }
    
    client.release();
  } catch (err) {
    console.error('Database error:', err.message);
    console.error(err.stack);
  } finally {
    // Close the pool
    await pool.end();
    console.log('\nDatabase connection closed');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
}); 