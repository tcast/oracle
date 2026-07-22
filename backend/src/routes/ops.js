const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const accountOpsBrainService = require('../services/accountOpsBrainService');

router.use(authMiddleware);

/** Capacity shortages + brain status for NOC / Social Accounts banners */
router.get('/capacity', async (req, res) => {
  try {
    const fresh = req.query.fresh === '1' || req.query.fresh === 'true';
    const cached = accountOpsBrainService.getLastCapacity();
    const data =
      fresh || !cached.computed_at
        ? await accountOpsBrainService.computeCapacity()
        : cached;
    res.json(data);
  } catch (error) {
    console.error('Ops capacity error:', error);
    res.status(500).json({ error: error.message || 'Failed to compute capacity' });
  }
});

router.get('/brain/status', async (req, res) => {
  try {
    const capacity = accountOpsBrainService.getLastCapacity();
    res.json({
      enabled: accountOpsBrainService.isEnabled(),
      capacity,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
