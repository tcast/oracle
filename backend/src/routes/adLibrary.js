const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const pool = require('../services/db');
const brandService = require('../services/brandService');
const adCreativeService = require('../services/adCreativeService');
const adLibraryService = require('../services/adLibraryService');

const router = express.Router();
router.use(['/brands', '/campaigns'], authMiddleware);

async function requireBrand(req, res, role = 'viewer') {
  const ok = await brandService.userHasBrandAccess(req.user.id, req.params.id, role);
  if (!ok) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

async function requireCampaign(req, res, role = 'viewer') {
  const { rows } = await pool.query('SELECT brand_id FROM campaigns WHERE id = $1', [req.params.id]);
  if (!rows[0]) {
    res.status(404).json({ error: 'Campaign not found' });
    return null;
  }
  const ok = await brandService.userHasBrandAccess(req.user.id, rows[0].brand_id, role);
  if (!ok) {
    res.status(403).json({ error: 'Forbidden' });
    return null;
  }
  return rows[0];
}

router.get('/brands/:id/ads', async (req, res) => {
  try {
    if (!await requireBrand(req, res)) return;
    res.json(await adLibraryService.listCreatives(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/brands/:id/ads', async (req, res) => {
  try {
    if (!await requireBrand(req, res, 'editor')) return;
    if (!req.body.name) return res.status(400).json({ error: 'name required' });
    const row = await adLibraryService.createCreative(req.params.id, req.user.id, req.body);
    res.status(201).json(row);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/brands/:id/ads/generate', async (req, res) => {
  try {
    if (!await requireBrand(req, res, 'editor')) return;
    const name = req.body.name || 'Untitled ad';
    const brief = req.body.brief || '';
    const result = await adCreativeService.buildBrandAdCreative(req.params.id, {
      name,
      brief,
      targetUrl: req.body.target_url,
      format: req.body.copy_format || 'both',
      visual_format: req.body.visual_format || 'square',
      style: req.body.style || 'clean product marketing',
      include_visual: req.body.include_visual !== false,
    });
    const referenceAssets = result.visual?.reference_assets || [];
    const saved = await adLibraryService.createCreative(req.params.id, req.user.id, {
      name,
      brief,
      format: req.body.visual_format || 'square',
      status: 'draft',
      content: result.creative,
      image_url: result.creative.image_url,
      asset_ids: referenceAssets.map((asset) => asset.id),
      generation_meta: {
        used_brand_assets: result.visual?.used_brand_assets || false,
        reference_assets: referenceAssets,
        generated_at: new Date().toISOString(),
      },
    });
    res.status(201).json({ ...saved, result });
  } catch (err) {
    console.error('Standalone ad generation error:', err);
    res.status(400).json({ error: err.message });
  }
});

router.patch('/brands/:id/ads/:adId', async (req, res) => {
  try {
    if (!await requireBrand(req, res, 'editor')) return;
    const row = await adLibraryService.updateCreative(req.params.id, req.params.adId, req.body);
    if (!row) return res.status(404).json({ error: 'Ad not found' });
    res.json(row);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/brands/:id/ads/:adId', async (req, res) => {
  try {
    if (!await requireBrand(req, res, 'editor')) return;
    const row = await adLibraryService.deleteCreative(req.params.id, req.params.adId);
    if (!row) return res.status(404).json({ error: 'Ad not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/campaigns/:id/ads', async (req, res) => {
  try {
    if (!await requireCampaign(req, res)) return;
    res.json(await adLibraryService.listCampaignCreatives(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/campaigns/:id/ads', async (req, res) => {
  try {
    if (!await requireCampaign(req, res, 'editor')) return;
    if (!req.body.ad_creative_id) {
      return res.status(400).json({ error: 'ad_creative_id required' });
    }
    res.status(201).json(
      await adLibraryService.linkCreative(req.params.id, req.body.ad_creative_id)
    );
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/campaigns/:id/ads/:adId', async (req, res) => {
  try {
    if (!await requireCampaign(req, res, 'editor')) return;
    const row = await adLibraryService.unlinkCreative(req.params.id, req.params.adId);
    if (!row) return res.status(404).json({ error: 'Ad link not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
