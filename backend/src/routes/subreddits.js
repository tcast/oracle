const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const pool = require('../services/db');
const subredditService = require('../services/subredditService');

router.use(authMiddleware);

router.get('/:id', async (req, res) => {
  try {
    const suggestions = await subredditService.getSubredditsForCampaign(req.params.id);
    res.json(suggestions);
  } catch (err) {
    console.error('Error fetching subreddits:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/generate', async (req, res) => {
    try {
      const campaignId = req.params.id;
      
      // Get specific campaign
      const campaign = await pool.query(
        'SELECT * FROM campaigns WHERE id = $1',
        [campaignId]
      );
  
      if (campaign.rows.length === 0) {
        return res.status(404).json({ error: 'Campaign not found' });
      }
  
      console.log(`Generating suggestions for campaign ${campaignId} with goal:`, campaign.rows[0].campaign_goal);
  
      const suggestions = await subredditService.suggestSubreddits(
        campaignId,
        campaign.rows[0].campaign_goal
      );

      const all = await subredditService.getSubredditsForCampaign(campaignId);
      res.json({ added: suggestions, all });
    } catch (err) {
      console.error('Error generating subreddits:', err);
      res.status(500).json({ error: err.message });
    }
  });

router.post('/:id/refine', async (req, res) => {
  try {
    const campaignId = req.params.id;
    const { seedSubreddits, hint } = req.body;

    const campaign = await pool.query('SELECT id FROM campaigns WHERE id = $1', [campaignId]);
    if (campaign.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    let seeds = seedSubreddits;
    if (!seeds?.length) {
      const approved = await subredditService.getApprovedSubreddits(campaignId);
      seeds = approved.map(s => s.subreddit_name);
    }

    const newSuggestions = await subredditService.refineSubreddits(campaignId, {
      seedSubreddits: seeds,
      hint: hint || '',
    });

    const all = await subredditService.getSubredditsForCampaign(campaignId);
    res.json({ added: newSuggestions, all });
  } catch (err) {
    console.error('Error refining subreddits:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/add', async (req, res) => {
  try {
    const campaignId = req.params.id;
    const { subreddit_name, reason } = req.body;

    const campaign = await pool.query('SELECT id FROM campaigns WHERE id = $1', [campaignId]);
    if (campaign.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const suggestion = await subredditService.addManualSubreddit(campaignId, subreddit_name, reason);
    res.status(201).json(suggestion);
  } catch (err) {
    console.error('Error adding subreddit:', err);
    res.status(400).json({ error: err.message });
  }
});

router.patch('/subreddit-suggestions/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;
  
      if (!status || !['approved', 'rejected', 'pending'].includes(status)) {
        return res.status(400).json({ 
          error: 'Invalid status. Must be "approved", "rejected", or "pending"'
        });
      }
  
      const result = await subredditService.updateSuggestionStatus(id, status);
      
      if (!result) {
        return res.status(404).json({ 
          error: 'Subreddit suggestion not found' 
        });
      }
  
      res.json(result);
    } catch (err) {
      console.error('Error updating subreddit suggestion:', err);
      res.status(500).json({ error: err.message });
    }
  });

module.exports = router;