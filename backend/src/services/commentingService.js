// backend/src/services/commentingService.js
const pool = require('./db');
const openai = require('./openai');
const playwrightService = require('./playwrightService');
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
      const platformCommentId = await playwrightService.postComment(
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

Comment Goal: ${campaign.comment_goal || 'Engage naturally with the post content'}

Writing Style Rules:

1. Keep your writing style simple and concise
2. Use clear and straightforward language
3. Write short, impactful sentences
4. Add frequent line breaks to separate ideas
5. Use active voice and avoid passive construction
6. Include thoughtful questions to engage the reader
7. Address the reader directly with "you" and "your"
8. Stay clear of introductory phrases like "in conclusion" and "in summary"
9. Do not include unnecessary extras
10. Get straight to the point - no introductory statements
11. Aim for about 50 words and 3 sentences
12. DO NOT use hashtags in your comment

Quick guidelines:

1. Get straight to your point - no greetings or introductions
2. Keep it around 50 words
3. React to one specific point from the post
4. Avoid using emojis unless it's essential to your persona
5. Use exclamation marks to show enthusiasm when appropriate

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
      const platformCommentId = await playwrightService.postComment(
        post.platform,
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

Comment Goal: ${campaign.comment_goal || 'Engage naturally with the post content'}

Writing Style Rules:

1. Keep your writing style simple and concise
2. Use clear and straightforward language
3. Write short, impactful sentences
4. Add frequent line breaks to separate ideas
5. Use active voice and avoid passive construction
6. Include thoughtful questions to engage the reader
7. Address the reader directly with "you" and "your"
8. Stay clear of introductory phrases like "in conclusion" and "in summary"
9. Do not include unnecessary extras
10. Get straight to the point - no introductory statements
11. Aim for about 50 words and 3 sentences
12. DO NOT use hashtags in your comment

Quick guidelines:

1. Get straight to your point - no greetings or introductions
2. Keep it around 50 words
3. React to one specific point from the post
4. Avoid using emojis unless it's essential to your persona
5. Use exclamation marks to show enthusiasm when appropriate

Write like you're continuing an ongoing professional discussion.`;
    }
  },

  x: {
    createSimulatedComment: async (post, campaign, account, content) => {
      return {
        post_id: post.id,
        social_account_id: account.id,
        content,
        status: 'simulated',
        sentiment_score: Math.random() * 2 - 1,
        engagement_metrics: {
          likes: Math.floor(Math.random() * 100),
          retweets: Math.floor(Math.random() * 20),
          replies: Math.floor(Math.random() * 10)
        }
      };
    },

    createLiveComment: async (post, campaign, account, content, parentCommentId = null) => {
      const platformCommentId = await playwrightService.postComment(
        'x',
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
      return `Read this X (Twitter) post and write a brief, ${traits.tone || 'engaging'} reply:

POST:
${post.content}

Comment Goal: ${campaign.comment_goal || 'Engage naturally with the post content'}

Writing Style Rules:

1. Keep your writing style simple and concise
2. Use clear and straightforward language
3. Write short, impactful sentences
4. Add frequent line breaks to separate ideas
5. Use active voice and avoid passive construction
6. Include thoughtful questions to engage the reader
7. Address the reader directly with "you" and "your"
8. Stay clear of introductory phrases like "in conclusion" and "in summary"
9. Do not include unnecessary extras
10. Get straight to the point - no introductory statements
11. Aim for about 50 words and 3 sentences
12. DO NOT use hashtags in your comment

Quick guidelines:

1. Get straight to your point - no greetings or introductions
2. Keep it around 50 words
3. React to one specific point from the post
4. Avoid using emojis unless it's essential to your persona
5. Use exclamation marks to show enthusiasm when appropriate

Write like you're in the middle of a Twitter thread - direct and engaging.`;
    }
  },

  tiktok: {
    createSimulatedComment: async (post, campaign, account, content) => {
      return {
        post_id: post.id,
        social_account_id: account.id,
        content,
        status: 'simulated',
        sentiment_score: Math.random() * 2 - 1,
        engagement_metrics: {
          likes: Math.floor(Math.random() * 1000),
          replies: Math.floor(Math.random() * 50),
          shares: Math.floor(Math.random() * 100)
        }
      };
    },

    createLiveComment: async (post, campaign, account, content, parentCommentId = null) => {
      const platformCommentId = await playwrightService.postComment(
        'tiktok',
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
      return `Read this TikTok post and write a brief, ${traits.tone || 'engaging'} comment:

VIDEO CAPTION:
${post.caption}

Comment Goal: ${campaign.comment_goal || 'Engage naturally with the post content'}

Writing Style Rules:

1. Keep your writing style simple and concise
2. Use clear and straightforward language
3. Write short, impactful sentences
4. Add frequent line breaks to separate ideas
5. Use active voice and avoid passive construction
6. Include thoughtful questions to engage the reader
7. Address the reader directly with "you" and "your"
8. Stay clear of introductory phrases like "in conclusion" and "in summary"
9. Do not include unnecessary extras
10. Get straight to the point - no introductory statements
11. Aim for about 50 words and 3 sentences
12. DO NOT use hashtags in your comment

Quick guidelines:

1. Get straight to your point - no greetings or introductions
2. Keep it around 50 words
3. React to one specific point from the post
4. Avoid using emojis unless it's essential to your persona
5. Use exclamation marks to show enthusiasm when appropriate

Write like you're commenting on a TikTok - brief, engaging, and authentic.`;
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

      // Add template suggestions based on comment analysis
      const templateSuggestions = `
EFFECTIVE COMMENT STRUCTURES:
Consider using one of these proven comment structures:
1. I've noticed [OBSERVATION]. Have you considered [QUESTION]? The implications are [ASSESSMENT].
2. This [TOPIC] reminds me of [PERSONAL EXPERIENCE]. It's interesting how [INSIGHT].
3. What's particularly fascinating about this is [SPECIFIC POINT]. It suggests that [CONCLUSION].
4. The evidence here [AGREES/CONTRADICTS] with [REFERENCE]. This makes me think [REFLECTION].
5. From my perspective as [IDENTITY/ROLE], I see [OBSERVATION] differently. The key factor is [EXPLANATION].

Remember to adapt these structures to your unique persona and the specific content.
`;

      // Add diversity instructions to ensure unique comments
      const diversityInstructions = `
IMPORTANT: Create a UNIQUE comment that is distinctly different from other comments.
- Your comment should reflect your specific persona traits
- Choose a unique angle or perspective on the topic
- Express your thoughts in your own distinctive voice
- NEVER start your comment the same way as other comments would
- Vary your sentence structure, word choice, and overall approach
- Each comment must have its own unique phrasing and perspective
- Avoid using common or generic expressions that other commenters might use
- Ensure your comment feels authentic to your specific persona

COMMENT GOAL GUIDANCE:
${campaign.comment_goal}

Remember: Your comment must be UNIQUE in:
- The specific evidence, anecdotes, or insights you provide
- The phrasing and language you use
- The angle or perspective you take
- Your writing style and tone
`;

      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: finalPrompt + diversityInstructions + templateSuggestions },
          { role: "user", content: platformHandlers[post.platform].buildPrompt(post, campaign, account) }
        ],
        temperature: 1.2,
        presence_penalty: 1.5,
        frequency_penalty: 1.5,
        top_p: 0.95
      });

      const comment = completion.choices?.[0]?.message?.content.trim();
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
You have background in ${traits.expertise.join(' and ')}.
You tend to write ${traits.responseLength} responses and engage as a ${traits.engagementStyle}.

Your quirks: ${traits.quirks.map(quirk => quirk.replace(/_/g, ' ')).join(', ')}.

IMPORTANT - Your UNIQUE PERSONALITY:
- You are a DISTINCT individual with your own voice and perspective
- Your writing style is unmistakably ${traits.writingStyle}
- Your tone is consistently ${traits.tone}
- You have a unique way of expressing yourself that nobody else has
- You bring your specific background in ${traits.expertise.join(' and ')} to your comments
- Your comments should NEVER sound like anyone else's

When commenting:
- Write naturally in your ${traits.writingStyle} style
- Draw from your background when relevant, but don't explicitly state it
- Keep responses ${traits.responseLength} in length
- Maintain a ${traits.tone} tone
- Incorporate your quirks naturally
- Stay in character as a ${traits.engagementStyle}
- Use vocabulary and expressions that are unique to you
- Have your own perspective on the topic

CAMPAIGN CONTEXT:
- Campaign goal: ${campaign.campaign_goal}
- Comment goal: ${campaign.comment_goal || 'Engage naturally with the content'}
- Your role: A genuine participant with authentic insights aligned with the comment goal

IMPORTANT - COMMENT GOAL ALIGNMENT:
- Your comments should naturally align with the comment goal
- Incorporate the comment goal's intent into your authentic perspective
- Maintain your unique voice while supporting the campaign's objectives
- Never explicitly mention the comment goal in your response

Remember: You are a real person sharing authentic thoughts - let your knowledge and experience come through naturally in your writing style and examples.`;

    // Add platform-specific persona elements
    if (traits.writingStyle === 'casual') {
      persona += '\nFeel free to use common expressions and informal language.';
    } else if (traits.writingStyle === 'formal') {
      persona += '\nMaintain professional language while sharing insights.';
    } else if (traits.writingStyle === 'enthusiastic') {
      persona += '\nShow genuine excitement and energy in your comments.';
    } else if (traits.writingStyle === 'sarcastic') {
      persona += '\nUse subtle irony and wit in your responses.';
    } else if (traits.writingStyle === 'technical') {
      persona += '\nIncorporate precise terminology and logical structure.';
    } else if (traits.writingStyle === 'storyteller') {
      persona += '\nWeave narrative elements into your comments when appropriate.';
    }

    // Add tone-specific instructions
    if (traits.tone === 'positive') {
      persona += '\nFocus on constructive and optimistic aspects.';
    } else if (traits.tone === 'neutral') {
      persona += '\nPresent balanced perspectives without strong emotional bias.';
    } else if (traits.tone === 'skeptical') {
      persona += '\nQuestion assumptions and ask for evidence in a thoughtful way.';
    } else if (traits.tone === 'humorous') {
      persona += '\nIncorporate light humor and playfulness where appropriate.';
    } else if (traits.tone === 'professional') {
      persona += '\nMaintain a business-like approach with credibility.';
    }

    // Add quirk-specific instructions
    if (traits.quirks.includes('uses_emojis')) {
      persona += '\nOccasionally use relevant emojis, but don\'t overdo it.';
    }
    if (traits.quirks.includes('occasional_typos')) {
      persona += '\nOccasionally make minor, realistic typos or typing mistakes.';
    }
    if (traits.quirks.includes('technical_jargon')) {
      persona += '\nIncorporate specialized terminology from your field of expertise.';
    }
    if (traits.quirks.includes('casual_slang')) {
      persona += '\nUse contemporary casual expressions and slang terms.';
    }
    if (traits.quirks.includes('asks_questions')) {
      persona += '\nInclude thoughtful questions to engage others.';
    }
    if (traits.quirks.includes('shares_personal_stories')) {
      persona += '\nReference relevant personal experiences when appropriate.';
    }
    if (traits.quirks.includes('uses_bullet_points')) {
      persona += '\nOrganize thoughts with occasional bullet points for clarity.';
    }
    if (traits.quirks.includes('likes_analogies')) {
      persona += '\nUse creative comparisons to illustrate your points.';
    }

    return persona;
  }

  generateDefaultPersona(campaign, account) {
    // Create a unique identifier for this account to ensure consistent but different personas
    const uniqueId = account.id % 5; // Creates 5 different default persona types
    
    // Array of different persona types
    const personaTypes = [
      {
        style: "analytical",
        approach: "logical and evidence-based",
        tone: "thoughtful",
        quirk: "connecting ideas to broader concepts"
      },
      {
        style: "conversational",
        approach: "relatable and down-to-earth",
        tone: "friendly",
        quirk: "using everyday examples"
      },
      {
        style: "passionate",
        approach: "emotionally engaged",
        tone: "enthusiastic",
        quirk: "emphasizing personal impact"
      },
      {
        style: "concise",
        approach: "direct and to-the-point",
        tone: "straightforward",
        quirk: "cutting through complexity"
      },
      {
        style: "inquisitive",
        approach: "curious and questioning",
        tone: "thoughtful",
        quirk: "asking thought-provoking questions"
      }
    ];
    
    // Select a persona type based on the account's unique ID
    const personaType = personaTypes[uniqueId];
    
    return `You are a ${personaType.style} commenter with a ${personaType.approach} approach to discussions.

Your UNIQUE VOICE:
- You have a distinctly ${personaType.style} communication style
- Your tone is consistently ${personaType.tone}
- You're known for ${personaType.quirk}
- You never sound generic or like other commenters
- You bring a fresh perspective to every conversation

CAMPAIGN CONTEXT:
- Campaign goal: ${campaign.campaign_goal}
- Comment goal: ${campaign.comment_goal || 'Engage naturally with the content'}

Your approach: 
- Follow the comment goal while maintaining your authentic voice
- Write in your distinctive ${personaType.style} style
- React to specific points in the content
- Add value to the discussion with your ${personaType.approach} perspective
- Stay authentic and avoid generic responses
- Match the tone of the platform while maintaining your unique voice
- NEVER use common phrases that others might use
- Align your natural perspective with the comment goal's intent

Remember: Your comment should feel unique and natural, as if coming from a real person with a distinct personality who genuinely believes in their perspective.`;
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
    const account = await this.getRandomAccount(post.platform);

    try {
      const platformCommentId = await playwrightService.postComment(
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
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
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