const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const nocService = require('../services/nocService');
const proxyService = require('../services/proxyService');
const pool = require('../services/db');

router.use(authMiddleware);

/** Single aggregated payload for the NOC dashboard */
router.get('/dashboard', async (req, res) => {
  try {
    const data = await nocService.getDashboard();
    res.json(data);
  } catch (error) {
    console.error('NOC dashboard error:', error);
    res.status(500).json({ error: error.message || 'Failed to load NOC dashboard' });
  }
});

/** Rate-limited lightweight probe for one proxy */
router.post('/proxies/:id/probe', async (req, res) => {
  try {
    const force = req.body?.force === true || req.query.force === 'true';
    const result = await proxyService.probeProxyHealth(Number(req.params.id), { force });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * Probe up to N free/degraded active proxies (rate-limited each).
 * Does not start account creation.
 */
router.post('/proxies/probe-batch', async (req, res) => {
  try {
    const limit = Math.min(5, Math.max(1, Number(req.body?.limit) || 3));
    const force = req.body?.force === true;

    const candidates = await pool.query(
      `SELECT id FROM proxies
       WHERE is_active = true
         AND (
           consecutive_failures >= 1
           OR last_health_ok = false
           OR last_health_check_at IS NULL
           OR last_health_check_at < NOW() - INTERVAL '30 minutes'
         )
         AND (cooldown_until IS NULL OR cooldown_until <= NOW())
       ORDER BY consecutive_failures DESC NULLS LAST,
                last_health_check_at ASC NULLS FIRST
       LIMIT $1`,
      [limit]
    );

    const results = [];
    for (const row of candidates.rows) {
      // eslint-disable-next-line no-await-in-loop
      const r = await proxyService.probeProxyHealth(row.id, { force });
      results.push({ proxy_id: row.id, ...r });
    }

    res.json({ probed: results.length, results });
  } catch (error) {
    console.error('NOC probe-batch error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
