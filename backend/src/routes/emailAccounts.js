const express = require('express');
const router = express.Router();
const pool = require('../services/db');
const { authMiddleware } = require('../middleware/auth');
const emailAccountCreationService = require('../services/emailAccountCreationService');
const emailInboxService = require('../services/emailInboxService');
const fiveSimService = require('../services/fiveSimService');
const captchaSolverService = require('../services/captchaSolverService');

// All routes require authentication
router.use(authMiddleware);

/**
 * GET /api/email-accounts
 * List email accounts with filtering
 */
router.get('/', async (req, res) => {
  try {
    const { search, provider, status, assigned } = req.query;

    let query = 'SELECT * FROM email_accounts WHERE 1=1';
    const params = [];
    let paramCount = 0;

    if (search) {
      paramCount++;
      query += ` AND (email ILIKE $${paramCount} OR username ILIKE $${paramCount})`;
      params.push(`%${search}%`);
    }

    if (provider) {
      paramCount++;
      query += ` AND provider = $${paramCount}`;
      params.push(provider);
    }

    if (status) {
      paramCount++;
      query += ` AND status = $${paramCount}`;
      params.push(status);
    }

    if (assigned === 'true') {
      query += ` AND id IN (SELECT email_account_id FROM social_accounts WHERE email_account_id IS NOT NULL)`;
    } else if (assigned === 'false') {
      query += ` AND id NOT IN (SELECT email_account_id FROM social_accounts WHERE email_account_id IS NOT NULL)`;
    }

    query += ' ORDER BY created_at DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching email accounts:', error);
    res.status(500).json({ error: 'Failed to fetch email accounts' });
  }
});

/**
 * GET /api/email-accounts/stats
 * Get email account statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'active') as active,
        COUNT(*) FILTER (WHERE is_verified = true) as verified,
        COUNT(*) FILTER (WHERE provider = 'yahoo') as yahoo,
        COUNT(*) FILTER (WHERE provider = 'gmx') as gmx,
        COUNT(*) FILTER (WHERE id IN (
          SELECT email_account_id FROM social_accounts WHERE email_account_id IS NOT NULL
        )) as assigned
      FROM email_accounts
    `);

    const recentActivity = await pool.query(`
      SELECT
        DATE(created_at) as date,
        provider,
        COUNT(*) as count
      FROM email_accounts
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at), provider
      ORDER BY date DESC
    `);

    res.json({
      overview: stats.rows[0],
      recentActivity: recentActivity.rows
    });
  } catch (error) {
    console.error('Error fetching email stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

/**
 * GET /api/email-accounts/available
 * Get unassigned email accounts for assignment
 */
router.get('/available', async (req, res) => {
  try {
    const { provider } = req.query;

    let query = `
      SELECT * FROM email_accounts
      WHERE status = 'active'
      AND id NOT IN (SELECT email_account_id FROM social_accounts WHERE email_account_id IS NOT NULL)
    `;
    const params = [];

    if (provider) {
      query += ` AND provider = $1`;
      params.push(provider);
    }

    query += ' ORDER BY created_at DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching available emails:', error);
    res.status(500).json({ error: 'Failed to fetch available emails' });
  }
});

/**
 * POST /api/email-accounts/create
 * Bulk create email accounts
 */
router.post('/create', async (req, res) => {
  try {
    const { provider, count, nameStyle = 'random', useProxies = true } = req.body;

    // Validation
    if (!provider || !count) {
      return res.status(400).json({
        error: 'Missing required fields: provider, count'
      });
    }

    if (!['yahoo', 'gmx'].includes(provider)) {
      return res.status(400).json({
        error: 'Provider must be "yahoo" or "gmx"'
      });
    }

    if (count < 1 || count > 50) {
      return res.status(400).json({
        error: 'Count must be between 1 and 50'
      });
    }

    const validStyles = ['professional', 'casual', 'tech', 'random'];
    if (nameStyle && !validStyles.includes(nameStyle)) {
      return res.status(400).json({
        error: `Name style must be one of: ${validStyles.join(', ')}`
      });
    }

    // Create accounts
    const results = await emailAccountCreationService.createEmailAccounts(
      provider,
      count,
      nameStyle,
      useProxies
    );

    res.json({
      success: true,
      ...results
    });

  } catch (error) {
    console.error('Error creating email accounts:', error);
    res.status(500).json({
      error: 'Failed to create email accounts',
      message: error.message
    });
  }
});

/**
 * POST /api/email-accounts/:id/assign
 * Assign email account to social account
 */
router.post('/:id/assign', async (req, res) => {
  try {
    const { id } = req.params;
    const { socialAccountId } = req.body;

    if (!socialAccountId) {
      return res.status(400).json({ error: 'socialAccountId is required' });
    }

    // Check if email exists
    const emailCheck = await pool.query(
      'SELECT * FROM email_accounts WHERE id = $1',
      [id]
    );

    if (emailCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Email account not found' });
    }

    // Check if social account exists
    const socialCheck = await pool.query(
      'SELECT * FROM social_accounts WHERE id = $1',
      [socialAccountId]
    );

    if (socialCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Social account not found' });
    }

    // Assign email to social account
    const result = await pool.query(
      `UPDATE social_accounts
       SET email_account_id = $1, email = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [id, emailCheck.rows[0].email, socialAccountId]
    );

    // Update email last_used_at
    await pool.query(
      'UPDATE email_accounts SET last_used_at = NOW() WHERE id = $1',
      [id]
    );

    res.json({
      success: true,
      socialAccount: result.rows[0],
      emailAccount: emailCheck.rows[0]
    });

  } catch (error) {
    console.error('Error assigning email:', error);
    res.status(500).json({ error: 'Failed to assign email account' });
  }
});

/**
 * DELETE /api/email-accounts/:id/assign
 * Unassign email from social account
 */
router.delete('/:id/assign', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `UPDATE social_accounts
       SET email_account_id = NULL
       WHERE email_account_id = $1
       RETURNING *`,
      [id]
    );

    res.json({
      success: true,
      message: `Unassigned from ${result.rowCount} social account(s)`
    });

  } catch (error) {
    console.error('Error unassigning email:', error);
    res.status(500).json({ error: 'Failed to unassign email' });
  }
});

/**
 * POST /api/email-accounts/:id/test
 * Test login for email account
 */
router.post('/:id/test', async (req, res) => {
  try {
    const { id } = req.params;

    const success = await emailAccountCreationService.testEmailLogin(parseInt(id));

    res.json({
      success,
      message: success ? 'Login test passed' : 'Login test failed'
    });

  } catch (error) {
    console.error('Error testing email login:', error);
    res.status(500).json({
      error: 'Failed to test email login',
      message: error.message
    });
  }
});

/**
 * POST /api/email-accounts/:id/inbox
 * Fetch recent inbox messages / latest verification code via IMAP
 */
router.post('/:id/inbox', async (req, res) => {
  try {
    const { id } = req.params;
    const { limit, fromIncludes, subjectIncludes, testOnly } = req.body || {};

    if (testOnly) {
      const result = await emailInboxService.testImapLogin(parseInt(id, 10));
      return res.json(result);
    }

    const result = await emailInboxService.checkInbox(parseInt(id, 10), {
      limit: limit ? Math.min(parseInt(limit, 10) || 10, 30) : 10,
      fromIncludes,
      subjectIncludes,
    });
    res.json(result);
  } catch (error) {
    console.error('Error checking email inbox:', error);
    res.status(500).json({
      error: 'Failed to check inbox',
      message: error.message,
    });
  }
});

/**
 * GET /api/email-accounts/:id/inbox
 * Same as POST for convenience (query params)
 */
router.get('/:id/inbox', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await emailInboxService.checkInbox(parseInt(id, 10), {
      limit: req.query.limit ? Math.min(parseInt(req.query.limit, 10) || 10, 30) : 10,
      fromIncludes: req.query.from,
      subjectIncludes: req.query.subject,
    });
    res.json(result);
  } catch (error) {
    console.error('Error checking email inbox:', error);
    res.status(500).json({
      error: 'Failed to check inbox',
      message: error.message,
    });
  }
});

/**
 * PATCH /api/email-accounts/:id/status
 * Update email account status
 */
router.patch('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['active', 'inactive', 'banned', 'locked'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        error: `Status must be one of: ${validStatuses.join(', ')}`
      });
    }

    const result = await pool.query(
      `UPDATE email_accounts
       SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Email account not found' });
    }

    res.json(result.rows[0]);

  } catch (error) {
    console.error('Error updating email status:', error);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

/**
 * DELETE /api/email-accounts/:id
 * Delete email account
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if email is assigned to any social accounts
    const assignmentCheck = await pool.query(
      'SELECT id FROM social_accounts WHERE email_account_id = $1',
      [id]
    );

    if (assignmentCheck.rows.length > 0) {
      return res.status(400).json({
        error: 'Cannot delete email account that is assigned to social accounts',
        assignedCount: assignmentCheck.rows.length
      });
    }

    const result = await pool.query(
      'DELETE FROM email_accounts WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Email account not found' });
    }

    res.json({
      success: true,
      message: 'Email account deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting email account:', error);
    res.status(500).json({ error: 'Failed to delete email account' });
  }
});

/**
 * GET /api/email-accounts/health
 * Health check for SMS and CAPTCHA services
 */
router.get('/health', async (req, res) => {
  try {
    const [smsHealth, captchaHealth] = await Promise.all([
      fiveSimService.healthCheck(),
      captchaSolverService.healthCheck()
    ]);

    res.json({
      fiveSim: smsHealth,
      captcha: captchaHealth,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error checking service health:', error);
    res.status(500).json({ error: 'Health check failed' });
  }
});

module.exports = router;
