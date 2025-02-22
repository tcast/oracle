const express = require('express');
const router = express.Router();
const pool = require('../services/db');
const subredditService = require('../services/subredditService');

router.get('/campaigns/:id/subreddits', async (req, res) => {
  try {
    const suggestions = await subredditService.getSubredditsForCampaign(req.params.id);
    res.json(suggestions);
  } catch (err) {
    console.error('Error fetching subreddits:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/campaigns/:id/generate-subreddits', async (req, res) => {
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
  
      res.json(suggestions);
    } catch (err) {
      console.error('Error generating subreddits:', err);
      res.status(500).json({ error: err.message });
    }
  });

router.patch('/subreddit-suggestions/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;
  
      if (!status || !['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ 
          error: 'Invalid status. Must be either "approved" or "rejected"' 
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