// backend/src/services/authService.js
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const pool = require('./db');
const crypto = require('crypto');

class AuthService {
  constructor() {
    this.jwtSecret = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
    this.jwtExpiration = '15m';  // Access token expires in 15 minutes
    this.refreshExpiration = '7d';  // Refresh token expires in 7 days
  }

  async registerUser(email, password, firstName, lastName) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Check if user already exists
      const existingUser = await client.query(
        'SELECT id FROM users WHERE email = $1',
        [email.toLowerCase()]
      );
      
      if (existingUser.rows.length > 0) {
        throw new Error('User already exists');
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, 10);

      // Create user
      const result = await client.query(
        `INSERT INTO users (email, password_hash, first_name, last_name)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, first_name, last_name, role`,
        [email.toLowerCase(), passwordHash, firstName, lastName]
      );

      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async loginUser(email, password) {
    // Get user
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1 AND is_active = true',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      throw new Error('Invalid credentials');
    }

    const user = result.rows[0];

    // Verify password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      throw new Error('Invalid credentials');
    }

    // Generate tokens
    const accessToken = this.generateAccessToken(user);
    const refreshToken = await this.generateRefreshToken(user.id);

    return {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role
      },
      accessToken,
      refreshToken
    };
  }

  async refreshToken(token) {
    const session = await pool.query(
      'SELECT * FROM sessions WHERE refresh_token = $1 AND expires_at > NOW()',
      [token]
    );

    if (session.rows.length === 0) {
      throw new Error('Invalid refresh token');
    }

    const user = await pool.query(
      'SELECT * FROM users WHERE id = $1 AND is_active = true',
      [session.rows[0].user_id]
    );

    if (user.rows.length === 0) {
      throw new Error('User not found or inactive');
    }

    // Generate new tokens
    const accessToken = this.generateAccessToken(user.rows[0]);
    const refreshToken = await this.generateRefreshToken(user.rows[0].id);

    // Update last used timestamp
    await pool.query(
      'UPDATE sessions SET last_used_at = NOW() WHERE refresh_token = $1',
      [token]
    );

    return { accessToken, refreshToken };
  }

  async logout(refreshToken) {
    await pool.query(
      'DELETE FROM sessions WHERE refresh_token = $1',
      [refreshToken]
    );
  }

  generateAccessToken(user) {
    return jwt.sign(
      {
        userId: user.id,
        email: user.email,
        role: user.role
      },
      this.jwtSecret,
      { expiresIn: this.jwtExpiration }
    );
  }

  async generateRefreshToken(userId) {
    const token = crypto.randomBytes(40).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 days from now

    await pool.query(
      `INSERT INTO sessions (user_id, refresh_token, expires_at)
       VALUES ($1, $2, $3)`,
      [userId, token, expiresAt]
    );

    return token;
  }

  verifyAccessToken(token) {
    try {
      return jwt.verify(token, this.jwtSecret);
    } catch (error) {
      throw new Error('Invalid access token');
    }
  }

  async cleanupExpiredSessions() {
    await pool.query('DELETE FROM sessions WHERE expires_at <= NOW()');
  }
}

module.exports = new AuthService();