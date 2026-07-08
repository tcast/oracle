const express = require('express');
const router = express.Router();
const proxyService = require('../services/proxyService');
const { authMiddleware } = require('../middleware/auth');

// Get all proxies
router.get('/', authMiddleware, async (req, res) => {
  try {
    const filters = {
      type: req.query.type,
      country: req.query.country,
      is_residential: req.query.is_residential === 'true'
    };
    
    const proxies = await proxyService.getActiveProxies(filters);
    res.json(proxies);
  } catch (error) {
    console.error('Error fetching proxies:', error);
    res.status(500).json({ error: 'Failed to fetch proxies' });
  }
});

// Get proxy statistics
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const stats = await proxyService.getProxyStats();
    res.json(stats);
  } catch (error) {
    console.error('Error fetching proxy stats:', error);
    res.status(500).json({ error: 'Failed to fetch proxy statistics' });
  }
});

// Create a new proxy
router.post('/', authMiddleware, async (req, res) => {
  try {
    const proxy = await proxyService.createProxy(req.body);
    res.status(201).json(proxy);
  } catch (error) {
    console.error('Error creating proxy:', error);
    res.status(500).json({ error: 'Failed to create proxy' });
  }
});

// Bulk import proxies
router.post('/bulk', authMiddleware, async (req, res) => {
  try {
    const { proxies } = req.body;
    if (!Array.isArray(proxies)) {
      return res.status(400).json({ error: 'Proxies must be an array' });
    }
    
    const results = await proxyService.bulkImportProxies(proxies);
    res.json({
      total: results.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results
    });
  } catch (error) {
    console.error('Error bulk importing proxies:', error);
    res.status(500).json({ error: 'Failed to bulk import proxies' });
  }
});

// Test a proxy
router.post('/:id/test', authMiddleware, async (req, res) => {
  try {
    const result = await proxyService.testProxy(req.params.id);
    res.json(result);
  } catch (error) {
    console.error('Error testing proxy:', error);
    res.status(500).json({ error: 'Failed to test proxy' });
  }
});

// Enable/disable proxy
router.patch('/:id/status', authMiddleware, async (req, res) => {
  try {
    const { is_active } = req.body;
    if (is_active) {
      await proxyService.enableProxy(req.params.id);
    } else {
      await proxyService.disableProxy(req.params.id);
    }
    res.json({ success: true, status: is_active ? 'enabled' : 'disabled' });
  } catch (error) {
    console.error('Error updating proxy status:', error);
    res.status(500).json({ error: 'Failed to update proxy status' });
  }
});

// Get proxies for a social account
router.get('/account/:accountId', authMiddleware, async (req, res) => {
  try {
    const proxies = await proxyService.getAccountProxies(
      req.params.accountId,
      req.query.only_active !== 'false'
    );
    res.json(proxies);
  } catch (error) {
    console.error('Error fetching account proxies:', error);
    res.status(500).json({ error: 'Failed to fetch account proxies' });
  }
});

// Assign proxies to a social account
router.post('/account/:accountId/assign', authMiddleware, async (req, res) => {
  try {
    const { proxy_ids } = req.body;
    if (!Array.isArray(proxy_ids)) {
      return res.status(400).json({ error: 'proxy_ids must be an array' });
    }
    
    const assignments = await proxyService.assignProxiesToAccount(
      req.params.accountId,
      proxy_ids
    );
    
    res.json({
      success: true,
      assigned: assignments.length,
      assignments
    });
  } catch (error) {
    console.error('Error assigning proxies:', error);
    res.status(500).json({ error: 'Failed to assign proxies' });
  }
});

// Remove proxy from account
router.delete('/account/:accountId/proxy/:proxyId', authMiddleware, async (req, res) => {
  try {
    const pool = require('../services/db');
    await pool.query(
      'UPDATE social_account_proxies SET is_active = false WHERE social_account_id = $1 AND proxy_id = $2',
      [req.params.accountId, req.params.proxyId]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error removing proxy from account:', error);
    res.status(500).json({ error: 'Failed to remove proxy from account' });
  }
});

module.exports = router;
