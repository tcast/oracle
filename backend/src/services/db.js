const { Pool } = require('pg');

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

console.log('DATABASE_URL:', process.env.DATABASE_URL);

const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: { require: true, rejectUnauthorized: false }
    }
  : {
      user: process.env.DB_USER,
      host: process.env.DB_HOST,
      database: process.env.DB_NAME,
      password: process.env.DB_PASSWORD,
      port: process.env.DB_PORT,
      ssl: false
    };

const pool = new Pool(poolConfig);
module.exports = pool;