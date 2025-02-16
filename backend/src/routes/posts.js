const express = require('express');
const router = express.Router();
const postingService = require('../services/postingService');

// Delete a specific post and its comments
router.delete('/campaigns/:campaignId/posts/:postId', async (req, res) => {
  try {
    const { campaignId, postId } = req.params;
    const deletedPost = await postingService.deletePost(postId, campaignId);
    res.json({ 
      success: true, 
      message: 'Post and associated comments deleted successfully',
      data: deletedPost 
    });
  } catch (error) {
    console.error('Error in delete post route:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Delete all posts and comments in a campaign
router.delete('/campaigns/:campaignId/posts', async (req, res) => {
  try {
    const { campaignId } = req.params;
    const deletedPosts = await postingService.deleteAllPostsInCampaign(campaignId);
    res.json({ 
      success: true, 
      message: 'All posts and associated comments deleted successfully',
      data: {
        deletedCount: deletedPosts.length,
        posts: deletedPosts
      }
    });
  } catch (error) {
    console.error('Error in delete all posts route:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

module.exports = router;