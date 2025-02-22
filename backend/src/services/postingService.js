const pool = require('./db');
const openai = require('./openai');
const seleniumService = require('./seleniumService');

class PostingService {
  constructor() {
    // Add a cache to track recently generated content
    this.recentContentCache = new Set();
    // Clear cache every 24 hours to prevent unbounded growth
    setInterval(() => this.recentContentCache.clear(), 24 * 60 * 60 * 1000);

    // Initialize platform handlers with proper binding
    this.platformHandlers = {
      reddit: {
        createSimulatedPost: async (campaign, account, content, context) => {
          const subreddit = context.subreddit;
          if (!subreddit) throw new Error('Subreddit required for Reddit posts');

          return {
            campaign_id: campaign.id,
            social_account_id: account.id,
            platform: 'reddit',
            subreddit: subreddit.subreddit_name,
            content,
            status: 'simulated',
            metadata: { subreddit_rules: subreddit.content_rules }
          };
        },

        createLivePost: async (campaign, account, content, context) => {
          const subreddit = context.subreddit;
          if (!subreddit) throw new Error('Subreddit required for Reddit posts');

          const platformPostId = await seleniumService.createRedditPost(
            account.id,
            subreddit.subreddit_name,
            content
          );

          return {
            campaign_id: campaign.id,
            social_account_id: account.id,
            platform: 'reddit',
            platform_post_id: platformPostId,
            subreddit: subreddit.subreddit_name,
            content,
            status: 'posted',
            metadata: { subreddit_rules: subreddit.content_rules }
          };
        },

        buildPrompt: (type, campaign, context) => {
          return `Create a ${type} for r/${context.subreddit} based on this goal: ${campaign.post_goal}

Share your experience in a way that naturally fits the subreddit's community.
Focus on providing value and encouraging discussion.
Follow these community rules: ${JSON.stringify(context.contentRules || [])}`;
        },

        getPostContext: async (campaignId) => {
          const subreddit = await this.getRandomApprovedSubreddit(campaignId);
          if (!subreddit) throw new Error('No approved subreddits found for campaign');
          return { subreddit };
        }
      },

      linkedin: {
        createSimulatedPost: async (campaign, account, content, context) => {
          return {
            campaign_id: campaign.id,
            social_account_id: account.id,
            platform: 'linkedin',
            content,
            status: 'simulated',
            metadata: { 
              media_assets: context.mediaAssets || [],
              target_url: context.targetUrl
            }
          };
        },

        createLivePost: async (campaign, account, content, context) => {
          const platformPostId = await seleniumService.createLinkedInPost(
            account.id,
            content,
            context.mediaAssets,
            context.targetUrl
          );

          return {
            campaign_id: campaign.id,
            social_account_id: account.id,
            platform: 'linkedin',
            platform_post_id: platformPostId,
            content,
            status: 'posted',
            metadata: {
              media_assets: context.mediaAssets || [],
              target_url: context.targetUrl
            }
          };
        },

        buildPrompt: (type, campaign, context) => {
          let prompt = `Create a professional ${type} for LinkedIn based on this goal: ${campaign.post_goal}

Share insights and experience in a way that resonates with a professional audience.
Focus on providing value and encouraging meaningful business connections.`;

          if (context.targetUrl) {
            prompt += `\nInclude a natural reference to this URL: ${context.targetUrl}`;
          }

          if (context.mediaAssets?.length > 0) {
            prompt += `\nThe post will include ${context.mediaAssets.length} supporting image(s). Reference them naturally.`;
          }

          return prompt;
        },

        getPostContext: async (campaignId) => {
          const campaign = await this.getCampaign(campaignId);
          return {
            mediaAssets: campaign.media_assets || [],
            targetUrl: campaign.target_url
          };
        }
      }
    };

    // Bind all methods that need 'this' context
    Object.values(this.platformHandlers).forEach(handler => {
      handler.getPostContext = handler.getPostContext.bind(this);
      if (handler === this.platformHandlers.reddit) {
        handler.getRandomApprovedSubreddit = this.getRandomApprovedSubreddit.bind(this);
      }
    });
  }

  async createSimulatedPost(campaignId) {
    return this.createPost(campaignId, false);
  }

  async createPost(campaignId, isLive = false) {
    try {
      const campaign = await this.getCampaign(campaignId);
      if (!campaign) throw new Error('Campaign not found');

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

        // Check if enough time has passed since last post
        const lastPost = await this.getLastPost(campaignId);
        if (lastPost) {
          const hoursSinceLastPost = (now - new Date(lastPost.posted_at)) / (1000 * 60 * 60);
          if (hoursSinceLastPost < campaign.min_post_interval_hours) {
            throw new Error('Minimum post interval not reached');
          }
        }
      }

      // Get campaign networks
      const networks = await this.getCampaignNetworks(campaignId);
      if (!networks.length) throw new Error('No networks configured for campaign');

      console.log('Available networks for campaign:', networks);

      // Try each network in random order until one succeeds
      const shuffledNetworks = [...networks].sort(() => Math.random() - 0.5);
      const errors = [];

      for (const network of shuffledNetworks) {
        try {
          console.log('Attempting to create post for network:', network.network_type);
          
          // Check post limits for each platform
          const postCount = await this.getPostCount(campaignId, network.network_type);
          const maxPosts = network.network_type === 'reddit' 
            ? campaign.posts_per_subreddit 
            : campaign.posts_per_linkedin;

          console.log(`Current post count for ${network.network_type}: ${postCount}, Max allowed: ${maxPosts}`);

          if (postCount >= maxPosts) {
            const error = `Post limit reached for ${network.network_type} (${postCount}/${maxPosts})`;
            console.log(error);
            errors.push(error);
            continue;
          }

          if (network.network_type === 'reddit') {
            try {
              const subreddit = await this.getRandomApprovedSubreddit(campaignId);
              const subredditPostCount = await this.getSubredditPostCount(campaignId, subreddit.subreddit_name);
              if (subredditPostCount >= campaign.posts_per_subreddit) {
                const error = `Post limit reached for subreddit ${subreddit.subreddit_name} (${subredditPostCount}/${campaign.posts_per_subreddit})`;
                console.log(error);
                errors.push(error);
                continue;
              }
            } catch (subredditError) {
              console.error('Error with subreddit:', subredditError);
              errors.push(`Reddit error: ${subredditError.message}`);
              continue;
            }
          }

          const handler = this.platformHandlers[network.network_type];
          if (!handler) {
            const error = `Unsupported platform: ${network.network_type}`;
            console.warn(error);
            errors.push(error);
            continue;
          }

          // Get platform-specific context
          const context = await handler.getPostContext(campaignId);
          console.log(`Got context for ${network.network_type}:`, context);

          // Generate content
          const content = await this.generateContent('post', campaign, {
            platform: network.network_type,
            ...context
          });

          // Get account
          const account = await this.getRandomAccount(network.network_type);
          if (!account) {
            const error = `No available ${network.network_type} account found`;
            console.warn(error);
            errors.push(error);
            continue;
          }

          // Create post using platform-specific handler
          const postData = await (isLive ? 
            handler.createLivePost(campaign, account, content, context) :
            handler.createSimulatedPost(campaign, account, content, context));

          // Insert into database
          const result = await pool.query(
            `INSERT INTO posts 
             (campaign_id, social_account_id, platform, platform_post_id, 
              content, status, metadata, subreddit, posted_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
             RETURNING *`,
            [
              postData.campaign_id,
              postData.social_account_id,
              postData.platform,
              postData.platform_post_id,
              postData.content,
              postData.status,
              postData.metadata,
              postData.subreddit
            ]
          );

          console.log(`Successfully created ${network.network_type} post`);
          return result.rows[0];
        } catch (error) {
          console.error(`Failed to create post for ${network.network_type}:`, error);
          errors.push(`${network.network_type} error: ${error.message}`);
          // Continue to next platform
        }
      }

      // If we get here, all platforms failed
      const limitErrors = errors.filter(e => e.includes('Post limit reached'));
      const otherErrors = errors.filter(e => !e.includes('Post limit reached'));

      if (limitErrors.length === networks.length) {
        // All platforms have reached their post limits - this is normal
        console.log('All platforms have reached their post limits:', limitErrors.join('\n'));
        return null;
      } else if (otherErrors.length > 0) {
        // We have actual errors to report
        const errorMessage = `Failed to create post on any platform:\n${otherErrors.join('\n')}`;
        console.error(errorMessage);
        throw new Error(errorMessage);
      } else {
        // Mixed state - some platforms hit limits, others had errors
        const errorMessage = `Failed to create post on any platform:\n${errors.join('\n')}`;
        console.error(errorMessage);
        throw new Error(errorMessage);
      }
    } catch (error) {
      console.error('Error creating post:', error);
      throw error;
    }
  }

  async getCampaignNetworks(campaignId) {
    const result = await pool.query(
      'SELECT platform FROM campaigns WHERE id = $1',
      [campaignId]
    );
    const platforms = result.rows[0]?.platform || [];
    return platforms.map(platform => ({ network_type: platform }));
  }

  async generateContent(type, campaign, context) {
    try {
      const handler = this.platformHandlers[context.platform];
      if (!handler) throw new Error(`Unsupported platform: ${context.platform}`);

      const persona = this.generatePersona(campaign);
      const prompt = handler.buildPrompt(type, campaign, context);

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

      const content = completion.data?.choices?.[0]?.message?.content.trim();
      if (!content) throw new Error('Failed to generate content');

      return content;
    } catch (error) {
      console.error('Error generating content:', error);
      throw error;
    }
  }

  async getRandomApprovedSubreddit(campaignId) {
    try {
      console.log('Getting random approved subreddit for campaign:', campaignId);
      
      // Try the subreddit_suggestions table
      const query = `
        SELECT subreddit_name, reason
        FROM subreddit_suggestions
        WHERE campaign_id = $1
        AND status = 'approved'
        ORDER BY RANDOM()
        LIMIT 1`;
      
      console.log('Executing query:', query);
      console.log('With campaign ID:', campaignId);
      
      const suggestionsResult = await pool.query(query, [campaignId]);
      console.log('Query result:', suggestionsResult.rows);

      // If we find an approved suggestion, use it
      if (suggestionsResult.rows.length > 0) {
        console.log('Found approved subreddit from suggestions:', suggestionsResult.rows[0]);
        return {
          subreddit_name: suggestionsResult.rows[0].subreddit_name,
          content_rules: [], // Add any rules if needed
        };
      }

      console.warn('No approved subreddits found in database for campaign:', campaignId);
      throw new Error('No approved subreddits found for this campaign - please approve some subreddit suggestions first');
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

  generatePersona(campaign) {
    // Analyze the campaign goal to understand the context
    const goal = campaign.post_goal;
    
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

  async getLastPost(campaignId) {
    const result = await pool.query(
      'SELECT * FROM posts WHERE campaign_id = $1 ORDER BY posted_at DESC LIMIT 1',
      [campaignId]
    );
    return result.rows[0];
  }

  async getPostCount(campaignId, platform) {
    const result = await pool.query(
      'SELECT COUNT(*) as count FROM posts WHERE campaign_id = $1 AND platform = $2',
      [campaignId, platform]
    );
    return parseInt(result.rows[0].count);
  }

  async getSubredditPostCount(campaignId, subreddit) {
    const result = await pool.query(
      'SELECT COUNT(*) as count FROM posts WHERE campaign_id = $1 AND subreddit = $2',
      [campaignId, subreddit]
    );
    return parseInt(result.rows[0].count);
  }
}

module.exports = new PostingService();