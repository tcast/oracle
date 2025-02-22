// backend/src/services/commentingService.js
const pool = require('./db');
const openai = require('./openai');
const seleniumService = require('./seleniumService');
const postingService = require('./postingService');
const contentStyleService = require('./contentStyleService');

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

    buildPrompt: (post, campaign, account) => {
      const traits = account.persona_traits || {};
      return `Read this Reddit post and write a brief, ${traits.tone || 'natural'} comment:

POST:
${post.content}

Quick guidelines:
1. Get straight to your point - no greetings or introductions
2. Keep it under 50 words
3. React to one specific point${traits.expertise ? ` - mention your ${traits.expertise[0]} experience if relevant` : ''}
${traits.quirks?.includes('shares_personal_stories') ? '4. Add a quick personal example' : ''}

Write like you're in the middle of a conversation - direct and natural.`;
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

    buildPrompt: (post, campaign, account) => {
      const traits = account.persona_traits || {};
      return `Read this LinkedIn post and write a brief, ${traits.tone || 'professional'} comment:

POST:
${post.content}

Quick guidelines:
1. Get straight to your point - no introductions or formalities
2. Keep it under 50 words
3. Focus on one key insight${traits.expertise ? ` - mention your ${traits.expertise[0]} perspective if relevant` : ''}
${traits.quirks?.includes('technical_jargon') ? '4. Use one industry term naturally' : ''}

Write like you're continuing an ongoing professional discussion.`;
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
      if (!posts.length) {
        console.log(`No recent posts found for campaign ${campaignId}`);
        return;
      }

      const campaign = await this.getCampaign(campaignId);
      if (!campaign) {
        console.log(`Campaign not found: ${campaignId}`);
        return;
      }

      for (const post of posts) {
        try {
          // Verify post still exists
          const postExists = await pool.query(
            'SELECT id FROM posts WHERE id = $1',
            [post.id]
          );
          
          if (!postExists.rows.length) {
            console.log(`Post ${post.id} no longer exists, skipping comments`);
            continue;
          }

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
        } catch (error) {
          console.error(`Error processing comments for post ${post.id}:`, error);
          continue; // Continue with next post if there's an error
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

      const content = await this.generateComment(post, campaign, account);

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

  async generateComment(post, campaign, account) {
    try {
      // Get network-specific style guidelines
      const networkStyle = await contentStyleService.getNetworkStyle(post.platform, 'comment');
      
      // Generate base prompt from network style
      const basePrompt = contentStyleService.generateBasePrompt(networkStyle, 'comment', {
        post_title: post.title,
        post_content: post.content,
        post_type: post.type
      });
      
      // Generate persona
      const persona = this.generatePersona(campaign, account);
      
      // Combine network style with persona
      const finalPrompt = contentStyleService.combineWithPersona(basePrompt, persona);

      const completion = await openai.createChatCompletion({
        model: "gpt-4",
        messages: [
          { role: "system", content: finalPrompt },
          { role: "user", content: platformHandlers[post.platform].buildPrompt(post, campaign, account) }
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

  generatePersona(campaign, account) {
    const traits = account.persona_traits;
    if (!traits) return this.generateDefaultPersona(campaign, account);

    let persona = `You are a ${traits.tone} commenter with a ${traits.writingStyle} writing style.
Your expertise is in ${traits.expertise.join(' and ')}.
You tend to write ${traits.responseLength} responses and engage as a ${traits.engagementStyle}.

Your quirks: ${traits.quirks.map(quirk => quirk.replace(/_/g, ' ')).join(', ')}.

When commenting:
- Maintain your ${traits.writingStyle} style consistently
- Show your expertise in ${traits.expertise.join(' and ')} when relevant
- Keep responses ${traits.responseLength} in length
- Maintain a ${traits.tone} tone
- Incorporate your quirks naturally
- Stay in character as a ${traits.engagementStyle}

Context:
- Campaign goal: ${campaign.campaign_goal}
- Your role: A genuine participant with the above personality traits

Remember: You are a real person with consistent traits - your comments should reflect your unique personality while engaging naturally with the content.`;

    // Add platform-specific persona elements
    if (traits.writingStyle === 'casual') {
      persona += '\nFeel free to use common expressions and informal language.';
    } else if (traits.writingStyle === 'formal') {
      persona += '\nMaintain professional language while showing expertise.';
    }

    // Add quirk-specific instructions
    if (traits.quirks.includes('uses_emojis')) {
      persona += '\nOccasionally use relevant emojis, but don\'t overdo it.';
    }
    if (traits.quirks.includes('occasional_typos')) {
      persona += '\nOccasionally make minor, realistic typos or typing mistakes.';
    }

    return persona;
  }

  generateDefaultPersona(campaign, account) {
    return `You are someone engaging naturally with this content about ${campaign.campaign_goal}.

Your role: A genuine participant in this discussion who has relevant experience to share.
Your style: Write conversationally and naturally.
Your approach: 
- Vary your comment style (sometimes ask questions, sometimes share experiences, sometimes offer insights)
- React to specific points in the content
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
       AND status IN ('simulated', 'posted')
       AND created_at >= NOW() - INTERVAL '1 hour'
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
        // If no accounts are available, create a new one with persona traits
        const persona = await this.generatePersonalityTraits();
        const username = `user_${Math.floor(Math.random() * 10000)}`;
        const newAccount = await pool.query(
          `INSERT INTO social_accounts 
           (platform, username, credentials, status, persona_traits)
           VALUES ($1, $2, $3, 'active', $4)
           RETURNING *`,
          [
            platform,
            username,
            JSON.stringify({ password: 'default_password' }),
            JSON.stringify(persona)
          ]
        );
        return newAccount.rows[0];
      }

      // If account exists but has no persona, generate one
      if (!result.rows[0].persona_traits) {
        const persona = await this.generatePersonalityTraits();
        await pool.query(
          `UPDATE social_accounts 
           SET persona_traits = $1
           WHERE id = $2`,
          [JSON.stringify(persona), result.rows[0].id]
        );
        result.rows[0].persona_traits = persona;
      }

      return result.rows[0];
    } catch (error) {
      console.error('Error getting random account:', error);
      throw error;
    }
  }

  async generatePersonalityTraits() {
    // Generate a unique personality profile
    const traits = {
      writingStyle: this.pickRandom([
        'formal',
        'casual',
        'enthusiastic',
        'sarcastic',
        'technical',
        'storyteller'
      ]),
      responseLength: this.pickRandom([
        'concise',
        'moderate',
        'detailed',
        'verbose'
      ]),
      tone: this.pickRandom([
        'positive',
        'neutral',
        'skeptical',
        'humorous',
        'professional'
      ]),
      quirks: this.pickRandomMultiple([
        'uses_emojis',
        'occasional_typos',
        'technical_jargon',
        'casual_slang',
        'asks_questions',
        'shares_personal_stories',
        'uses_bullet_points',
        'likes_analogies'
      ], 2),
      expertise: this.pickRandomMultiple([
        'technology',
        'business',
        'science',
        'arts',
        'gaming',
        'sports',
        'finance',
        'education'
      ], 2),
      engagementStyle: this.pickRandom([
        'supportive',
        'debater',
        'questioner',
        'advisor',
        'storyteller'
      ])
    };

    return traits;
  }

  pickRandom(array) {
    return array[Math.floor(Math.random() * array.length)];
  }

  pickRandomMultiple(array, count) {
    const shuffled = [...array].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
  }

  shouldCreateComment(post) {
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