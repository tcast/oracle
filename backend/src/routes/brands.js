const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authMiddleware } = require('../middleware/auth');
const brandService = require('../services/brandService');
const brandChannelService = require('../services/brandChannelService');
const adAccountService = require('../services/adAccountService');
const brandOAuthAppService = require('../services/brandOAuthAppService');
const brandAssetService = require('../services/brandAssetService');
const brandAssetParsingService = require('../services/brandAssetParsingService');

router.use(authMiddleware);

const brandUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join('uploads', 'brands', String(req.params.id));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `${unique}${path.extname(file.originalname)}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => {
    const allowedExtensions = new Set([
      '.png', '.jpg', '.jpeg', '.webp', '.gif',
      '.pdf', '.pptx', '.docx', '.txt', '.md', '.rtf', '.csv',
      '.mp4', '.mov',
    ]);
    if (allowedExtensions.has(path.extname(file.originalname).toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type'));
    }
  },
});

async function requireBrandEditor(req, res, next) {
  try {
    const ok = await brandService.userHasBrandAccess(req.user.id, req.params.id, 'editor');
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function inferAssetKind(file, requestedKind) {
  if (brandAssetService.KINDS.includes(requestedKind)) return requestedKind;
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === '.pptx' || ext === '.pdf') return 'pitch_deck';
  if (['.docx', '.txt', '.md', '.rtf', '.csv'].includes(ext)) return 'document';
  return 'other';
}


router.get('/', async (req, res) => {
  try {
    await brandService.ensureUserBrandMemberships(req.user.id);
    const brands = await brandService.listBrandsForUser(req.user.id);
    res.json(brands);
  } catch (err) {
    console.error('List brands error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, slug, website, brand_voice, logo_url } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const brand = await brandService.createBrand(req.user.id, { name, slug, website, brand_voice, logo_url });
    res.status(201).json(brand);
  } catch (err) {
    console.error('Create brand error:', err);
    res.status(400).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const brand = await brandService.getBrand(req.params.id, req.user.id);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    const channels = await brandChannelService.listChannels(brand.id);
    const adAccounts = await adAccountService.listAdAccounts(brand.id);
    const oauthApps = await brandOAuthAppService.listOAuthApps(brand.id);
    const assets = await brandAssetService.listAssets(brand.id);
    res.json({ ...brand, channels, ad_accounts: adAccounts, oauth_apps: oauthApps, assets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/assets', async (req, res) => {
  try {
    const ok = await brandService.userHasBrandAccess(req.user.id, req.params.id);
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
    res.json(await brandAssetService.listAssets(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post(
  '/:id/assets',
  requireBrandEditor,
  brandUpload.fields([{ name: 'files', maxCount: 20 }, { name: 'media', maxCount: 1 }]),
  async (req, res) => {
  try {
    const files = [...(req.files?.files || []), ...(req.files?.media || [])];
    if (!files.length) return res.status(400).json({ error: 'At least one file is required' });

    const assets = [];
    for (const file of files) {
      const url = `/uploads/brands/${req.params.id}/${file.filename}`;
      const asset = await brandAssetService.addAsset(req.params.id, {
        kind: inferAssetKind(file, req.body.kind),
        label: files.length === 1 && req.body.label ? req.body.label : file.originalname,
        url,
        mime_type: file.mimetype,
        original_filename: file.originalname,
        byte_size: file.size,
        meta: { original_name: file.originalname, size: file.size },
      });
      assets.push(asset);
      brandAssetParsingService.scheduleAssetParsing(asset.id);
    }
    res.status(202).json({ assets });
  } catch (err) {
    console.error('Brand asset upload error:', err);
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/assets/:assetId/parse', requireBrandEditor, async (req, res) => {
  try {
    const asset = await brandAssetService.getAsset(req.params.id, req.params.assetId);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    brandAssetParsingService.scheduleAssetParsing(asset.id);
    res.status(202).json({ success: true, parse_status: 'pending' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/assets/:assetId', async (req, res) => {
  try {
    const ok = await brandService.userHasBrandAccess(req.user.id, req.params.id, 'editor');
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
    const row = await brandAssetService.updateAsset(req.params.id, req.params.assetId, req.body);
    if (!row) return res.status(404).json({ error: 'Asset not found' });
    res.json(row);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id/assets/:assetId', async (req, res) => {
  try {
    const ok = await brandService.userHasBrandAccess(req.user.id, req.params.id, 'editor');
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
    const row = await brandAssetService.deleteAsset(req.params.id, req.params.assetId);
    if (!row) return res.status(404).json({ error: 'Asset not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/oauth-apps', async (req, res) => {
  try {
    const ok = await brandService.userHasBrandAccess(req.user.id, req.params.id);
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
    res.json(await brandOAuthAppService.listOAuthApps(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id/oauth-apps/:provider', async (req, res) => {
  try {
    const ok = await brandService.userHasBrandAccess(req.user.id, req.params.id, 'editor');
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
    const { client_id, client_secret, extra } = req.body;
    const row = await brandOAuthAppService.upsertOAuthApp(req.params.id, req.params.provider, {
      client_id,
      client_secret,
      extra,
    });
    res.json(row);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id/oauth-apps/:provider', async (req, res) => {
  try {
    const ok = await brandService.userHasBrandAccess(req.user.id, req.params.id, 'editor');
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
    const row = await brandOAuthAppService.deleteOAuthApp(req.params.id, req.params.provider);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const brand = await brandService.updateBrand(req.params.id, req.user.id, req.body);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    res.json(brand);
  } catch (err) {
    const status = err.message === 'Forbidden' ? 403 : 400;
    res.status(status).json({ error: err.message });
  }
});

router.get('/:id/channels', async (req, res) => {
  try {
    const ok = await brandService.userHasBrandAccess(req.user.id, req.params.id);
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
    res.json(await brandChannelService.listChannels(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/channels/connect/:platform', async (req, res) => {
  try {
    const ok = await brandService.userHasBrandAccess(req.user.id, req.params.id, 'editor');
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
    const platform = req.params.platform;
    const url = await brandChannelService.getAuthUrl(parseInt(req.params.id), platform, req.user.id);
    res.json({ url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id/channels/:channelId', async (req, res) => {
  try {
    const ok = await brandService.userHasBrandAccess(req.user.id, req.params.id, 'editor');
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
    const row = await brandChannelService.disconnectChannel(req.params.id, req.params.channelId);
    if (!row) return res.status(404).json({ error: 'Channel not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/ad-accounts', async (req, res) => {
  try {
    const ok = await brandService.userHasBrandAccess(req.user.id, req.params.id);
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
    res.json(await adAccountService.listAdAccounts(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/ad-accounts/connect/:platform', async (req, res) => {
  try {
    const ok = await brandService.userHasBrandAccess(req.user.id, req.params.id, 'editor');
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
    const url = await adAccountService.getAdsAuthUrl(parseInt(req.params.id), req.params.platform, req.user.id);
    res.json({ url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id/ad-accounts/:accountId', async (req, res) => {
  try {
    const ok = await brandService.userHasBrandAccess(req.user.id, req.params.id, 'editor');
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
    const row = await adAccountService.disconnectAdAccount(req.params.id, req.params.accountId);
    if (!row) return res.status(404).json({ error: 'Ad account not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
