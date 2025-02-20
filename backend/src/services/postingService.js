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
        console.error('Campaign not found:', campaignId);
        return;
      }
      console.log('Found campaign:', campaign);

      // Get an approved subreddit for the campaign
      const subreddit = await this.getRandomApprovedSubreddit(campaignId);
      if (!subreddit) {
        console.error('No approved subreddits found for campaign:', campaignId);
        return;
      }
      console.log('Selected subreddit:', subreddit);

      const content = await this.generateContent('post', campaign, {
        platform: 'reddit',
        subreddit: subreddit.subreddit_name,
        contentRules: subreddit.content_rules
      });
      console.log('Generated content:', content);

      const account = await this.getRandomAccount('reddit');
      if (!account) {
        console.error('No available Reddit account found');
        return;
      }
      console.log('Selected account:', account.id);

      // Insert with explicit 'simulated' status and use subreddit column
      const query = `
        INSERT INTO posts 
        (campaign_id, social_account_id, subreddit, content, status, 
         posted_at, sentiment_score, engagement_metrics)
        VALUES ($1, $2, $3, $4, 'simulated', NOW(), $5, $6)
        RETURNING *`;
      
      const values = [
        campaignId,
        account.id,
        subreddit.subreddit_name,
        content,
        Math.random() * 2 - 1, // sentiment score between -1 and 1
        JSON.stringify({
          upvotes: Math.floor(Math.random() * 100) + 10,
          shares: Math.floor(Math.random() * 20)
        })
      ];

      console.log('Executing query:', query);
      console.log('With values:', values);

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
      const query = `
        SELECT rs.* 
        FROM reddit_subreddits rs
        JOIN campaign_subreddits cs ON cs.subreddit_id = rs.id
        JOIN campaign_networks cn ON cs.campaign_network_id = cn.id
        WHERE cn.campaign_id = $1 
        AND cs.status = 'approved'
        ORDER BY RANDOM()
        LIMIT 1`;
      
      console.log('Executing subreddit query:', query);
      console.log('For campaign:', campaignId);
      
      const result = await pool.query(query, [campaignId]);
      console.log('Subreddit query result:', result.rows);
      return result.rows[0];
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
  generateFallbackContent() {
    // Generate a unique fallback message with timestamp and random elements
    const topics = [
      'resilience', 'healing', 'personal growth', 'memoir writing',
      'life experiences', 'overcoming challenges', 'self-discovery'
    ];
    const questions = [
      'What memoirs have impacted you the most?',
      'How do you process difficult experiences?',
      'What helps you stay resilient?',
      'Have you ever considered writing your story?',
      'What life experiences shaped who you are today?'
    ];
    
    const randomTopic = topics[Math.floor(Math.random() * topics.length)];
    const randomQuestion = questions[Math.floor(Math.random() * questions.length)];
    const uniqueId = Date.now().toString(36) + Math.random().toString(36).substr(2);
    
    return `Exploring ${randomTopic} through the lens of personal experience. ${randomQuestion} [${uniqueId}]`;
  }

  async generateContent(type, campaign, context = {}) {
    try {
      console.log('Generating content with context:', context);
      
      const prompt = this.buildPrompt(type, campaign, context);
      console.log('Generated prompt:', prompt);
      
      if (!process.env.OPENAI_API_KEY) {
        console.error('OPENAI_API_KEY not found in environment variables');
        return this.generateFallbackContent();
      }

      let content;
      let attempts = 0;
      const maxAttempts = 3;

      // Keep trying until we get unique content or hit max attempts
      do {
        console.log('Attempting OpenAI API call... Attempt:', attempts + 1);
        const completion = await openai.createChatCompletion({
          model: "gpt-4",
          messages: [
            {
              role: "system",
              content: context.platform === 'reddit' 
                ? "You are an expert Reddit user who understands Reddit's culture and how to create engaging, authentic posts that follow each subreddit's rules and conventions. You never use hashtags or emojis in Reddit posts. Each response must be unique and different from previous responses."
                : "You are an expert social media content creator who understands each platform's unique style and engagement patterns. Each response must be unique and different from previous responses."
            },
            {
              role: "user",
              content: prompt + (attempts > 0 ? "\n\nPlease generate a completely different variation from previous attempts." : "")
            }
          ],
          // Increase temperature slightly for more variation
          temperature: 0.8 + (attempts * 0.1)
        });

        content = completion.data?.choices?.[0]?.message?.content.trim();
        
        // Check if this content is unique
        if (content && !this.recentContentCache.has(content)) {
          this.recentContentCache.add(content);
          break;
        }

        attempts++;
      } while (attempts < maxAttempts);

      // If we couldn't generate unique content after max attempts, generate a unique fallback
      if (!content || this.recentContentCache.has(content)) {
        content = this.generateFallbackContent();
        this.recentContentCache.add(content);
      }

      console.log('Successfully generated unique content:', content);
      return content;

    } catch (error) {
      console.error('Error in generateContent:', error);
      if (error.response) {
        console.error('OpenAI API error response:', error.response.data);
      }
      return this.generateFallbackContent();
    }
  }


  buildPrompt(type, campaign, context) {
    let prompt = `Create a ${type} for the following campaign:
    
Campaign Name: ${campaign.name}
Goal: ${campaign.goal}
Target Sentiment: ${campaign.target_sentiment}
`;

    if (context.platform === 'reddit') {
      prompt += `\nSubreddit: r/${context.subreddit}

The post should:
1. Follow Reddit's style and format (no hashtags, no emojis)
2. Match the subreddit's content rules and culture
3. Feel authentic and engaging
4. Encourage discussion
5. Include a clear call-to-action (like asking for thoughts/experiences)`;

      if (context.contentRules) {
        prompt += `\n\nSubreddit rules to follow:\n${context.contentRules.map(rule => `- ${rule}`).join('\n')}`;
      }
    } else {
      prompt += `\nThe content should:
1. Be authentic and engaging
2. Match the target sentiment
3. Align with the campaign goal
4. Feel natural for the platform
5. Encourage discussion and interaction`;
    }

    if (context.postContent) {
      prompt += `\n\nRespond to this post content: "${context.postContent}"`;
    }

    return prompt;
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