const express = require('express');
const router = express.Router();
const pool = require('../services/db');
const { authMiddleware } = require('../middleware/auth');
const campaignBuilderService = require('../services/campaignBuilderService');
const subredditService = require('../services/subredditService');

router.use(authMiddleware);

async function resolveUserId(req) {
  const { id, email } = req.user || {};
  if (id) {
    const byId = await pool.query('SELECT id FROM users WHERE id = $1', [id]);
    if (byId.rows.length) return byId.rows[0].id;
  }
  if (email) {
    const byEmail = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (byEmail.rows.length) return byEmail.rows[0].id;
  }
  return null;
}

router.post('/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const result = await campaignBuilderService.chat(messages);
    res.json(result);
  } catch (error) {
    console.error('Campaign builder chat error:', error);
    res.status(500).json({ error: error.message || 'Failed to process message' });
  }
});

router.post('/create', async (req, res) => {
  const client = await pool.connect();
  try {
    const draft = req.body;
    const {
      name,
      campaign_overview,
      campaign_goal,
      post_goal,
      comment_goal,
      target_sentiment,
      platform,
      networks,
      target_url,
      media_assets,
      suggested_subreddits,
      brand_id,
      whisper_enabled,
      overt_enabled,
      ads_enabled,
      overt_platforms,
    } = draft;

    if (!name || !campaign_overview) {
      return res.status(400).json({ error: 'Campaign name and overview are required' });
    }
    if (!brand_id) {
      return res.status(400).json({ error: 'brand_id is required' });
    }

    await client.query('BEGIN');

    const platforms = platform || networks || ['reddit'];
    const sentiment =
      target_sentiment === 'positive' ? 0.7 : target_sentiment === 'negative' ? 0.3 : 0.5;

    const userId = await resolveUserId(req);

    // AI builder always creates Whisper (army) campaigns
    const result = await client.query(
      `INSERT INTO campaigns
       (name, campaign_overview, campaign_goal, post_goal, comment_goal,
        target_sentiment, is_live, platform, target_url, media_assets, user_id,
        brand_id, campaign_type, whisper_enabled, overt_enabled, ads_enabled, overt_platforms)
       VALUES ($1, $2, $3, $4, $5, $6, false, $7::text[], $8, $9::jsonb, $10,
               $11, 'whisper', true, false, false, '{}'::text[])
       RETURNING *`,
      [
        name,
        campaign_overview,
        campaign_goal || '',
        parseInt(post_goal) || 10,
        parseInt(comment_goal) || 5,
        sentiment,
        platforms,
        target_url || null,
        JSON.stringify(media_assets || []),
        userId,
        brand_id,
      ]
    );

    const campaign = result.rows[0];

    if (suggested_subreddits?.length) {
      const subredditRows = suggested_subreddits.slice(0, 10).map(name => ({
        subreddit_name: name.replace(/^\/?r\//, ''),
        reason: `Suggested for ${campaign.name} campaign`,
        subscriber_count: 0,
      }));
      await subredditService.storeSuggestions(campaign.id, subredditRows, client);
    }

    await client.query('COMMIT');

    if (!suggested_subreddits?.length && campaign_goal) {
      try {
        await subredditService.suggestSubreddits(campaign.id, campaign_goal);
      } catch (err) {
        console.warn('Auto subreddit suggestion failed:', err.message);
      }
    }

    res.status(201).json(campaign);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Campaign builder create error:', error);
    res.status(500).json({ error: error.message || 'Failed to create campaign' });
  } finally {
    client.release();
  }
});

module.exports = router;
