const pool = require('./db');
const openai = require('./openai');
const seleniumService = require('./seleniumService');


class PostingService {

  constructor() {
    // Add a cache to track recently generated content
    this.recentContentCache = new Set();
    // Clear cache every 24 hours to prevent unbounded growth
    setInterval(() => this.recentContentCache.clear(), 24 * 60 * 60 * 1000);
  }



  async createSimulatedPost(campaignId) {
    try {
      console.log('Starting createSimulatedPost for campaign:', campaignId);
      
      const campaign = await this.getCampaign(campaignId);
      if (!campaign) {
        throw new Error('Campaign not found');
      }

      const subreddit = await this.getRandomApprovedSubreddit(campaignId);
      if (!subreddit) {
        throw new Error('No approved subreddits found for campaign');
      }
      console.log('Selected subreddit:', subreddit);

      const content = await this.generateContent('post', campaign, {
        platform: 'reddit',
        subreddit: subreddit.subreddit_name
      });
      console.log('Final content to be posted:', content);

      const account = await this.getRandomAccount('reddit');
      if (!account) {
        throw new Error('No available Reddit account found');
      }

      const query = `
        INSERT INTO posts 
        (campaign_id, social_account_id, subreddit, content, status, posted_at)
        VALUES ($1, $2, $3, $4, 'simulated', NOW())
        RETURNING *`;
      
      const values = [campaignId, account.id, subreddit.subreddit_name, content];
      
      console.log('Executing post creation query with values:', values);
      const result = await pool.query(query, values);
      console.log('Created post:', result.rows[0]);
      
      return result.rows[0];

    } catch (error) {
      console.error('Error creating simulated post:', error);
      throw error;
    }
  }

  async createLivePost(campaignId) {
    try {
      const campaign = await this.getCampaign(campaignId);
      if (!campaign) return;

      const subreddit = await this.getRandomApprovedSubreddit(campaignId);
      if (!subreddit) {
        throw new Error('No approved subreddits found for campaign');
      }

      const content = await this.generateContent('post', campaign, {
        platform: 'reddit',
        subreddit: subreddit.subreddit_name,
        contentRules: subreddit.content_rules
      });
      
      const account = await this.getRandomAccount('reddit');

      const post = await pool.query(
        `INSERT INTO posts 
         (campaign_id, social_account_id, subreddit, content, status, posted_at)
         VALUES ($1, $2, $3, $4, 'posted', NOW())
         RETURNING *`,
        [
          campaignId, 
          account.id, 
          subreddit.subreddit_name,
          content
        ]
      );

      return post.rows[0];
    } catch (error) {
      console.error('Error creating live post:', error);
      throw error;
    }
  }

  async getRandomApprovedSubreddit(campaignId) {
    try {
      console.log('Getting random approved subreddit for campaign:', campaignId);
      
      // First try the subreddit_suggestions table
      const suggestionsResult = await pool.query(
        `SELECT subreddit_name, reason
         FROM subreddit_suggestions
         WHERE campaign_id = $1
         AND status = 'approved'
         ORDER BY RANDOM()
         LIMIT 1`,
        [campaignId]
      );

      // If we find an approved suggestion, use it
      if (suggestionsResult.rows.length > 0) {
        console.log('Found approved subreddit from suggestions:', suggestionsResult.rows[0]);
        return {
          subreddit_name: suggestionsResult.rows[0].subreddit_name,
          content_rules: [], // Add any rules if needed
        };
      }

      // Fallback to the original campaign_subreddits table
      const originalResult = await pool.query(
        `SELECT rs.*
         FROM reddit_subreddits rs
         JOIN campaign_subreddits cs ON cs.subreddit_id = rs.id
         JOIN campaign_networks cn ON cs.campaign_network_id = cn.id
         WHERE cn.campaign_id = $1
         AND cs.status = 'approved'
         ORDER BY RANDOM()
         LIMIT 1`,
        [campaignId]
      );

      if (originalResult.rows.length === 0) {
        throw new Error('No approved subreddits found for this campaign');
      }

      console.log('Found approved subreddit from original table:', originalResult.rows[0]);
      return {
        subreddit_name: originalResult.rows[0].name,
        content_rules: originalResult.rows[0].content_rules || [],
      };

    } catch (error) {
      console.error('Error getting random subreddit:', error);
      throw error;
    }
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

  async generateContent(type, campaign, context = {}) {
    try {
      console.log('Generating content with context:', context);
      
      // Create dynamic persona and prompt
      const persona = this.generatePersona(campaign);
      const prompt = this.buildPrompt(type, campaign, context);
      
      console.log('Using persona:', persona);
      console.log('Using prompt:', prompt);
      
      if (!process.env.OPENAI_API_KEY) {
        throw new Error('OpenAI API key not configured');
      }

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
        temperature: 1.0,
        presence_penalty: 1.0,
        frequency_penalty: 1.0,
        top_p: 0.9
      });

      let content = completion.data?.choices?.[0]?.message?.content.trim();
      
      if (!content) {
        throw new Error('Failed to generate content');
      }

      console.log('Generated content:', content);
      return content;

    } catch (error) {
      console.error('Error in generateContent:', error);
      throw error;
    }
  }

  buildPrompt(type, campaign, context) {
    if (context.platform === 'reddit') {
      return `Create a ${type} for r/${context.subreddit} based on this goal: ${campaign.goal}

Share your experience in a way that naturally fits the subreddit's community.
Focus on providing value and encouraging discussion.`;
    }

    return `Create a ${type} that shares your experience related to: ${campaign.goal}`;
  }

  
  generatePersona(campaign) {
    // Analyze the campaign goal to understand the context
    const goal = campaign.goal;
    
    // Extract key elements from the goal
    const words = goal.toLowerCase().split(' ');
    const actionWords = words.filter(word => word.endsWith('ing') || word.includes('promote') || word.includes('recommend'));
    const subjects = words.filter(word => word.length > 3 && !actionWords.includes(word));
    
    // Create a dynamic persona based on the goal's context
    return `You are someone who ${actionWords[0] || 'uses'} ${subjects[0] || 'this'} regularly.

Your perspective: ${goal}

Write as if you're naturally sharing your genuine experience with others who might benefit from it. 
Each response should feel unique - vary your tone, style, and structure organically.
Draw from the context of the campaign goal but express it through your own authentic voice.

Remember: You're a real person having a real conversation, not following a script.`;
  }
 
  async getCampaign(campaignId) {
    try {
      const query = 'SELECT * FROM campaigns WHERE id = $1';
      console.log('Executing campaign query:', query);
      console.log('For campaign:', campaignId);
      
      const result = await pool.query(query, [campaignId]);
      console.log('Campaign query result:', result.rows);
      return result.rows[0];
    } catch (error) {
      console.error('Error getting campaign:', error);
      throw error;
    }
  }

  async deletePost(postId, campaignId) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // Verify the post exists and belongs to the campaign
      const postResult = await client.query(
        'SELECT id FROM posts WHERE id = $1 AND campaign_id = $2',
        [postId, campaignId]
      );

      if (postResult.rows.length === 0) {
        throw new Error('Post not found or does not belong to the campaign');
      }

      // Delete all comments associated with the post
      await client.query(
        'DELETE FROM comments WHERE post_id = $1',
        [postId]
      );

      // Delete the post
      const result = await client.query(
        'DELETE FROM posts WHERE id = $1 AND campaign_id = $2 RETURNING *',
        [postId, campaignId]
      );

      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error deleting post:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteAllPostsInCampaign(campaignId) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // First delete all comments for all posts in the campaign
      await client.query(
        `DELETE FROM comments 
         WHERE post_id IN (
           SELECT id FROM posts WHERE campaign_id = $1
         )`,
        [campaignId]
      );

      // Then delete all posts in the campaign
      const result = await client.query(
        'DELETE FROM posts WHERE campaign_id = $1 RETURNING *',
        [campaignId]
      );

      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error deleting campaign posts:', error);
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = new PostingService();