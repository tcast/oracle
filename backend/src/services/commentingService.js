// backend/src/services/commentingService.js
const pool = require('./db');
const openai = require('./openai');
const seleniumService = require('./seleniumService');
const postingService = require('./postingService');


class CommentingService {

  async createSimulatedComments(campaignId) {
    const posts = await this.getRecentPosts(campaignId);
    
    for (const post of posts) {
      const numComments = Math.floor(Math.random() * 5) + 2; // 2-6 comments
      
      for (let i = 0; i < numComments; i++) {
        await this.createSimulatedComment(post.id, campaignId);
      }
    }
  }

  async createSimulatedComment(postId, campaignId, parentCommentId = null) {
    try {
      const campaign = await this.getCampaign(campaignId);
      if (!campaign) return;

      const post = await this.getPost(postId);
      if (!post) return;

      // Get all existing comment authors for this post
      const existingAuthors = await this.getPostCommentAuthors(postId);
      const usedIds = [...existingAuthors, post.social_account_id];

      // Decide if this should be a post author reply
      const shouldBeAuthorReply = !parentCommentId && Math.random() < 0.2; // 20% chance
      
      let account;
      let content;

      if (shouldBeAuthorReply) {
        // Get the original post author and ensure we're replying to a comment
        account = await this.getAccountById(post.social_account_id);
        const randomComment = await this.getRandomPostComment(postId);
        if (!randomComment) {
          // If no comment to reply to, make a regular comment instead
          account = await postingService.getRandomAccount('reddit', usedIds);
          content = await this.generateContent('comment', campaign, { 
            postContent: post.content 
          });
        } else {
          parentCommentId = randomComment.id;
          content = await this.generateContent('reply', campaign, { 
            postContent: post.content,
            commentContent: randomComment.content,
            isAuthorReply: true
          });
        }
      } else {
        // Get a random account that's not the post author or previous commenters
        account = await postingService.getRandomAccount('reddit', usedIds);
        
        if (parentCommentId) {
          // If this is a reply to a comment, get the parent comment
          const parentComment = await this.getCommentById(parentCommentId);
          content = await this.generateContent('reply', campaign, { 
            postContent: post.content,
            commentContent: parentComment.content
          });
        } else {
          content = await this.generateContent('comment', campaign, { 
            postContent: post.content 
          });
        }
      }

      const comment = await pool.query(
        `INSERT INTO comments 
         (post_id, social_account_id, parent_comment_id, content, status, 
          posted_at, sentiment_score, engagement_metrics)
         VALUES ($1, $2, $3, $4, 'simulated', NOW(), $5, $6)
         RETURNING *`,
        [
          postId,
          account.id,
          parentCommentId,
          content,
          Math.random() * 2 - 1,
          JSON.stringify({
            upvotes: Math.floor(Math.random() * 30) + 5
          })
        ]
      );

      // 30% chance to create a reply to this comment if it's not already a reply
      if (!parentCommentId && Math.random() < 0.3) {
        await this.createSimulatedComment(postId, campaignId, comment.rows[0].id);
      }

      return comment.rows[0];
    } catch (error) {
      console.error('Error creating simulated comment:', error);
      throw error;
    }
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

  async generateContent(type, campaign, context = {}) {
    let prompt = `Create a ${type} for the following campaign:
    
Campaign Name: ${campaign.name}
Goal: ${campaign.goal}
Target Sentiment: ${campaign.target_sentiment}

The content should:
1. Be authentic and engaging
2. Match the target sentiment
3. Align with the campaign goal
4. Feel natural for Reddit
5. Encourage further discussion
`;

    if (type === 'reply') {
      if (context.isAuthorReply) {
        prompt += `\nYou are the original post author replying to this comment: "${context.commentContent}"
Create a response that:
1. Acknowledges you're the OP (original poster)
2. Engages meaningfully with the commenter's points
3. Maintains authenticity and furthers discussion`;
      } else {
        prompt += `\nRespond to this comment: "${context.commentContent}"`;
      }
    } else if (context.postContent) {
      prompt += `\nRespond to this post content: "${context.postContent}"`;
    }

    try {
      const completion = await openai.createChatCompletion({
        model: "gpt-4",
        messages: [
          {
            role: "system",
            content: "You are an expert Reddit commenter who understands Reddit's culture and can create engaging, authentic responses that encourage discussion."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.7
      });

      return completion.data.choices[0].message.content.trim();
    } catch (error) {
      console.error('Error generating content:', error);
      if (type === 'reply' && context.isAuthorReply) {
        return "OP here - thanks for your thoughtful comment! You raise some excellent points. I'd love to hear more about your perspective on this.";
      } else if (type === 'reply') {
        return "That's a really interesting point! I've been thinking about this a lot too. What made you come to that conclusion?";
      } else {
        return "This really resonates with me. Has anyone else had similar experiences? I'd love to hear your stories.";
      }
    }
  }

  async getRecentPosts(campaignId) {
    const result = await pool.query(
      `SELECT * FROM posts 
       WHERE campaign_id = $1 
       AND posted_at > NOW() - INTERVAL '24 hours'
       ORDER BY posted_at DESC`,
      [campaignId]
    );
    return result.rows;
  }

  async getPost(postId) {
    const result = await pool.query(
      'SELECT * FROM posts WHERE id = $1',
      [postId]
    );
    return result.rows[0];
  }

  async getCampaign(campaignId) {
    const result = await pool.query(
      'SELECT * FROM campaigns WHERE id = $1',
      [campaignId]
    );
    return result.rows[0];
  }

  async getRandomAccount(platform) {
    const result = await pool.query(
      `SELECT * FROM social_accounts 
       WHERE platform = $1 AND status = 'active'
       ORDER BY last_used_at ASC NULLS FIRST
       LIMIT 1`,
      [platform]
    );
    return result.rows[0];
  }

  async shouldCreateComment(post) {
    const timeSincePost = Date.now() - new Date(post.posted_at).getTime();
    const hoursSincePost = timeSincePost / (1000 * 60 * 60);
    
    if (hoursSincePost < 1) return true;
    if (hoursSincePost > 24) return false;
    
    return Math.random() < (1 / hoursSincePost);
  }
}

module.exports = new CommentingService();