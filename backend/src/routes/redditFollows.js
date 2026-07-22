const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const redditFollowService = require('../services/redditFollowService');
const redditFollowScheduler = require('../services/redditFollowScheduler');
const pool = require('../services/db');

router.use(authMiddleware);

router.get('/status', async (req, res) => {
  try {
    const dashboard = await redditFollowService.getDashboard();
    res.json(dashboard);
  } catch (error) {
    console.error('reddit-follow status error:', error);
    res.status(500).json({ error: 'Failed to load Reddit follow status' });
  }
});

router.patch('/settings', async (req, res) => {
  try {
    const body = req.body || {};
    const settings = await redditFollowService.updateSettings(body);
    await redditFollowService.ensureJobsForEligible();

    const shouldKick =
      body.enabled === true ||
      body.warm === true ||
      body.min_per_day != null ||
      body.max_per_day != null ||
      body.max_concurrent != null;
    if (shouldKick) {
      try {
        const durableQueue = require('../services/durableQueue');
        if (durableQueue.started) await durableQueue.kickRedditFollowSoon(3000);
      } catch (err) {
        console.warn('reddit-follow settings: kickRedditFollowSoon failed:', err.message);
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
    const job = await redditFollowService.setAccountEnabled(Number(req.params.accountId), enabled);
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
    if (String(account.platform).toLowerCase() !== 'reddit') {
      return res.status(400).json({ error: 'Account is not a Reddit account' });
    }

    if (force) {
      await pool.query(
        `UPDATE reddit_follow_jobs
         SET next_due_at = NOW() - INTERVAL '1 minute', updated_at = NOW()
         WHERE social_account_id = $1`,
        [accountId]
      );
    }

    const result = await redditFollowService.runOneForAccount(account, { dryRun });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/tick', async (req, res) => {
  try {
    const result = await redditFollowScheduler.tick();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
