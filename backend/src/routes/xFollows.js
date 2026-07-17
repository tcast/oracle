const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const xFollowService = require('../services/xFollowService');
const xFollowScheduler = require('../services/xFollowScheduler');
const pool = require('../services/db');

router.use(authMiddleware);

router.get('/status', async (req, res) => {
  try {
    const dashboard = await xFollowService.getDashboard();
    res.json(dashboard);
  } catch (error) {
    console.error('x-follow status error:', error);
    res.status(500).json({ error: 'Failed to load X follow status' });
  }
});

router.patch('/settings', async (req, res) => {
  try {
    const body = req.body || {};
    const settings = await xFollowService.updateSettings(body);
    await xFollowService.ensureJobsForEligible();

    const shouldKick =
      body.enabled === true ||
      body.warm === true ||
      body.min_per_day != null ||
      body.max_per_day != null ||
      body.max_concurrent != null;
    if (shouldKick) {
      try {
        const durableQueue = require('../services/durableQueue');
        if (durableQueue.started) await durableQueue.kickXFollowSoon(3000);
      } catch (err) {
        console.warn('x-follow settings: kickXFollowSoon failed:', err.message);
      }
    }
    res.json(settings);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/accounts/:accountId/enabled', async (req, res) => {
  try {
    const enabled = req.body?.enabled !== false;
    const job = await xFollowService.setAccountEnabled(Number(req.params.accountId), enabled);
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
    if (account.platform !== 'x') {
      return res.status(400).json({ error: 'Account is not an X account' });
    }

    if (force) {
      await pool.query(
        `UPDATE x_follow_jobs
         SET next_due_at = NOW() - INTERVAL '1 minute', updated_at = NOW()
         WHERE social_account_id = $1`,
        [accountId]
      );
    }

    const result = await xFollowService.runOneForAccount(account, { dryRun });
    res.json(result);
  } catch (error) {
    console.error('x-follow run-once error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/tick', async (req, res) => {
  try {
    const result = await xFollowScheduler.tick();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/targets', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.*,
              (SELECT COUNT(*)::int FROM x_follows f WHERE lower(f.handle) = lower(t.handle) AND f.status IN ('followed','already')) AS follow_count
       FROM x_follow_targets t
       ORDER BY t.category, t.priority, t.handle`
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
