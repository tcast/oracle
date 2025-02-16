const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

const poolConfig = process.env.DATABASE_URL
? {
connectionString: process.env.DATABASE_URL,
ssl: { rejectUnauthorized: false }
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