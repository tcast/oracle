// backend/scripts/createUser.js
require('dotenv').config();
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const readline = require('readline');

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

async function createUser() {
  try {
    console.log('\nCreate new user');
    console.log('==============');
    
    const email = await question('Email: ');
    const password = await question('Password: ');
    const firstName = await question('First Name: ');
    const lastName = await question('Last Name: ');
    const role = await question('Role (user/admin) [user]: ') || 'user';

    if (!email || !password) {
      throw new Error('Email and password are required');
    }

    if (!email.includes('@')) {
      throw new Error('Invalid email format');
    }

    if (password.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Insert user
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, first_name, last_name, role`,
      [email.toLowerCase(), passwordHash, firstName, lastName, role]
    );

    console.log('\nUser created successfully:');
    console.log(result.rows[0]);

  } catch (error) {
    console.error('\nError creating user:', error.message);
  } finally {
    rl.close();
    pool.end();
  }
}

createUser();