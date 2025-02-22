const express = require('express');
const router = express.Router();
const pool = require('../services/db');

router.get('/social-accounts', async (req, res) => {
  try {
    const { search, platform, status } = req.query;
    
    // Build the WHERE clause dynamically
    const conditions = ['1=1']; // Always true condition to start with
    const params = [];
    let paramCount = 1;
    
    if (search) {
      conditions.push(`(username ILIKE $${paramCount} OR platform ILIKE $${paramCount})`);
      params.push(`%${search}%`);
      paramCount++;
    }
    
    if (platform) {
      conditions.push(`platform = $${paramCount}`);
      params.push(platform);
      paramCount++;
    }
    
    if (status) {
      conditions.push(`status = $${paramCount}`);
      params.push(status);
      paramCount++;
    }

    const query = `
      SELECT 
        id,
        platform,
        username,
        status,
        persona_traits,
        CASE 
          WHEN credentials->>'password' = 'default_password' THEN true 
          ELSE false 
        END as is_simulated
      FROM social_accounts
      WHERE ${conditions.join(' AND ')}
      ORDER BY platform, username
    `;

    const result = await pool.query(query, params);

    // Format the response
    const accounts = result.rows.map(account => ({
      ...account,
      // Ensure persona_traits is parsed JSON if it's a string
      persona_traits: typeof account.persona_traits === 'string' 
        ? JSON.parse(account.persona_traits)
        : account.persona_traits
    }));

    res.json(accounts);
  } catch (err) {
    console.error('Error fetching social accounts:', err);
    res.status(500).json({ error: 'Failed to fetch social accounts' });
  }
});

// Get available platforms and statuses for filters
router.get('/social-accounts/filters', async (req, res) => {
  try {
    const platforms = await pool.query(
      'SELECT DISTINCT platform FROM social_accounts ORDER BY platform'
    );
    
    const statuses = await pool.query(
      'SELECT DISTINCT status FROM social_accounts ORDER BY status'
    );

    res.json({
      platforms: platforms.rows.map(row => row.platform),
      statuses: statuses.rows.map(row => row.status)
    });
  } catch (err) {
    console.error('Error fetching filter options:', err);
    res.status(500).json({ error: 'Failed to fetch filter options' });
  }
});

// Add new social account
router.post('/social-accounts', async (req, res) => {
  const { platform, username, credentials, persona_traits } = req.body;
  
  try {
    const result = await pool.query(
      `INSERT INTO social_accounts 
       (platform, username, credentials, status, persona_traits)
       VALUES ($1, $2, $3, 'active', $4)
       RETURNING *`,
      [
        platform,
        username,
        JSON.stringify(credentials),
        JSON.stringify(persona_traits)
      ]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating social account:', err);
    res.status(500).json({ error: 'Failed to create social account' });
  }
});

// Update social account status
router.patch('/social-accounts/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  
  try {
    const result = await pool.query(
      `UPDATE social_accounts 
       SET status = $1
       WHERE id = $2
       RETURNING *`,
      [status, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Social account not found' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating social account status:', err);
    res.status(500).json({ error: 'Failed to update social account status' });
  }
});

// Delete social account
router.delete('/social-accounts/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await pool.query(
      'DELETE FROM social_accounts WHERE id = $1 RETURNING *',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Social account not found' });
    }
    
    res.json({ message: 'Social account deleted successfully' });
  } catch (err) {
    console.error('Error deleting social account:', err);
    res.status(500).json({ error: 'Failed to delete social account' });
  }
});

module.exports = router;