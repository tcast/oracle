const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const accountStatsService = require('../services/accountStatsService');
const pool = require('../services/db');

router.use(authMiddleware);

router.get('/settings', async (req, res) => {
  try {
    const settings = await accountStatsService.getSettings();
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/settings', async (req, res) => {
  try {
    const settings = await accountStatsService.updateSettings(req.body || {});
    res.json(settings);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/audits', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const audits = await accountStatsService.getRecentAudits(limit);
    res.json(audits);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/run', async (req, res) => {
  try {
    const limit = req.body?.limit ? Number(req.body.limit) : null;
    const accountId = req.body?.account_id ? Number(req.body.account_id) : null;

    if (accountId) {
      const account = (await pool.query('SELECT * FROM social_accounts WHERE id = $1', [accountId])).rows[0];
      if (!account) return res.status(404).json({ error: 'Account not found' });
      const result = await accountStatsService.auditOne(account);
      return res.json(result);
    }

    // Kick off without blocking forever — still await for manual runs of full batch
    const result = await accountStatsService.runDailyAudit({ limit });
    res.json(result);
  } catch (error) {
    console.error('account stats run error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
