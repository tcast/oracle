const express = require('express');
const router = express.Router();
const pool = require('../services/db');
const { authMiddleware } = require('../middleware/auth');

// Apply authentication middleware
router.use(authMiddleware);

/**
 * @route GET /api/campaigns
 * @desc Get all campaigns
 * @access Private
 */
router.get('/', async (req, res) => {
  try {
    const campaigns = await pool.query('SELECT * FROM campaigns WHERE user_id = $1', [req.user.id]);
    res.json(campaigns.rows);
  } catch (error) {
    console.error('Error fetching campaigns:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @route GET /api/campaigns/:id
 * @desc Get a specific campaign
 * @access Private
 */
router.get('/:id', async (req, res) => {
  try {
    const campaign = await pool.query('SELECT * FROM campaigns WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    
    if (campaign.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    
    res.json(campaign.rows[0]);
  } catch (error) {
    console.error('Error fetching campaign:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @route GET /api/campaigns/:id/subreddits
 * @desc Get subreddits for a specific campaign
 * @access Private
 */
router.get('/:id/subreddits', async (req, res) => {
  try {
    const subreddits = await pool.query(
      'SELECT * FROM subreddit_suggestions WHERE campaign_id = $1', 
      [req.params.id]
    );
    
    res.json(subreddits.rows);
  } catch (error) {
    console.error('Error fetching subreddits for campaign:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @route POST /api/campaigns/:id/generate-subreddits
 * @desc Generate subreddit suggestions for a campaign
 * @access Private
 */
router.post('/:id/generate-subreddits', async (req, res) => {
  try {
    // Get campaign details
    const campaign = await pool.query('SELECT * FROM campaigns WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    
    if (campaign.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    
    const campaignData = campaign.rows[0];
    
    // For demonstration purposes, generate mock subreddit suggestions
    // In a real implementation, this would call an AI service or other logic to generate suggestions
    const mockSuggestions = [
      {
        id: Date.now() + 1,
        subreddit_name: 'ArtificialIntelligence',
        reason: 'Popular subreddit for AI discussions',
        subscriber_count: 500000,
        status: 'pending'
      },
      {
        id: Date.now() + 2,
        subreddit_name: 'MachineLearning',
        reason: 'Technical discussions about machine learning',
        subscriber_count: 1200000,
        status: 'pending'
      },
      {
        id: Date.now() + 3,
        subreddit_name: 'tech',
        reason: 'General technology discussions',
        subscriber_count: 800000,
        status: 'pending'
      }
    ];
    
    // Store suggestions in database (simplified for demonstration)
    // In a real implementation, you would insert these into the database
    // and return the inserted records
    
    res.json(mockSuggestions);
  } catch (error) {
    console.error('Error generating subreddit suggestions:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @route POST /api/campaigns
 * @desc Create a new campaign
 * @access Private
 */
router.post('/', async (req, res) => {
  try {
    const { name, description, target_audience, goals, campaign_goal, campaign_overview, post_goal, comment_goal, target_sentiment, platform, target_url, media_assets, is_live, posts_per_subreddit } = req.body;
    
    const newCampaign = await pool.query(
      `INSERT INTO campaigns (name, description, target_audience, goals, campaign_goal, campaign_overview, post_goal, comment_goal, target_sentiment, platform, target_url, media_assets, is_live, user_id, posts_per_subreddit)
       VALUES ($1, $2, $3, $4, $5, $6, $7::integer, $8::integer, $9::numeric, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [name, description, target_audience, goals, campaign_goal, campaign_overview, parseInt(post_goal) || 5, parseInt(comment_goal) || 3, target_sentiment === 'positive' ? 0.7 : target_sentiment === 'negative' ? 0.3 : 0.5, platform, target_url, JSON.stringify(media_assets || []), is_live || false, req.user.id, posts_per_subreddit || 3]
    );
    
    res.status(201).json(newCampaign.rows[0]);
  } catch (error) {
    console.error('Error creating campaign:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @route PATCH /api/campaigns/:id
 * @desc Update a campaign
 * @access Private
 */
router.patch('/:id', async (req, res) => {
  try {
    const { name, description, target_audience, goals } = req.body;
    
    const updatedCampaign = await pool.query(
      'UPDATE campaigns SET name = $1, description = $2, target_audience = $3, goals = $4 WHERE id = $5 AND user_id = $6 RETURNING *',
      [name, description, target_audience, goals, req.params.id, req.user.id]
    );
    
    if (updatedCampaign.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    
    res.json(updatedCampaign.rows[0]);
  } catch (error) {
    console.error('Error updating campaign:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @route DELETE /api/campaigns/:id
 * @desc Delete a campaign
 * @access Private
 */
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM campaigns WHERE id = $1 AND user_id = $2 RETURNING *', [req.params.id, req.user.id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    
    res.json({ message: 'Campaign deleted successfully' });
  } catch (error) {
    console.error('Error deleting campaign:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;