// Core service imports
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const postsRouter = require('./routes/posts');
const subredditsRouter = require('./routes/subreddits');
const socialAccountsRouter = require('./routes/socialAccounts');
const campaignsRouter = require('./routes/campaigns');
const healthRouter = require('./routes/health');
const proxyRouter = require('./routes/proxies');
const emailAccountsRouter = require('./routes/emailAccounts');
const campaignBuilderRouter = require('./routes/campaignBuilder');
const brandsRouter = require('./routes/brands');
const oauthRouter = require('./routes/oauth');
const adLibraryRouter = require('./routes/adLibrary');

// Service imports
const pool = require('./services/db'); // Import the shared database pool
const postingService = require('./services/postingService');
const taskQueue = require('./services/taskQueue');
const organicCommentScheduler = require('./services/organicCommentScheduler');
const organicCommentsRouter = require('./routes/organicComments');
const accountStatsScheduler = require('./services/accountStatsScheduler');
const accountStatsRouter = require('./routes/accountStats');
const commentingService = require('./services/commentingService');
const playwrightService = require('./services/playwrightService');
const subredditService = require('./services/subredditService');
const campaignAccountService = require('./services/campaignAccountService');
const audiencePersonaService = require('./services/audiencePersonaService');
const campaignScorecardService = require('./services/campaignScorecardService');
const simLearningsService = require('./services/simLearningsService');
const brandService = require('./services/brandService');
const brandChannelService = require('./services/brandChannelService');
const overtPostingService = require('./services/overtPostingService');
const adAccountService = require('./services/adAccountService');
const adCampaignService = require('./services/adCampaignService');
const authService = require('./services/authService');
const initDb = require('./database/init-db');
const { authMiddleware } = require('./middleware/auth');

// Configuration
dotenv.config();
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

const openai = require('./services/openai');

// Campaign Routes (authenticated)
app.get('/api/campaigns', authMiddleware, async (req, res) => {
  try {
    await brandService.ensureUserBrandMemberships(req.user.id);
    const brandIds = await brandService.getBrandIdsForUser(req.user.id);
    const brandFilter = req.query.brand_id ? parseInt(req.query.brand_id) : null;
    const typeFilter = req.query.type === 'brand' || req.query.type === 'whisper'
      ? req.query.type
      : null;

    const result = await pool.query(
      `SELECT c.*, b.name AS brand_name, b.slug AS brand_slug
       FROM campaigns c
       LEFT JOIN brands b ON b.id = c.brand_id
       WHERE (
         c.brand_id = ANY($1::int[])
         OR c.user_id = $2
         OR cardinality($1::int[]) = 0
       )
       AND ($3::int IS NULL OR c.brand_id = $3)
       AND ($4::text IS NULL OR COALESCE(c.campaign_type, 'whisper') = $4)
       ORDER BY c.created_at DESC`,
      [brandIds, req.user.id, brandFilter, typeFilter]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/campaigns/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*, b.name AS brand_name, b.slug AS brand_slug, b.brand_voice
       FROM campaigns c
       LEFT JOIN brands b ON b.id = c.brand_id
       WHERE c.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching campaign:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaigns', authMiddleware, async (req, res) => {
  const { 
    name, 
    campaign_overview,
    campaign_goal, 
    post_goal, 
    comment_goal, 
    target_sentiment, 
    is_live, 
    networks,
    platform,
    target_url, 
    media_assets,
    brand_id,
    campaign_type,
    overt_platforms,
  } = req.body;

  const platforms = platform || networks || [];
  const type = campaign_type === 'brand' ? 'brand' : 'whisper';
  const whisper_enabled = type === 'whisper';
  const overt_enabled = type === 'brand';
  const ads_enabled = type === 'brand';

  if (!brand_id) {
    return res.status(400).json({ error: 'brand_id is required' });
  }
  const hasAccess = await brandService.userHasBrandAccess(req.user.id, brand_id, 'editor');
  if (!hasAccess) {
    return res.status(403).json({ error: 'No access to this brand' });
  }
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const campaignResult = await client.query(
      `INSERT INTO campaigns 
       (name, campaign_overview, campaign_goal, post_goal, comment_goal, 
        target_sentiment, is_live, platform, target_url, media_assets, user_id,
        brand_id, campaign_type, whisper_enabled, overt_enabled, ads_enabled, overt_platforms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10::jsonb, $11,
               $12, $13, $14, $15, $16, $17::text[])
       RETURNING *`,
      [
        name,
        campaign_overview,
        campaign_goal,
        parseInt(post_goal) || 5,
        parseInt(comment_goal) || 3,
        target_sentiment,
        is_live,
        type === 'whisper' ? platforms : (platforms.length ? platforms : ['linkedin', 'x', 'facebook', 'instagram']),
        target_url,
        media_assets ? JSON.stringify(media_assets) : null,
        req.user.id,
        brand_id,
        type,
        whisper_enabled,
        overt_enabled,
        ads_enabled,
        overt_platforms || (type === 'brand' ? ['linkedin', 'x', 'facebook', 'instagram'] : []),
      ]
    );
    
    if (is_live && platforms?.includes('reddit')) {
      const accounts = await playwrightService.verifyAccounts('reddit');
      if (!accounts.length) {
        throw new Error('No valid Reddit accounts available for live mode');
      }
    }
    
    await client.query('COMMIT');
    res.json(campaignResult.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating campaign:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put('/api/campaigns/:id', authMiddleware, async (req, res) => {
  const { 
    name, 
    campaign_overview,
    campaign_goal, 
    post_goal, 
    comment_goal, 
    target_sentiment, 
    is_live, 
    platform, 
    target_url, 
    media_assets,
    posts_per_subreddit,
    brand_id,
    campaign_type,
    overt_platforms,
  } = req.body;
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Check if campaign exists
    const existingCampaign = await client.query(
      'SELECT * FROM campaigns WHERE id = $1',
      [req.params.id]
    );

    if (existingCampaign.rows.length === 0) {
      throw new Error('Campaign not found');
    }

    const nextBrandId = brand_id ?? existingCampaign.rows[0].brand_id;
    if (nextBrandId) {
      const ok = await brandService.userHasBrandAccess(req.user.id, nextBrandId, 'editor');
      if (!ok) throw new Error('No access to this brand');
    }

    const nextType = campaign_type === 'brand' || campaign_type === 'whisper'
      ? campaign_type
      : existingCampaign.rows[0].campaign_type || 'whisper';
    const whisper_enabled = nextType === 'whisper';
    const overt_enabled = nextType === 'brand';
    const ads_enabled = nextType === 'brand';

    // Update campaign
    const campaignResult = await client.query(
      `UPDATE campaigns 
       SET name = $1,
           campaign_overview = $2,
           campaign_goal = $3,
           post_goal = $4,
           comment_goal = $5,
           target_sentiment = $6,
           is_live = $7,
           platform = $8::text[],
           target_url = $9,
           media_assets = $10::jsonb,
           posts_per_subreddit = COALESCE($11, posts_per_subreddit),
           brand_id = COALESCE($12, brand_id),
           campaign_type = $13,
           whisper_enabled = $14,
           overt_enabled = $15,
           ads_enabled = $16,
           overt_platforms = COALESCE($17::text[], overt_platforms),
           updated_at = NOW()
       WHERE id = $18
       RETURNING *`,
      [
        name,
        campaign_overview,
        campaign_goal,
        parseInt(post_goal) || 5,
        parseInt(comment_goal) || 3,
        target_sentiment,
        is_live,
        platform || [],
        target_url,
        media_assets ? JSON.stringify(media_assets) : null,
        posts_per_subreddit ?? null,
        brand_id ?? null,
        nextType,
        whisper_enabled,
        overt_enabled,
        ads_enabled,
        overt_platforms || null,
        req.params.id
      ]
    );
    
    // If switching to live mode, verify accounts
    if (is_live && platform?.includes('reddit') && !existingCampaign.rows[0].is_live) {
      const accounts = await playwrightService.verifyAccounts('reddit');
      if (!accounts.length) {
        throw new Error('No valid Reddit accounts available for live mode');
      }
    }
    
    await client.query('COMMIT');
    res.json(campaignResult.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating campaign:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete('/api/campaigns/:id', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const campaignId = req.params.id;

    // Stop any running tasks
    await taskQueue.stopCampaign(campaignId);

    // Delete in order of dependencies
    // 1. Delete subreddit suggestions
    await client.query(
      'DELETE FROM subreddit_suggestions WHERE campaign_id = $1',
      [campaignId]
    );

    // 2. Delete comments
    await client.query(
      `DELETE FROM comments c
       USING posts p
       WHERE c.post_id = p.id
       AND p.campaign_id = $1`,
      [campaignId]
    );

    // 3. Delete posts
    await client.query(
      'DELETE FROM posts WHERE campaign_id = $1',
      [campaignId]
    );

    // 4. Finally delete the campaign
    await client.query(
      'DELETE FROM campaigns WHERE id = $1',
      [campaignId]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: 'Campaign and all related data deleted successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error deleting campaign:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/campaigns/:id/simulation/status', authMiddleware, async (req, res) => {
  try {
    const status = await taskQueue.getCampaignStatus(req.params.id);
    res.json(status);
  } catch (err) {
    console.error('Error getting simulation status:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/simulation/start', authMiddleware, async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id);
    const status = await taskQueue.getCampaignStatus(campaignId);
    
    if (status.isRunning) {
      return res.status(400).json({ error: 'Campaign is already running' });
    }
    
    await taskQueue.startCampaign(campaignId, false);
    res.json({ success: true, message: 'Simulation started' });
  } catch (err) {
    console.error('Error starting simulation:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/simulation/stop', authMiddleware, async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id);
    const status = await taskQueue.getCampaignStatus(campaignId);
    
    if (!status.isRunning) {
      return res.status(400).json({ error: 'Campaign is not running' });
    }
    
    await taskQueue.stopCampaign(campaignId);
    res.json({ success: true, message: 'Simulation stopped' });
  } catch (err) {
    console.error('Error stopping simulation:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/live/start', authMiddleware, async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id);
    const status = await taskQueue.getCampaignStatus(campaignId);
    if (status.isRunning) {
      return res.status(400).json({ error: 'Campaign is already running — stop it first' });
    }

    const { rows } = await pool.query('SELECT * FROM campaigns WHERE id = $1', [campaignId]);
    const campaign = rows[0];
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const type = campaign.campaign_type === 'brand' ? 'brand' : 'whisper';
    const whisperOn = type === 'whisper';
    const overtOn = type === 'brand';

    let accounts = [];
    if (whisperOn) {
      accounts = await playwrightService.verifyAccounts('reddit');
      if (!accounts.length) {
        return res.status(400).json({
          error: 'Whisper campaigns require valid Reddit accounts with credentials and proxies.',
        });
      }
      const withoutProxy = accounts.filter(a => !a.has_proxy);
      if (withoutProxy.length && process.env.REQUIRE_PROXY_FOR_LIVE !== 'false') {
        return res.status(400).json({
          error: `${withoutProxy.length} account(s) lack an active proxy. Assign proxies before going live.`,
        });
      }
    }

    if (overtOn) {
      if (!campaign.brand_id) {
        return res.status(400).json({ error: 'Brand campaigns require a brand' });
      }
      const channels = await brandChannelService.channelsForBrandPlatforms(
        campaign.brand_id,
        campaign.overt_platforms || []
      );
      if (!channels.length) {
        return res.status(400).json({
          error: 'Connect at least one brand channel (LinkedIn, X, Facebook, or Instagram) before going live.',
        });
      }
    }

    await taskQueue.startCampaign(campaignId, true);
    res.json({
      success: true,
      message: 'Live campaign started',
      accounts: accounts.length,
      campaign_type: type,
      whisper: whisperOn,
      overt: overtOn,
      ads: type === 'brand',
    });
  } catch (err) {
    console.error('Error starting live campaign:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/live/stop', authMiddleware, async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id);
    await taskQueue.stopCampaign(campaignId);
    res.json({ success: true, message: 'Live campaign stopped' });
  } catch (err) {
    console.error('Error stopping live campaign:', err);
    res.status(500).json({ error: err.message });
  }
});

// Overt brand posting
app.get('/api/campaigns/:id/overt/posts', authMiddleware, async (req, res) => {
  try {
    res.json(await overtPostingService.listOvertPosts(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/overt/posts/generate', authMiddleware, async (req, res) => {
  try {
    const { platform, channel_id } = req.body;
    if (!platform) return res.status(400).json({ error: 'platform required' });
    const post = await overtPostingService.createOvertDraft(req.params.id, platform, channel_id || null);
    res.status(201).json(post);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/overt/posts/:postId/publish', authMiddleware, async (req, res) => {
  try {
    const live = req.body.live !== false;
    const post = await overtPostingService.publishOvertPost(parseInt(req.params.postId), { live });
    res.json(post);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Ads under campaign
app.get('/api/campaigns/:id/ad-campaigns', authMiddleware, async (req, res) => {
  try {
    res.json(await adCampaignService.listAdCampaigns(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/ad-campaigns', authMiddleware, async (req, res) => {
  try {
    const {
      name,
      ad_account_id,
      ad_creative_id,
      objective,
      budget_daily_cents,
      budget_total_cents,
      targeting,
      creative,
    } = req.body;
    if (!name || !ad_account_id) {
      return res.status(400).json({ error: 'name and ad_account_id required' });
    }
    const row = await adCampaignService.createAdCampaign(req.params.id, {
      name,
      ad_account_id,
      ad_creative_id,
      objective,
      budget_daily_cents,
      budget_total_cents,
      targeting,
      creative,
    });
    res.status(201).json(row);
  } catch (err) {
    console.error('Create ad campaign error:', err.response?.data || err.message);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/ad-campaigns/:adCampaignId/status', authMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active', 'paused', 'archived'].includes(status)) {
      return res.status(400).json({ error: 'status must be active, paused, or archived' });
    }
    res.json(await adCampaignService.setAdCampaignStatus(req.params.adCampaignId, status));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/ad-campaigns/:adCampaignId/sync', authMiddleware, async (req, res) => {
  try {
    res.json(await adCampaignService.syncAdCampaignMetrics(req.params.adCampaignId));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// AI ad builders
app.post('/api/campaigns/:id/ads/text/generate', authMiddleware, async (req, res) => {
  try {
    const adCreativeService = require('./services/adCreativeService');
    const result = await adCreativeService.generateTextAds(req.params.id, {
      format: req.body.format || 'both',
      angle: req.body.angle || '',
      count: req.body.count || 3,
    });
    res.json(result);
  } catch (err) {
    console.error('Text ad builder error:', err);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/ads/visual/generate', authMiddleware, async (req, res) => {
  try {
    const adCreativeService = require('./services/adCreativeService');
    const result = await adCreativeService.generateVisualAds(req.params.id, {
      style: req.body.style || 'clean product marketing',
      format: req.body.format || 'square',
      count: req.body.count || 1,
      copyHint: req.body.copy_hint || '',
    });
    res.json(result);
  } catch (err) {
    console.error('Visual ad builder error:', err);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/ads/build', authMiddleware, async (req, res) => {
  try {
    const adCreativeService = require('./services/adCreativeService');
    const result = await adCreativeService.buildAdCreative(req.params.id, {
      format: req.body.format || 'both',
      angle: req.body.angle || '',
      style: req.body.style,
      include_visual: req.body.include_visual !== false,
      visual_format: req.body.visual_format || 'square',
      visual_count: req.body.visual_count || 1,
    });
    res.json(result);
  } catch (err) {
    console.error('Ad build error:', err);
    res.status(400).json({ error: err.message });
  }
});

// Campaign account assignment
app.get('/api/campaigns/:id/accounts', authMiddleware, async (req, res) => {
  try {
    const accounts = await campaignAccountService.list(req.params.id);
    res.json(accounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/accounts', authMiddleware, async (req, res) => {
  try {
    const { social_account_id, role } = req.body;
    if (!social_account_id) return res.status(400).json({ error: 'social_account_id required' });
    const row = await campaignAccountService.assign(req.params.id, social_account_id, role);
    res.json(row);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/campaigns/:id/accounts/:accountId', authMiddleware, async (req, res) => {
  try {
    const row = await campaignAccountService.unassign(req.params.id, req.params.accountId);
    if (!row) return res.status(404).json({ error: 'Assignment not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/accounts/:accountId/warmup', authMiddleware, async (req, res) => {
  try {
    const result = await playwrightService.warmUpAccount(parseInt(req.params.accountId), 'reddit');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// External engagement targets
app.get('/api/campaigns/:id/engagement-targets', authMiddleware, async (req, res) => {
  try {
    res.json(await campaignAccountService.listEngagementTargets(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/engagement-targets', authMiddleware, async (req, res) => {
  try {
    const target = await campaignAccountService.addEngagementTarget(req.params.id, req.body);
    res.json(target);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/campaigns/:id/engagement-targets/:targetId', authMiddleware, async (req, res) => {
  try {
    const target = await campaignAccountService.updateEngagementTarget(
      req.params.id, req.params.targetId, req.body
    );
    res.json(target);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/campaigns/:id/engagement-targets/:targetId', authMiddleware, async (req, res) => {
  try {
    await campaignAccountService.deleteEngagementTarget(req.params.id, req.params.targetId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Audience personas + scorecard
app.get('/api/campaigns/:id/personas', authMiddleware, async (req, res) => {
  try {
    res.json(await audiencePersonaService.list(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/personas/generate', authMiddleware, async (req, res) => {
  try {
    const { scope_type, scope_key } = req.body || {};
    if (scope_type === 'platform' && scope_key) {
      const persona = await audiencePersonaService.generateForPlatform(req.params.id, scope_key);
      return res.json({ added: [persona], all: await audiencePersonaService.list(req.params.id) });
    }
    if (scope_type === 'subreddit' && scope_key) {
      const persona = await audiencePersonaService.generateForSubreddit(req.params.id, {
        subreddit_name: scope_key,
      });
      return res.json({ added: [persona], all: await audiencePersonaService.list(req.params.id) });
    }
    const added = await audiencePersonaService.generateForApprovedSubreddits(req.params.id);
    res.json({ added, all: await audiencePersonaService.list(req.params.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/campaigns/:id/scorecard', authMiddleware, async (req, res) => {
  try {
    res.json(await campaignScorecardService.getScorecard(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/campaigns/:id/sim-runs', authMiddleware, async (req, res) => {
  try {
    res.json(await simLearningsService.listRuns(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/campaigns/:id/sim-runs/:runId', authMiddleware, async (req, res) => {
  try {
    const run = await simLearningsService.getRun(req.params.id, req.params.runId);
    if (!run) return res.status(404).json({ error: 'Sim run not found' });
    res.json(run);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Posts and Comments Routes
app.get('/api/campaigns/:id/posts/list', authMiddleware, async (req, res) => {
  try {
    const posts = await postingService.listPostsForReview(req.params.id);
    res.json(posts);
  } catch (err) {
    console.error('Error fetching post list:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/posts/generate', authMiddleware, async (req, res) => {
  try {
    const count = Math.min(Math.max(parseInt(req.body.count) || 3, 1), 10);
    const added = await postingService.generateDraftPosts(req.params.id, count);
    const all = await postingService.listPostsForReview(req.params.id);
    res.json({ added, all });
  } catch (err) {
    console.error('Error generating draft posts:', err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/campaigns/:id/posts/:postId/status', authMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    const post = await postingService.updatePostStatus(req.params.postId, req.params.id, status);
    res.json(post);
  } catch (err) {
    console.error('Error updating post status:', err);
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/campaigns/:id/posts/:postId', authMiddleware, async (req, res) => {
  try {
    const deletedPost = await postingService.deletePost(req.params.postId, req.params.id);
    if (!deletedPost) {
      return res.status(404).json({ error: 'Post not found' });
    }
    res.json({ success: true, data: deletedPost });
  } catch (err) {
    console.error('Error deleting post:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/campaigns/:id/posts', authMiddleware, async (req, res) => {
  try {
    const campaignId = req.params.id;
    
    // Get all posts with their authors
    const postsResult = await pool.query(
      `SELECT 
        p.*,
        sa.username as posted_by
       FROM posts p
       LEFT JOIN social_accounts sa ON p.social_account_id = sa.id
       WHERE p.campaign_id = $1
       ORDER BY p.posted_at DESC`,
      [campaignId]
    );

    // Get all comments with their authors
    const commentsResult = await pool.query(
      `SELECT 
        c.*,
        sa.username as commented_by
       FROM comments c
       JOIN posts p ON c.post_id = p.id
       LEFT JOIN social_accounts sa ON c.social_account_id = sa.id
       WHERE p.campaign_id = $1
       ORDER BY c.posted_at ASC`,
      [campaignId]
    );

    // Organize comments into threads
    const commentsByPost = {};
    commentsResult.rows.forEach(comment => {
      if (!commentsByPost[comment.post_id]) {
        commentsByPost[comment.post_id] = [];
      }
      commentsByPost[comment.post_id].push(comment);
    });

    // Build comment trees
    const buildCommentTree = (comments, parentId = null) => {
      const result = [];
      comments
        .filter(c => c.parent_comment_id === parentId)
        .forEach(comment => {
          result.push({
            ...comment,
            replies: buildCommentTree(comments, comment.id)
          });
        });
      return result;
    };

    // Organize posts by platform and subreddit
    const organizedPosts = {
      reddit: {},
      linkedin: [],
      x: [],
      tiktok: []
    };

    // Organize posts into their respective platforms (activity feed: published only)
    postsResult.rows.forEach(post => {
      if (!['simulated', 'posted', 'publishing'].includes(post.status)) return;

      post.comments = buildCommentTree(commentsByPost[post.id] || []);
      
      if (post.platform === 'reddit') {
        if (!organizedPosts.reddit[post.subreddit]) {
          organizedPosts.reddit[post.subreddit] = [];
        }
        organizedPosts.reddit[post.subreddit].push(post);
      } else if (post.platform === 'linkedin') {
        organizedPosts.linkedin.push(post);
      } else if (post.platform === 'x') {
        organizedPosts.x.push(post);
      } else if (post.platform === 'tiktok') {
        organizedPosts.tiktok.push(post);
      }
    });

    res.json(organizedPosts);
  } catch (err) {
    console.error('Error fetching posts:', err);
    res.status(500).json({ error: err.message });
  }
});

// Analytics and Stats Routes — scoped to active/latest sim run (resets each sim)
app.get('/api/campaigns/:id/simulation/stats', authMiddleware, async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id, 10);
    const run =
      (await campaignScorecardService.getActiveRun(campaignId)) ||
      (await campaignScorecardService.getLatestRun(campaignId));

    if (!run) {
      return res.json({
        posts: 0,
        comments: 0,
        engagement: 0,
        platform_stats: {},
        sim_run_id: null,
      });
    }

    const runId = String(run.id);
    const startedAt = run.started_at;

    const result = await pool.query(
      `
      WITH post_metrics AS (
        SELECT
          platform,
          COUNT(*) as total_posts,
          COALESCE(SUM((engagement_metrics->>'upvotes')::int), 0) as total_engagement
        FROM posts
        WHERE campaign_id = $1
          AND status = 'simulated'
          AND (
            (engagement_metrics->>'sim_run_id') = $2
            OR (metadata->>'sim_run_id') = $2
            OR (
              (engagement_metrics->>'sim_run_id') IS NULL
              AND (metadata->>'sim_run_id') IS NULL
              AND COALESCE(posted_at, created_at) >= $3
            )
          )
        GROUP BY platform
      ),
      comment_metrics AS (
        SELECT
          p.platform,
          COUNT(*) as total_comments
        FROM comments c
        JOIN posts p ON c.post_id = p.id
        WHERE p.campaign_id = $1
          AND c.status = 'simulated'
          AND (
            (c.engagement_metrics->>'sim_run_id') = $2
            OR (
              (c.engagement_metrics->>'sim_run_id') IS NULL
              AND c.posted_at >= $3
            )
          )
        GROUP BY p.platform
      ),
      platform_stats AS (
        SELECT
          COALESCE(pm.platform, cm.platform) as platform,
          COALESCE(pm.total_posts, 0) as posts,
          COALESCE(cm.total_comments, 0) as comments,
          COALESCE(pm.total_engagement, 0) as engagement
        FROM post_metrics pm
        FULL OUTER JOIN comment_metrics cm ON pm.platform = cm.platform
      ),
      total_stats AS (
        SELECT
          COALESCE(SUM(posts), 0) as total_posts,
          COALESCE(SUM(comments), 0) as total_comments,
          COALESCE(SUM(engagement), 0) as total_engagement
        FROM platform_stats
      )
      SELECT
        ts.total_posts as posts,
        ts.total_comments as comments,
        ts.total_engagement as engagement,
        COALESCE(
          (
            SELECT json_object_agg(
              COALESCE(ps.platform, 'unknown'),
              json_build_object(
                'posts', ps.posts,
                'comments', ps.comments,
                'engagement', ps.engagement
              )
            )
            FROM platform_stats ps
          ),
          '{}'::json
        ) as platform_stats
      FROM total_stats ts`,
      [campaignId, runId, startedAt]
    );

    const row = result.rows[0] || {};
    res.json({
      posts: Number(row.posts) || 0,
      comments: Number(row.comments) || 0,
      engagement: Number(row.engagement) || 0,
      platform_stats: row.platform_stats || {},
      sim_run_id: run.id,
      run_status: run.status,
    });
  } catch (err) {
    console.error('Error fetching simulation stats:', err);
    res.status(500).json({ error: err.message });
  }
});

// Add this with the other analytics routes
app.get('/api/campaigns/:id/analytics', authMiddleware, async (req, res) => {
  try {
    const campaignId = req.params.id;
    
    const result = await pool.query(
      `WITH post_data AS (
        SELECT 
          DATE_TRUNC('day', posted_at) as date,
          COUNT(*) as post_count,
          SUM((engagement_metrics->>'upvotes')::int) as engagement
        FROM posts
        WHERE campaign_id = $1 AND status = 'simulated'
        GROUP BY DATE_TRUNC('day', posted_at)
      ),
      comment_data AS (
        SELECT 
          DATE_TRUNC('day', c.posted_at) as date,
          COUNT(*) as comment_count
        FROM comments c
        JOIN posts p ON c.post_id = p.id
        WHERE p.campaign_id = $1 AND c.status = 'simulated'
        GROUP BY DATE_TRUNC('day', c.posted_at)
      )
      SELECT 
        COALESCE(pd.date, cd.date) as date,
        COALESCE(pd.post_count, 0) as posts,
        COALESCE(cd.comment_count, 0) as comments,
        COALESCE(pd.engagement, 0) as engagement
      FROM post_data pd
      FULL OUTER JOIN comment_data cd ON pd.date = cd.date
      ORDER BY date ASC`,
      [campaignId]
    );

    // Transform dates to timestamps for the chart
    const analytics = result.rows.map(row => ({
      ...row,
      date: row.date ? row.date.getTime() : null,
      posts: parseInt(row.posts || 0, 10),
      comments: parseInt(row.comments || 0, 10),
      engagement: parseInt(row.engagement || 0, 10)
    })).filter(row => row.date !== null);

    res.json(analytics);
  } catch (err) {
    console.error('Error fetching analytics:', err);
    res.status(500).json({ error: err.message });
  }
});

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = 'uploads';
    try {
      await fs.mkdir(uploadDir, { recursive: true });
      cb(null, uploadDir);
    } catch (error) {
      cb(error, null);
    }
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit for videos
  },
  fileFilter: (req, file, cb) => {
    // Allow both images and videos
    if (!file.mimetype.startsWith('image/') && !file.mimetype.startsWith('video/')) {
      return cb(new Error('Only images and videos are allowed'));
    }
    
    // Additional check for video files
    if (file.mimetype.startsWith('video/')) {
      const allowedVideoTypes = ['video/mp4', 'video/quicktime'];
      if (!allowedVideoTypes.includes(file.mimetype)) {
        return cb(new Error('Only MP4 and MOV video formats are allowed'));
      }
    }
    
    cb(null, true);
  }
});

// File Upload Routes
app.post('/api/upload', authMiddleware, upload.single('media'), async (req, res) => {
  try {
    if (!req.file) {
      throw new Error('No file uploaded');
    }

    const url = `/uploads/${req.file.filename}`;
    
    // For video files, get the duration
    let duration;
    if (req.file.mimetype.startsWith('video/')) {
      // You might want to use ffmpeg or another library to get video duration
      // For now, we'll just return a placeholder duration
      duration = 0;
    }

    res.json({
      url,
      type: req.file.mimetype,
      duration
    });
  } catch (err) {
    console.error('Error uploading file:', err);
    res.status(500).json({ error: err.message });
  }
});

// Auth routes (unprotected)
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, firstName, lastName } = req.body;
    const user = await authService.registerUser(email, password, firstName, lastName);
    res.json(user);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await authService.loginUser(email, password);
    res.json(result);
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

app.post('/api/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    const tokens = await authService.refreshToken(refreshToken);
    res.json(tokens);
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    await authService.logout(refreshToken);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});


// Serve uploaded files
app.use('/uploads', express.static('uploads'));
app.use('/api/oauth', oauthRouter);
app.use('/api/brands', brandsRouter);
app.use('/api', adLibraryRouter);
app.use('/api/posts', postsRouter);
app.use('/api/subreddits', subredditsRouter);
app.use('/api/social-accounts', socialAccountsRouter);
app.use('/api/campaigns', campaignsRouter);
app.use('/api/health', healthRouter);
app.use('/api/proxies', proxyRouter);
app.use('/api/organic-comments', organicCommentsRouter);
app.use('/api/account-stats', accountStatsRouter);
app.use('/api/email-accounts', emailAccountsRouter);
app.use('/api/campaign-builder', campaignBuilderRouter);

// Add cleanup handling for graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received: closing HTTP server');
  
  // Stop all active campaigns
  for (const campaignId of taskQueue.activeCampaigns) {
    await taskQueue.stopCampaign(campaignId);
  }

  organicCommentScheduler.stop();
  accountStatsScheduler.stop();
  
  // Clean up browser sessions
  await playwrightService.cleanup();
  
  // Close database pool
  await pool.end();
  
  process.exit(0);
});

// Serve static files from the frontend build directory (any environment if dist exists)
const distPath = path.join(__dirname, '../../frontend/dist');
if (require('fs').existsSync(distPath)) {
  app.use(express.static(distPath));
  
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// Start server
app.listen(port, async () => {
  await initDb();
  await taskQueue.initialize();
  await organicCommentScheduler.start();
  await accountStatsScheduler.start();
  console.log(`Server running on port ${port}`);
});

module.exports = app;