const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const pool = require('../services/db');
const accountCreationService = require('../services/accountCreationService');
const { formatForApi } = require('../services/profileEnrichment');

router.use(authMiddleware);

// The frontend expects this route without the 'social-accounts' prefix
router.get('/', async (req, res) => {
  try {
    const { search, platform, status, built_out, category } = req.query;
    
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

    if (built_out) {
      conditions.push(`profile_enrichment->>'built_out' = $${paramCount}`);
      params.push(built_out);
      paramCount++;
    }

    if (category) {
      conditions.push(`profile_enrichment->>'category' = $${paramCount}`);
      params.push(category);
      paramCount++;
    }

    const query = `
      SELECT 
        id,
        platform,
        username,
        email,
        status,
        persona_traits,
        profile_enrichment,
        warmup_status,
        warmed_up_at,
        last_used_at,
        total_karma,
        post_karma,
        comment_karma,
        post_count,
        comment_count,
        likes_count,
        dislikes_count,
        stats_audited_at,
        stats_audit_error,
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
    const accounts = result.rows.map(account => {
      const persona_traits = typeof account.persona_traits === 'string'
        ? JSON.parse(account.persona_traits)
        : account.persona_traits;
      const profile_enrichment = formatForApi(
        typeof account.profile_enrichment === 'string'
          ? JSON.parse(account.profile_enrichment)
          : account.profile_enrichment
      );
      return {
        ...account,
        persona_traits,
        profile_enrichment,
        built_out: profile_enrichment.built_out,
        job_category: profile_enrichment.category,
        job_category_label: profile_enrichment.category_label,
      };
    });

    res.json(accounts);
  } catch (err) {
    console.error('Error fetching social accounts:', err);
    res.status(500).json({ error: 'Failed to fetch social accounts' });
  }
});

// Get available platforms and statuses for filters
router.get('/filters', async (req, res) => {
  try {
    const platforms = await pool.query(
      `SELECT platform, COUNT(*)::int AS count
       FROM social_accounts
       GROUP BY platform
       ORDER BY COUNT(*) DESC, platform`
    );
    
    const statuses = await pool.query(
      'SELECT DISTINCT status FROM social_accounts ORDER BY status'
    );

    const categories = await pool.query(
      `SELECT DISTINCT profile_enrichment->>'category' AS category
       FROM social_accounts
       WHERE profile_enrichment->>'category' IS NOT NULL
         AND profile_enrichment->>'category' <> ''
       ORDER BY category`
    );

    const platformRows = platforms.rows;
    res.json({
      platforms: platformRows.map(row => row.platform),
      platform_counts: Object.fromEntries(platformRows.map(row => [row.platform, row.count])),
      total_count: platformRows.reduce((sum, row) => sum + row.count, 0),
      statuses: statuses.rows.map(row => row.status),
      built_out_options: ['full', 'partial', 'none'],
      categories: categories.rows.map(row => row.category),
    });
  } catch (err) {
    console.error('Error fetching filter options:', err);
    res.status(500).json({ error: 'Failed to fetch filter options' });
  }
});

// Add new social account
router.post('/', async (req, res) => {
  const { platform, username, email, credentials, persona_traits } = req.body;
  
  try {
    const result = await pool.query(
      `INSERT INTO social_accounts 
       (platform, username, email, credentials, status, persona_traits)
       VALUES ($1, $2, $3, $4, 'active', $5)
       RETURNING *`,
      [
        platform,
        username,
        email,
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
router.patch('/:id/status', async (req, res) => {
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
router.delete('/:id', async (req, res) => {
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

router.post('/create', async (req, res) => {
  const { platform, count, emailDomain, usernamePrefix, useEmailPool, warm } = req.body;

  try {
    if (!platform || !count) {
      return res.status(400).json({ error: 'Missing required fields: platform, count' });
    }

    const maxCount = useEmailPool ? 20 : 10;
    if (count < 1 || count > maxCount) {
      return res.status(400).json({ error: `Count must be between 1 and ${maxCount}` });
    }

    if (platform !== 'reddit') {
      return res.status(400).json({ error: 'Only reddit self-create is supported in this pilot' });
    }

    if (useEmailPool) {
      const results = await accountCreationService.createAccounts(
        platform,
        count,
        null,
        usernamePrefix || null,
        [],
        { useEmailPool: true, warm: warm !== false }
      );
      return res.json({
        mode: 'email_pool',
        ...results,
      });
    }

    if (!emailDomain || !usernamePrefix) {
      return res.status(400).json({
        error: 'Missing required fields: emailDomain, usernamePrefix (or set useEmailPool: true)',
      });
    }

    if (!emailDomain.match(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]\.[a-zA-Z]{2,}$/)) {
      return res.status(400).json({ error: 'Invalid email domain' });
    }

    if (!usernamePrefix.match(/^[a-zA-Z0-9_-]{3,15}$/)) {
      return res.status(400).json({ error: 'Invalid username prefix' });
    }

    const accounts = await accountCreationService.createAccounts(
      platform,
      count,
      emailDomain,
      usernamePrefix
    );

    res.json({ accounts });
  } catch (error) {
    console.error('Error creating accounts:', error);
    res.status(500).json({ error: 'Failed to create accounts', message: error.message });
  }
});

module.exports = router;