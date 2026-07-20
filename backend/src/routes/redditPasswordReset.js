const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const redditPasswordResetService = require('../services/redditPasswordResetService');
const redditPasswordResetScheduler = require('../services/redditPasswordResetScheduler');
const pool = require('../services/db');

router.use(authMiddleware);

router.get('/status', async (req, res) => {
  try {
    res.json(await redditPasswordResetService.getDashboard());
  } catch (error) {
    console.error('reddit-password-reset status error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/eligibility', async (req, res) => {
  try {
    res.json(await redditPasswordResetService.eligibilityReport());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/settings', async (req, res) => {
  try {
    const settings = await redditPasswordResetService.updateSettings(req.body || {});
    if (req.body?.enabled === true) {
      await redditPasswordResetService.ensureJobsForEligible();
      try {
        const durableQueue = require('../services/durableQueue');
        if (durableQueue.started) await durableQueue.kickRedditPasswordResetSoon(5000);
      } catch (err) {
        console.warn('kickRedditPasswordResetSoon failed:', err.message);
      }
    }
    res.json(settings);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/run-once/:accountId', async (req, res) => {
  try {
    const accountId = Number(req.params.accountId);
    const dryRun = !!req.body?.dry_run;
    const force = !!req.body?.force;

    const { rows } = await pool.query('SELECT * FROM social_accounts WHERE id = $1', [accountId]);
    const account = rows[0];
    if (!account) return res.status(404).json({ error: 'Not found' });
    if (account.platform !== 'reddit') {
      return res.status(400).json({ error: 'Not a Reddit account' });
    }

    res.json(await redditPasswordResetService.runOneForAccount(account, { dryRun, force }));
  } catch (error) {
    console.error('reddit-password-reset run-once error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/batch', async (req, res) => {
  try {
    const dryRun = req.body?.dry_run !== false; // default dry-run for safety
    const limit = Math.min(Number(req.body?.limit) || 2, 5);
    const force = !!req.body?.force;
    const accountIds = Array.isArray(req.body?.account_ids)
      ? req.body.account_ids.map(Number).filter(Boolean)
      : null;

    let accounts;
    if (accountIds?.length) {
      const { rows } = await pool.query(
        `SELECT * FROM social_accounts WHERE id = ANY($1::int[]) AND platform = 'reddit'`,
        [accountIds]
      );
      accounts = rows;
    } else {
      accounts = (await redditPasswordResetService.listEligibleAccounts()).slice(0, limit);
    }

    const results = [];
    for (const account of accounts.slice(0, limit)) {
      results.push({
        accountId: account.id,
        username: account.username,
        ...(await redditPasswordResetService.runOneForAccount(account, { dryRun, force })),
      });
    }
    res.json({ dryRun, count: results.length, results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/tick', async (req, res) => {
  try {
    res.json(await redditPasswordResetScheduler.tick());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
