const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const activityEventService = require('../services/activityEventService');

router.use(authMiddleware);

/** GET /api/activity — filterable cross-platform activity feed */
router.get('/', async (req, res) => {
  try {
    const {
      platform,
      action,
      account_id,
      result,
      since,
      until,
      limit,
      offset,
    } = req.query || {};

    const data = await activityEventService.list({
      platform,
      action,
      account_id,
      result,
      since,
      until,
      limit,
      offset,
    });
    res.json(data);
  } catch (error) {
    console.error('activity list error:', error);
    res.status(500).json({ error: error.message || 'Failed to load activity' });
  }
});

/** POST /api/activity/backfill — re-run recent backfill (admin/manual) */
router.post('/backfill', async (req, res) => {
  try {
    const days = Number(req.body?.days) || 14;
    const perSource = Number(req.body?.per_source) || 500;
    activityEventService.resetBackfillGate();
    const result = await activityEventService.backfillRecent({ days, perSource });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
