// backend/src/services/commentingService.js
const pool = require('./db');
const openai = require('./openai');
const seleniumService = require('./seleniumService');
const postingService = require('./postingService');

// Platform-specific comment handlers
const platformHandlers = {
  reddit: {
    createSimulatedComment: async (post, campaign, account, content) => {
      return {
        post_id: post.id,
        social_account_id: account.id,
        content,
        status: 'simulated',
        sentiment_score: Math.random() * 2 - 1,
        engagement_metrics: {
          likes: Math.floor(Math.random() * 50),
          replies: Math.floor(Math.random() * 5)
        }
      };
    },

    createLiveComment: async (post, campaign, account, content, parentCommentId = null) => {
      const platformCommentId = await seleniumService.postComment(
        'reddit',
        account.id,
        post.platform_post_id,
        content,
        parentCommentId
      );

      return {
        post_id: post.id,
        social_account_id: account.id,
        parent_comment_id: parentCommentId,
        platform_comment_id: platformCommentId,
        content,
        status: 'posted'
      };
    },

    buildPrompt: (post, campaign) => {
      return `Read this Reddit post and create a natural, engaging comment that adds value to the discussion:

POST:
${post.content}

Your comment should:
1. Reference specific points from the post
2. Share relevant personal experience
3. Encourage further discussion
4. Feel like a genuine response
5. Match the tone of Reddit and the specific subreddit (r/${post.subreddit})

Campaign context: ${campaign.comment_goal}

Create a unique comment that naturally fits this conversation.`;
    }
  },

  linkedin: {
    createSimulatedComment: async (post, campaign, account, content) => {
      return {
        post_id: post.id,
        social_account_id: account.id,
        content,
        status: 'simulated',
        sentiment_score: Math.random() * 2 - 1,
        engagement_metrics: {
          likes: Math.floor(Math.random() * 30),
          replies: Math.floor(Math.random() * 3)
        }
      };
    },

    createLiveComment: async (post, campaign, account, content, parentCommentId = null) => {
      const platformCommentId = await seleniumService.postComment(
        'linkedin',
        account.id,
        post.platform_post_id,
        content,
        parentCommentId
      );

      return {
        post_id: post.id,
        social_account_id: account.id,
        parent_comment_id: parentCommentId,
        platform_comment_id: platformCommentId,
        content,
        status: 'posted'
      };
    },

    buildPrompt: (post, campaign) => {
      return `Read this LinkedIn post and create a professional, insightful comment that adds value to the discussion:

POST:
${post.content}

Your comment should:
1. Demonstrate professional expertise
2. Share relevant industry experience
3. Add meaningful business insights
4. Maintain a professional tone
5. Encourage networking and professional discussion

Campaign context: ${campaign.comment_goal}

Create a unique comment that naturally fits this professional conversation.`;
    }
  }
};

class CommentingService {
  async createSimulatedComments(campaignId) {
    return this.createComments(campaignId, false);
  }

  async createComments(campaignId, isLive = false) {
    try {
      const posts = await this.getRecentPosts(campaignId);
      const campaign = await this.getCampaign(campaignId);
      
      if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);

      for (const post of posts) {
        // Get existing comment authors for this post to exclude them
        const existingAuthors = await this.getPostCommentAuthors(post.id);
        console.log(`Post ${post.id} has existing authors:`, existingAuthors);

        const numComments = Math.floor(Math.random() * 3) + 2; // 2-4 comments
        console.log(`Generating ${numComments} comments for post ${post.id}`);

        for (let i = 0; i < numComments; i++) {
          try {
            await this.createComment(post, campaign, isLive, existingAuthors);
            // Add a small delay between comments
            await new Promise(resolve => setTimeout(resolve, Math.random() * 500 + 500));
          } catch (error) {
            if (error.message.includes('No available accounts')) {
              console.log('No more unique accounts available for commenting');
              break;
            }
            console.error(`Error creating comment ${i + 1}:`, error);
          }
        }

        // 30% chance to create a reply to an existing comment
        if (Math.random() < 0.3) {
          const randomComment = await this.getRandomPostComment(post.id);
          if (randomComment) {
            const existingReplyAuthors = await this.getCommentReplyAuthors(randomComment.id);
            try {
              await this.createComment(post, campaign, isLive, [...existingAuthors, ...existingReplyAuthors], randomComment.id);
            } catch (error) {
              console.error('Error creating reply:', error);
            }
          }
        }
      }
    } catch (error) {
      console.error('Error creating comments:', error);
      throw error;
    }
  }

  async createComment(post, campaign, isLive = false, excludeAccountIds = [], parentCommentId = null) {
    try {
      // Check live mode constraints
      if (isLive) {
        const now = new Date();
        const startDate = campaign.start_date ? new Date(campaign.start_date) : null;
        const endDate = campaign.end_date ? new Date(campaign.end_date) : null;

        if (startDate && now < startDate) {
          throw new Error('Campaign has not started yet');
        }
        if (endDate && now > endDate) {
          throw new Error('Campaign has ended');
        }

        // Check if enough time has passed since last comment
        const lastComment = await this.getLastComment(campaign.id);
        if (lastComment) {
          const hoursSinceLastComment = (now - new Date(lastComment.posted_at)) / (1000 * 60 * 60);
          if (hoursSinceLastComment < campaign.min_reply_interval_hours) {
            throw new Error('Minimum reply interval not reached');
          }
        }
      }

      const handler = platformHandlers[post.platform];
      if (!handler) throw new Error(`Unsupported platform: ${post.platform}`);

      // Get a random account that hasn't commented on this post yet
      const account = await this.getRandomAccount(post.platform, excludeAccountIds);
      if (!account) throw new Error(`No available ${post.platform} accounts found for commenting`);

      const content = await this.generateComment(post, campaign, handler);

      const commentData = await (isLive ?
        handler.createLiveComment(post, campaign, account, content, parentCommentId) :
        handler.createSimulatedComment(post, campaign, account, content));

      const result = await pool.query(
        `INSERT INTO comments 
         (post_id, social_account_id, parent_comment_id, platform_comment_id,
          content, status, sentiment_score, engagement_metrics, posted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         RETURNING *`,
        [
          commentData.post_id,
          commentData.social_account_id,
          parentCommentId,
          commentData.platform_comment_id,
          commentData.content,
          commentData.status,
          commentData.sentiment_score,
          commentData.engagement_metrics
        ]
      );

      return result.rows[0];
    } catch (error) {
      console.error('Error creating comment:', error);
      throw error;
    }
  }

  async generateComment(post, campaign, handler) {
    try {
      const persona = this.generateCommentPersona(campaign, post);
      const prompt = handler.buildPrompt(post, campaign);

      const completion = await openai.createChatCompletion({
        model: "gpt-4",
        messages: [
          { role: "system", content: persona },
          { role: "user", content: prompt }
        ],
        temperature: 1.0,
        presence_penalty: 1.0,
        frequency_penalty: 1.0,
        top_p: 0.9
      });

      const comment = completion.data?.choices?.[0]?.message?.content.trim();
      if (!comment) throw new Error('Failed to generate comment');

      return comment;
    } catch (error) {
      console.error('Error generating comment:', error);
      throw error;
    }
  }

  generateCommentPersona(campaign, post) {
    return `You are someone engaging naturally with this ${post.platform} post about ${campaign.campaign_goal}.

Your role: A genuine participant in this discussion who has relevant experience to share.
Your style: Write conversationally, matching the tone of ${post.platform}.
Your approach: 
- Vary your comment style (sometimes ask questions, sometimes share experiences, sometimes offer insights)
- React to specific points in the post
- Add value to the discussion
- Stay authentic and avoid generic responses
- Match the tone of the platform and community

Remember: Each comment should feel unique and natural, as if coming from a different real person.`;
  }

  async getCampaign(campaignId) {
    const result = await pool.query(
      'SELECT * FROM campaigns WHERE id = $1',
      [campaignId]
    );
    return result.rows[0];
  }

  async getRecentPosts(campaignId) {
    const result = await pool.query(
      `SELECT * FROM posts 
       WHERE campaign_id = $1 
       AND status = 'simulated'
       ORDER BY created_at DESC 
       LIMIT 5`,
      [campaignId]
    );
    return result.rows;
  }

  async getPostCommentAuthors(postId) {
    const result = await pool.query(
      'SELECT DISTINCT social_account_id FROM comments WHERE post_id = $1',
      [postId]
    );
    return result.rows.map(row => row.social_account_id);
  }

  async getRandomPostComment(postId) {
    const result = await pool.query(
      `SELECT * FROM comments 
       WHERE post_id = $1 AND parent_comment_id IS NULL
       ORDER BY RANDOM() 
       LIMIT 1`,
      [postId]
    );
    return result.rows[0];
  }

  async getCommentById(commentId) {
    const result = await pool.query(
      'SELECT * FROM comments WHERE id = $1',
      [commentId]
    );
    return result.rows[0];
  }

  async getAccountById(accountId) {
    const result = await pool.query(
      'SELECT * FROM social_accounts WHERE id = $1',
      [accountId]
    );
    return result.rows[0];
  }

  async createLiveComments(campaignId) {
    const posts = await this.getRecentPosts(campaignId);
    
    for (const post of posts) {
      const shouldComment = await this.shouldCreateComment(post);
      if (shouldComment) {
        await this.createLiveComment(post.id, campaignId);
      }
    }
  }

  async createLiveComment(postId, campaignId, parentCommentId = null) {
    const campaign = await this.getCampaign(campaignId);
    if (!campaign) return;

    const post = await this.getPost(postId);
    const content = await this.generateContent(
      'comment',
      campaign,
      { postContent: post.content }
    );
    const account = await this.getRandomAccount('reddit');

    try {
      const platformCommentId = await seleniumService.postComment(
        'reddit',
        account.id,
        post.platform_post_id,
        content,
        parentCommentId
      );

      const comment = await pool.query(
        `INSERT INTO comments 
         (post_id, social_account_id, parent_comment_id, platform_comment_id,
          content, status, posted_at)
         VALUES ($1, $2, $3, $4, $5, 'posted', NOW())
         RETURNING *`,
        [postId, account.id, parentCommentId, platformCommentId, content]
      );

      return comment.rows[0];
    } catch (error) {
      console.error('Error creating live comment:', error);
      throw error;
    }
  }

  async getPost(postId) {
    const result = await pool.query(
      'SELECT * FROM posts WHERE id = $1',
      [postId]
    );
    return result.rows[0];
  }

  async getRandomAccount(platform, excludeIds = []) {
    try {
      const query = `
        SELECT * FROM social_accounts 
        WHERE platform = $1 
        AND status = 'active'
        ${excludeIds.length > 0 ? 'AND id != ANY($2)' : ''}
        ORDER BY RANDOM()
        LIMIT 1`;
      
      const params = excludeIds.length > 0 ? [platform, excludeIds] : [platform];
      const result = await pool.query(query, params);
      
      if (!result.rows[0]) {
        // If no accounts are available (excluding the excluded ones), create a new one
        const username = `user_${Math.floor(Math.random() * 10000)}`;
        const newAccount = await pool.query(
          `INSERT INTO social_accounts 
           (platform, username, credentials, status)
           VALUES ($1, $2, $3, 'active')
           RETURNING *`,
          [
            platform,
            username,
            JSON.stringify({ password: 'default_password' })
          ]
        );
        return newAccount.rows[0];
      }

      return result.rows[0];
    } catch (error) {
      console.error('Error getting random account:', error);
      throw error;
    }
  }

  async shouldCreateComment(post) {
    const timeSincePost = Date.now() - new Date(post.posted_at).getTime();
    const hoursSincePost = timeSincePost / (1000 * 60 * 60);
    
    if (hoursSincePost < 1) return true;
    if (hoursSincePost > 24) return false;
    
    return Math.random() < (1 / hoursSincePost);
  }

  async getLastComment(campaignId) {
    const result = await pool.query(
      `SELECT c.* FROM comments c
       JOIN posts p ON c.post_id = p.id
       WHERE p.campaign_id = $1
       ORDER BY c.posted_at DESC LIMIT 1`,
      [campaignId]
    );
    return result.rows[0];
  }

  async getCommentReplyAuthors(commentId) {
    const result = await pool.query(
      'SELECT DISTINCT social_account_id FROM comments WHERE parent_comment_id = $1',
      [commentId]
    );
    return result.rows.map(row => row.social_account_id);
  }
}

module.exports = new CommentingService();