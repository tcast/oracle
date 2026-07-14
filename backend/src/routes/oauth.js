const express = require('express');
const router = express.Router();
const brandChannelService = require('../services/brandChannelService');
const adAccountService = require('../services/adAccountService');

const SOCIAL_PLATFORMS = new Set(['linkedin', 'x', 'facebook', 'instagram']);
const ADS_PLATFORMS = new Set(['google_ads', 'meta_ads']);

router.get('/:platform/callback', async (req, res) => {
  try {
    const { platform } = req.params;
    const { code, state, error, error_description } = req.query;

    if (error) {
      const redirect = `${brandChannelService.frontendUrl()}/brands?oauth_error=${encodeURIComponent(error_description || error)}`;
      return res.redirect(redirect);
    }
    if (!code || !state) {
      return res.status(400).send('Missing code or state');
    }

    let result;
    if (SOCIAL_PLATFORMS.has(platform)) {
      result = await brandChannelService.handleCallback(platform, { code, state });
    } else if (ADS_PLATFORMS.has(platform)) {
      result = await adAccountService.handleAdsCallback(platform, { code, state });
    } else {
      return res.status(400).send(`Unsupported platform: ${platform}`);
    }

    return res.redirect(result.redirect);
  } catch (err) {
    console.error('OAuth callback error:', err.response?.data || err.message);
    const msg = encodeURIComponent(err.message || 'OAuth failed');
    return res.redirect(`${brandChannelService.frontendUrl()}/brands?oauth_error=${msg}`);
  }
});

module.exports = router;
