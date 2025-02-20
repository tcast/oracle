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

  async createSimulatedComment(post, campaign) {
    try {
      console.log('Creating simulated comment for post:', post.id);

      // Get a random account for commenting
      const account = await this.getRandomAccount('reddit');
      if (!account) {
        throw new Error('No available Reddit account found');
      }
      console.log('Selected account for comment:', account.id);

      // Generate the comment content using our new method
      const content = await this.generateComment(post, campaign);
      console.log('Generated comment content:', content);

      // Insert the comment into the database
      const result = await pool.query(
        `INSERT INTO comments 
         (post_id, social_account_id, content, status, sentiment_score, engagement_metrics, posted_at)
         VALUES ($1, $2, $3, 'simulated', $4, $5, NOW())
         RETURNING *`,
        [
          post.id,
          account.id,
          content,
          Math.random() * 2 - 1, // Random sentiment between -1 and 1
          JSON.stringify({
            likes: Math.floor(Math.random() * 50),
            replies: Math.floor(Math.random() * 5)
          })
        ]
      );

      console.log('Created comment:', result.rows[0]);
      return result.rows[0];

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

  async generateComment(post, campaign) {
    try {
      // Create dynamic persona based on campaign and post context
      const persona = this.generateCommentPersona(campaign, post);
      const prompt = this.buildCommentPrompt(post, campaign);

      console.log('Using comment persona:', persona);
      console.log('Using comment prompt:', prompt);

      const completion = await openai.createChatCompletion({
        model: "gpt-4",
        messages: [
          {
            role: "system",
            content: persona
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 1.0,        // Maximum creativity
        presence_penalty: 1.0,   // Strongly encourage unique content
        frequency_penalty: 1.0,  // Strongly discourage repetitive patterns
        top_p: 0.9              // Allow more diverse word choices
      });

      const comment = completion.data?.choices?.[0]?.message?.content.trim();
      if (!comment) throw new Error('Failed to generate comment');

      console.log('Generated comment:', comment);
      return comment;
    } catch (error) {
      console.error('Error generating comment:', error);
      throw error;
    }
  }

  generateCommentPersona(campaign, post) {
    // Analyze the post content to understand context
    const postContent = post.content.toLowerCase();
    const campaignGoal = campaign.goal;

    return `You are someone engaging naturally with this post about ${campaignGoal}.

Your role: A genuine participant in this discussion who has relevant experience to share.
Your style: Write conversationally, as if responding to a colleague or peer.
Your approach: 
- Vary your comment style (sometimes ask questions, sometimes share experiences, sometimes offer insights)
- React to specific points in the post
- Add value to the discussion
- Stay authentic and avoid generic responses
- Match the tone of the community

Remember: Each comment should feel unique and natural, as if coming from a different real person.`;
  }

  buildCommentPrompt(post, campaign) {
    return `Read this post and create a natural, engaging comment that adds value to the discussion:

POST:
${post.content}

Your comment should:
1. Reference specific points from the post
2. Share relevant personal experience
3. Encourage further discussion
4. Feel like a genuine response

Campaign context: ${campaign.goal}

Create a unique comment that naturally fits this conversation.`;
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