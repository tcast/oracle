const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const organicCommentService = require('../services/organicCommentService');
const organicCommentScheduler = require('../services/organicCommentScheduler');
const proxyService = require('../services/proxyService');
const pool = require('../services/db');

router.use(authMiddleware);

router.get('/status', async (req, res) => {
  try {
    const dashboard = await organicCommentService.getDashboard();
    res.json(dashboard);
  } catch (error) {
    console.error('organic status error:', error);
    res.status(500).json({ error: 'Failed to load organic comment status' });
  }
});

router.patch('/settings', async (req, res) => {
  try {
    const settings = await organicCommentService.updateSettings(req.body || {});
    res.json(settings);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/accounts/:accountId/enabled', async (req, res) => {
  try {
    const enabled = req.body?.enabled !== false;
    const job = await organicCommentService.setAccountEnabled(Number(req.params.accountId), enabled);
    res.json(job);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/run-once/:accountId', async (req, res) => {
  try {
    const accountId = Number(req.params.accountId);
    const dryRun = !!req.body?.dry_run;
    const force = !!req.body?.force;

    const accountResult = await pool.query('SELECT * FROM social_accounts WHERE id = $1', [accountId]);
    const account = accountResult.rows[0];
    if (!account) return res.status(404).json({ error: 'Account not found' });

    if (force) {
      await pool.query(
        `UPDATE organic_comment_jobs
         SET next_due_at = NOW() - INTERVAL '1 minute', updated_at = NOW()
         WHERE social_account_id = $1`,
        [accountId]
      );
    }

    const result = await organicCommentService.runOneForAccount(account, { dryRun });
    res.json(result);
  } catch (error) {
    console.error('organic run-once error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/tick', async (req, res) => {
  try {
    const result = await organicCommentScheduler.tick();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/proxy-mapping', async (req, res) => {
  try {
    const status = await proxyService.getProxyMappingStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/proxy-mapping/reconcile', async (req, res) => {
  try {
    const createMissing = req.body?.create_missing !== false;
    const result = await proxyService.reconcileProxyAccountMapping({ createMissing });
    res.json(result);
  } catch (error) {
    console.error('proxy reconcile error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
