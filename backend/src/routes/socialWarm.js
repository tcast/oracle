const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const socialWarmService = require('../services/socialWarmService');
const socialWarmScheduler = require('../services/socialWarmScheduler');
const pool = require('../services/db');

router.use(authMiddleware);

router.get('/status', async (req, res) => {
  try {
    const platform = req.query.platform || null;
    res.json(await socialWarmService.getDashboard(platform));
  } catch (error) {
    console.error('social-warm status error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.patch('/settings/:platform', async (req, res) => {
  try {
    const settings = await socialWarmService.updateSettings(req.params.platform, req.body || {});
    await socialWarmService.ensureJobsForPlatform(req.params.platform);
    if (req.body?.enabled === true || req.body?.warm === true) {
      try {
        const durableQueue = require('../services/durableQueue');
        if (durableQueue.started) await durableQueue.kickSocialWarmSoon(3000);
      } catch (err) {
        console.warn('kickSocialWarmSoon failed:', err.message);
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
    const { rows } = await pool.query('SELECT * FROM social_accounts WHERE id = $1', [accountId]);
    const account = rows[0];
    if (!account) return res.status(404).json({ error: 'Not found' });
    if (!['instagram', 'tiktok'].includes(account.platform)) {
      return res.status(400).json({ error: 'Not an Instagram/TikTok account' });
    }
    if (req.body?.force) {
      await pool.query(
        `UPDATE social_warm_jobs SET next_due_at = NOW() - INTERVAL '1 minute' WHERE social_account_id = $1`,
        [accountId]
      );
    }
    res.json(await socialWarmService.runOneForAccount(account, { dryRun: !!req.body?.dry_run }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/tick', async (req, res) => {
  try {
    res.json(await socialWarmScheduler.tick());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/warmup/:accountId', async (req, res) => {
  try {
    const playwrightService = require('../services/playwrightService');
    const accountId = Number(req.params.accountId);
    const { rows } = await pool.query('SELECT platform FROM social_accounts WHERE id = $1', [accountId]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(await playwrightService.warmUpAccount(accountId, rows[0].platform));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
