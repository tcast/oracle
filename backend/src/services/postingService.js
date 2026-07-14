const pool = require('./db');
const openai = require('./openai');
const playwrightService = require('./playwrightService');
const commentingService = require('./commentingService');
const contentStyleService = require('./contentStyleService');
const subredditService = require('./subredditService');
const { getRedditSystemPrompt, buildRedditUserPrompt, sanitizeRedditPost, splitRedditTitleBody } = require('./redditStyleGuide');
const campaignAccountService = require('./campaignAccountService');
const audiencePersonaService = require('./audiencePersonaService');
const { simulateReception } = require('./simReactionService');
const campaignScorecardService = require('./campaignScorecardService');
const { generationCompletionOptions } = require('../config/openaiModels');
const simLearningsService = require('./simLearningsService');

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

          await playwrightService.requireProxyForLive(account.id);
          const { title, body } = splitRedditTitleBody(content);
          const platformPostId = await playwrightService.createRedditPost(
            account.id,
            subreddit.subreddit_name,
            title,
            body,
            true
          );

          if (!platformPostId) {
            throw new Error('Reddit live post failed — no platform post id returned');
          }

          return {
            campaign_id: campaign.id,
            social_account_id: account.id,
            platform: 'reddit',
            platform_post_id: platformPostId,
            subreddit: subreddit.subreddit_name,
            content: body,
            status: 'posted',
            metadata: {
              subreddit_rules: subreddit.content_rules,
              title,
              platform_post_url: `https://www.reddit.com/r/${subreddit.subreddit_name}/comments/${platformPostId}/`,
            }
          };
        },

        buildPrompt: (type, campaign, context, account) => {
          return buildRedditUserPrompt(campaign, context, account);
        },

        getPostContext: async (campaignId) => {
          const subreddit = await this.getRandomApprovedSubreddit(campaignId);
          if (!subreddit) {
            // Check if there are any approved subreddits at all
            const result = await pool.query(
              'SELECT COUNT(*) FROM subreddit_suggestions WHERE campaign_id = $1 AND status = \'approved\'',
              [campaignId]
            );
            const hasApprovedSubreddits = parseInt(result.rows[0].count) > 0;
            
            if (hasApprovedSubreddits) {
              throw new Error('All approved subreddits have reached their post limit');
            } else {
              throw new Error('No approved subreddits found for campaign');
            }
          }
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
          const platformPostId = await playwrightService.createLinkedInPost(
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

        buildPrompt: (type, campaign, context, account) => {
          const traits = account.persona_traits || {};
          let prompt = `Create a ${traits.tone || 'professional'} LinkedIn post that aligns with this campaign:

Campaign Overview: ${campaign.campaign_overview}
Campaign Goal: ${campaign.campaign_goal}
Post Goal: ${campaign.post_goal}

Writing Guidelines:
1. Keep your writing style simple and concise
2. Use clear and straightforward language
3. Write short, impactful sentences
4. Add frequent line breaks to separate ideas
5. Use active voice and avoid passive construction
6. Propose thought-provoking questions to engage the reader
7. Address the reader directly with "you" and "your"
8. Stay clear of introductory phrases like "in conclusion" and "in summary"
9. Do not include unnecessary extras
10. Write in a ${traits.tone || 'professional'} style
11. Keep the content focused on the campaign's message
12. Adapt the tone to match the campaign's goals
13. Share relevant insights naturally
14. End with a clear call to action
${traits.quirks?.includes('technical_jargon') ? '15. Use relevant industry terminology naturally' : ''}

Content Requirements:
- Keep it concise and impactful
- Use clear, professional language
- Structure thoughts logically
- Include specific examples or data points`;

          if (context.targetUrl) {
            prompt += `\n\nInclude this link naturally: ${context.targetUrl}`;
          }

          if (context.mediaAssets?.length > 0) {
            prompt += `\n\nReference the attached media appropriately.`;
          }

          prompt += `\n\nRemember: Maintain professionalism while effectively delivering the campaign's message.`;

          return prompt;
        },

        getPostContext: async (campaignId) => {
          const campaign = await this.getCampaign(campaignId);
          return {
            mediaAssets: campaign.media_assets || [],
            targetUrl: campaign.target_url
          };
        }
      },

      x: {
        createSimulatedPost: async (campaign, account, content, context) => {
          return {
            campaign_id: campaign.id,
            social_account_id: account.id,
            platform: 'x',
            content,
            status: 'simulated',
            metadata: { 
              media_assets: context.mediaAssets || [],
              hashtags: context.hashtags || [],
              mentions: context.mentions || []
            }
          };
        },

        createLivePost: async (campaign, account, content, context) => {
          const platformPostId = await playwrightService.createXPost(
            account.id,
            content,
            context.mediaAssets,
            context.hashtags,
            context.mentions
          );

          return {
            campaign_id: campaign.id,
            social_account_id: account.id,
            platform: 'x',
            platform_post_id: platformPostId,
            content,
            status: 'posted',
            metadata: {
              media_assets: context.mediaAssets || [],
              hashtags: context.hashtags || [],
              mentions: context.mentions || []
            }
          };
        },

        buildPrompt: (type, campaign, context, account) => {
          const traits = account.persona_traits || {};
          let prompt = `Create a ${traits.tone || 'engaging'} X (Twitter) post that aligns with this campaign:

Campaign Overview: ${campaign.campaign_overview}
Campaign Goal: ${campaign.campaign_goal}
Post Goal: ${campaign.post_goal}

Writing Guidelines:
1. Keep your writing style simple and concise
2. Use clear and straightforward language
3. Write short, impactful sentences
4. Add frequent line breaks to separate ideas
5. Use active voice and avoid passive construction
6. Propose thought-provoking questions to engage the reader
7. Address the reader directly with "you" and "your"
8. Stay clear of introductory phrases like "in conclusion" and "in summary"
9. Do not include unnecessary extras
10. Write in a ${traits.tone || 'engaging'} style
11. Keep the content focused on the campaign's message
12. Adapt the tone to match the campaign's goals
13. Make every character count (280 char limit)
14. End with a powerful call to action
${traits.quirks?.includes('uses_emojis') ? '15. Use relevant emojis strategically' : ''}

Content Requirements:
- Start with a strong hook
- Keep it concise and impactful
- Use clear, direct language
- Make it shareable and engaging`;

          if (context.hashtags?.length > 0) {
            prompt += `\n\nIncorporate these hashtags naturally: ${context.hashtags.join(' ')}`;
          }

          if (context.mentions?.length > 0) {
            prompt += `\n\nMention these accounts where relevant: ${context.mentions.join(' ')}`;
          }

          if (context.mediaAssets?.length > 0) {
            prompt += `\n\nReference the attached media appropriately.`;
          }

          prompt += `\n\nRemember: Stay within 280 characters while effectively delivering the campaign's message.`;

          return prompt;
        },

        getPostContext: async (campaignId) => {
          const campaign = await this.getCampaign(campaignId);
          return {
            mediaAssets: campaign.media_assets || [],
            hashtags: campaign.metadata?.hashtags || [],
            mentions: campaign.metadata?.mentions || []
          };
        }
      },

      tiktok: {
        createSimulatedPost: async (campaign, account, content, context) => {
          // For TikTok, we need both a video and a caption
          const mediaResult = await pool.query(
            `SELECT media_assets FROM campaigns WHERE id = $1`,
            [campaign.id]
          );
          
          const mediaAssets = mediaResult.rows[0]?.media_assets || [];
          const videoAsset = mediaAssets.find(asset => 
            asset.type.startsWith('video/')
          );
          
          if (!videoAsset) {
            throw new Error('No video assets available for TikTok post');
          }

          const caption = await this.generateContent('caption', campaign, {
            platform: 'tiktok',
            videoContext: 'TikTok video showcasing the campaign message'
          });

          return {
            campaign_id: campaign.id,
            social_account_id: account.id,
            platform: 'tiktok',
            video_url: videoAsset.url,
            caption,
            status: 'simulated',
            metadata: {
              videoContext: 'TikTok video showcasing the campaign message'
            }
          };
        },

        createLivePost: async (campaign, account, content, context) => {
          // For TikTok, we need both a video and a caption
          const mediaResult = await pool.query(
            `SELECT media_assets FROM campaigns WHERE id = $1`,
            [campaign.id]
          );
          
          const mediaAssets = mediaResult.rows[0]?.media_assets || [];
          const videoAsset = mediaAssets.find(asset => 
            asset.type.startsWith('video/')
          );
          
          if (!videoAsset) {
            throw new Error('No video assets available for TikTok post');
          }

          const caption = await this.generateContent('caption', campaign, {
            platform: 'tiktok',
            videoContext: 'TikTok video showcasing the campaign message'
          });

          const platformPostId = await playwrightService.createTikTokPost(
            account.id,
            videoAsset.url,
            caption
          );

          return {
            campaign_id: campaign.id,
            social_account_id: account.id,
            platform: 'tiktok',
            platform_post_id: platformPostId,
            video_url: videoAsset.url,
            caption,
            status: 'posted',
            metadata: {
              videoContext: 'TikTok video showcasing the campaign message'
            }
          };
        },

        buildPrompt: (type, campaign, context, account) => {
          const traits = account.persona_traits || {};
          let prompt = `Create a ${traits.tone || 'professional'} TikTok post that aligns with this campaign:

Campaign Overview: ${campaign.campaign_overview}
Campaign Goal: ${campaign.campaign_goal}
Post Goal: ${campaign.post_goal}

Writing Guidelines:
1. Keep your writing style simple and concise
2. Use clear and straightforward language
3. Write short, impactful sentences
4. Add frequent line breaks to separate ideas
5. Use active voice and avoid passive construction
6. Propose thought-provoking questions to engage the reader
7. Address the reader directly with "you" and "your"
8. Stay clear of introductory phrases like "in conclusion" and "in summary"
9. Do not include unnecessary extras
10. Write in a ${traits.tone || 'professional'} style
11. Keep the content focused on the campaign's message
12. Adapt the tone to match the campaign's goals
13. Share relevant insights naturally
14. End with a clear call to action
${traits.quirks?.includes('technical_jargon') ? '15. Use relevant industry terminology naturally' : ''}

Content Requirements:
- Keep it concise and impactful
- Use clear, professional language
- Structure thoughts logically
- Include specific examples or data points`;

          if (context.videoContext) {
            prompt += `\n\nInclude this context naturally: ${context.videoContext}`;
          }

          prompt += `\n\nRemember: Maintain professionalism while effectively delivering the campaign's message.`;

          return prompt;
        },

        getPostContext: async (campaignId) => {
          const campaign = await this.getCampaign(campaignId);
          return {
            videoContext: campaign.metadata?.videoContext
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

  async claimApprovedDraft(campaignId, platform = null) {
    const params = [campaignId];
    let platformClause = '';
    if (platform) {
      params.push(platform);
      platformClause = 'AND platform = $2';
    }
    const draft = await pool.query(
      `SELECT * FROM posts
       WHERE campaign_id = $1 AND status = 'approved' ${platformClause}
       ORDER BY posted_at ASC
       LIMIT 1`,
      params
    );
    if (!draft.rows[0]) return null;

    const updated = await pool.query(
      `UPDATE posts SET status = 'publishing'
       WHERE id = $1 AND status = 'approved'
       RETURNING *`,
      [draft.rows[0].id]
    );
    return updated.rows[0] || null;
  }

  async createSimulatedPost(campaignId) {
    try {
      const campaign = await this.getCampaign(campaignId);
      if (!campaign) throw new Error('Campaign not found');

      // Prefer publishing an approved draft
      const approvedDraft = await this.claimApprovedDraft(campaignId);
      if (approvedDraft) {
        const account = approvedDraft.social_account_id
          ? await this.getAccountById(approvedDraft.social_account_id)
          : await this.getRandomAccount(approvedDraft.platform || 'reddit', [], campaignId, { allowSimulated: true });

        const activeRun = await campaignScorecardService.getActiveRun(campaignId);
        const reception = await simulateReception(approvedDraft, campaign);
        const engagement = {
          ...reception,
          from_approved_draft: true,
          sim_run_id: activeRun?.id || null,
        };

        const result = await pool.query(
          `UPDATE posts
           SET status = 'simulated',
               social_account_id = COALESCE($2, social_account_id),
               posted_at = NOW(),
               engagement_metrics = $3::jsonb,
               metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb
           WHERE id = $1
           RETURNING *`,
          [
            approvedDraft.id,
            account?.id || null,
            JSON.stringify(engagement),
            JSON.stringify({
              persona_id: reception.persona_id,
              sim_run_id: activeRun?.id || null,
              reception: reception.reception,
            }),
          ]
        );
        return result.rows[0];
      }

      const networks = await this.getCampaignNetworks(campaignId);
      if (!networks.length) throw new Error('No networks configured');

      // Randomly select a network
      const network = networks[Math.floor(Math.random() * networks.length)];
      
      // Get a random account for the selected network
      const account = await this.getRandomAccount(network.network_type, [], campaignId, { allowSimulated: true });
      if (!account) throw new Error(`No available accounts for ${network.network_type}`);

      // Check post limits
      await this.validatePostLimits(campaignId, network.network_type, account.id);

      let post;
      if (network.network_type === 'reddit') {
        const subreddit = await this.getRandomApprovedSubreddit(campaignId);
        if (!subreddit) throw new Error('No available subreddits');

      const content = await this.generateContent('post', campaign, {
          platform: network.network_type,
          subreddit: {
            subreddit_name: subreddit.subreddit_name,
            content_rules: subreddit.content_rules || subreddit.content_guidelines || [],
          },
          campaignId,
      });

        post = await pool.query(
          `INSERT INTO posts (campaign_id, platform, content, subreddit, social_account_id, status, posted_at)
           VALUES ($1, $2, $3, $4, $5, 'simulated', NOW())
           RETURNING *`,
          [campaignId, network.network_type, content, subreddit.subreddit_name, account.id]
        );
      } else if (network.network_type === 'tiktok') {
        // For TikTok, we need both a video and a caption
        const mediaResult = await pool.query(
          `SELECT media_assets FROM campaigns WHERE id = $1`,
          [campaignId]
        );
        
        const mediaAssets = mediaResult.rows[0]?.media_assets || [];
        const videoAsset = mediaAssets.find(asset => 
          asset.type.startsWith('video/')
        );
        
        if (!videoAsset) {
          throw new Error('No video assets available for TikTok post');
        }

        const caption = await this.generateContent('caption', campaign, {
          platform: network.network_type,
          videoContext: 'TikTok video showcasing the campaign message'
        });

        post = await pool.query(
          `INSERT INTO posts (
            campaign_id, platform, content, video_url, 
            caption, social_account_id, status, posted_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'simulated', NOW())
          RETURNING *`,
          [
            campaignId,
            network.network_type,
            caption, // Store caption as content for consistency
            videoAsset.url,
            caption,
            account.id
          ]
        );
      } else {
        // LinkedIn or X post
        const content = await this.generateContent('post', campaign, {
          platform: network.network_type
        });

        post = await pool.query(
          `INSERT INTO posts (campaign_id, platform, content, social_account_id, status, posted_at)
           VALUES ($1, $2, $3, $4, 'simulated', NOW())
           RETURNING *`,
          [campaignId, network.network_type, content, account.id]
        );
      }

      // Persona-driven reception (not random vanity metrics)
      const activeRun = await campaignScorecardService.getActiveRun(campaignId);
      const reception = await simulateReception(post.rows[0], campaign);
      const engagement = {
        ...reception,
        sim_run_id: activeRun?.id || null,
      };
      await pool.query(
        `UPDATE posts 
         SET engagement_metrics = $1,
             metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
         WHERE id = $2`,
        [
          JSON.stringify(engagement),
          post.rows[0].id,
          JSON.stringify({
            persona_id: reception.persona_id,
            sim_run_id: activeRun?.id || null,
            reception: reception.reception,
          }),
        ]
      );

      return { ...post.rows[0], engagement_metrics: engagement };
    } catch (error) {
      console.error('Error creating simulated post:', error);
      throw error;
    }
  }

  /** @deprecated Prefer simulateReception — kept for non-sim callers */
  generateEngagementMetrics(platform) {
    return {
      views: Math.floor(Math.random() * 100),
      shares: 0,
      upvotes: 0,
      likes: 0,
      reception: 'ignored',
      sim: false,
      platform,
    };
  }

  async validatePostLimits(campaignId, platform, accountId) {
    const campaign = await this.getCampaign(campaignId);
    if (!campaign) throw new Error('Campaign not found');

    let scope = {};
    if (campaign.simulation_mode) {
      try {
        const activeRun = await campaignScorecardService.getActiveRun(campaignId);
        if (activeRun?.id) {
          scope = { simRunId: activeRun.id, since: activeRun.started_at };
        }
      } catch { /* ignore */ }
    }

    const totalPosts = await this.getPostCount(campaignId, platform, scope);
    const accountPosts = await this.getAccountPostCount(campaignId, accountId, scope);

    let limitMessage = null;

    switch (platform) {
      case 'reddit':
        if (accountPosts >= campaign.posts_per_subreddit) {
          limitMessage = 'Subreddit post limit reached';
        }
        break;
      case 'linkedin':
        if (accountPosts >= campaign.posts_per_linkedin) {
          limitMessage = 'LinkedIn post limit reached';
        }
        break;
      case 'x':
        if (totalPosts >= campaign.total_x_posts) {
          limitMessage = 'Total X posts limit reached';
        }
        if (accountPosts >= campaign.posts_per_x) {
          limitMessage = 'X account post limit reached';
        }
        break;
      case 'tiktok':
        if (totalPosts >= campaign.total_tiktok_posts) {
          limitMessage = 'Total TikTok posts limit reached';
        }
        if (accountPosts >= campaign.posts_per_tiktok) {
          limitMessage = 'TikTok account post limit reached';
        }
        break;
    }

    if (limitMessage) {
      console.log(`Post limit reached for ${platform}: ${limitMessage}`);
      throw new Error(limitMessage);
    }
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
        if (lastPost && campaign.min_post_interval_hours) {
          const hoursSinceLastPost = (now - new Date(lastPost.posted_at)) / (1000 * 60 * 60);
          if (hoursSinceLastPost < campaign.min_post_interval_hours) {
            throw new Error('Minimum post interval not reached');
          }
        }
      }

      // Prefer publishing an approved draft (sim or live)
      const approvedDraft = await this.claimApprovedDraft(campaignId);
      if (approvedDraft) {
        try {
          const platform = approvedDraft.platform || 'reddit';
          const handler = this.platformHandlers[platform];
          if (!handler) throw new Error(`Unsupported platform: ${platform}`);

          const account = approvedDraft.social_account_id
            ? await this.getAccountById(approvedDraft.social_account_id)
            : await this.getRandomAccount(platform, [], campaignId);
          if (!account) throw new Error(`No available ${platform} account found`);

          await this.validatePostLimits(campaignId, platform, account.id);

          const context = approvedDraft.subreddit
            ? {
                subreddit: {
                  subreddit_name: approvedDraft.subreddit,
                  content_rules: approvedDraft.metadata?.subreddit_rules || [],
                },
              }
            : await handler.getPostContext(campaignId);

          const content = approvedDraft.content;
          const postData = await (isLive
            ? handler.createLivePost(campaign, account, content, context)
            : handler.createSimulatedPost(campaign, account, content, context));

          const result = await pool.query(
            `UPDATE posts SET
               social_account_id = $2,
               platform_post_id = $3,
               content = $4,
               status = $5,
               metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE($6::jsonb, '{}'::jsonb),
               subreddit = COALESCE($7, subreddit),
               posted_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [
              approvedDraft.id,
              postData.social_account_id,
              postData.platform_post_id || null,
              postData.content,
              postData.status,
              JSON.stringify({ ...(postData.metadata || {}), from_approved_draft: true }),
              postData.subreddit || null,
            ]
          );
          console.log(`Published approved draft ${approvedDraft.id} as ${postData.status}`);
          return result.rows[0];
        } catch (draftErr) {
          await pool.query(
            `UPDATE posts SET status = 'approved' WHERE id = $1 AND status = 'publishing'`,
            [approvedDraft.id]
          ).catch(() => {});
          throw draftErr;
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
          console.log(`Current post count for ${network.network_type}: ${postCount}`);

          // Get account before checking limits
          const account = await this.getRandomAccount(network.network_type, [], campaignId);
          if (!account) {
            const error = `No available ${network.network_type} account found`;
            console.warn(error);
            errors.push(error);
            continue;
          }

          // Validate post limits for the platform and account
          try {
            await this.validatePostLimits(campaignId, network.network_type, account.id);
          } catch (limitError) {
            console.log(limitError.message);
            errors.push(limitError.message);
            continue;
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
      const limitErrors = errors.filter(e => e.includes('Post limit reached') || e.includes('No available subreddits'));
      const otherErrors = errors.filter(e => !e.includes('Post limit reached') && !e.includes('No available subreddits'));

      if (limitErrors.length === networks.length) {
        // All platforms have reached their limits or have no available subreddits - this is normal
        console.log('All platforms have reached their limits or have no available posting locations:', limitErrors.join('\n'));
        return null;
      } else if (otherErrors.length > 0) {
        // We have actual errors to report
        const errorMessage = `Failed to create post on any platform:\n${otherErrors.join('\n')}`;
        console.error(errorMessage);
        throw new Error(errorMessage);
      }
      
      // If we get here, return null to indicate no post was created
      return null;
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

      // Get the account and its personality
      const account = await this.getRandomAccount(
        context.platform,
        [],
        context.campaignId || campaign.id,
        { allowSimulated: true }
      );

      // Inject audience persona for subreddit/platform
      let enrichedContext = { ...context };
      try {
        const subName = context.subreddit?.subreddit_name || context.subreddit;
        let audience = null;
        if (subName && typeof subName === 'string') {
          audience = await audiencePersonaService.getForSubreddit(campaign.id, subName);
          if (!audience) {
            audience = await audiencePersonaService.ensureForSubreddit(campaign.id, {
              subreddit_name: subName,
              content_guidelines: context.subreddit?.content_rules || [],
              reason: '',
            });
          }
        } else {
          audience = await audiencePersonaService.getPersona(campaign.id, 'platform', context.platform);
        }
        if (audience) {
          enrichedContext.audiencePersonaPrompt = audiencePersonaService.formatForPrompt(audience);
          enrichedContext.audiencePersona = audience;
        }
      } catch (personaErr) {
        console.warn('Audience persona inject skipped:', personaErr.message);
      }
      
      // Get network-specific style guidelines
      const networkStyle = await contentStyleService.getNetworkStyle(context.platform, type);
      
      // Generate base prompt from network style
      const basePrompt = contentStyleService.generateBasePrompt(networkStyle, type, {
        ...enrichedContext,
        campaign_overview: campaign.campaign_overview,
        campaign_goal: campaign.campaign_goal,
        post_goal: campaign.post_goal
      });
      
      // Generate persona
      const persona = this.generatePersona(campaign, account);
      
      // Combine network style with persona
      const finalPrompt = contentStyleService.combineWithPersona(basePrompt, persona);

      // Check content diversity before generating
      const recentContent = await this.getRecentContent(campaign.id, context.platform);

      const diversityGuidance = recentContent.length > 0
        ? `\n\nAvoid repeating these ideas from recent content:\n${recentContent.join('\n')}`
        : '';

      const learnings = campaign.active_learnings || context.active_learnings || null;
      const learningsBlock = simLearningsService.formatForPrompt(learnings);

      const isReddit = context.platform === 'reddit';
      const systemContent = isReddit
        ? `${getRedditSystemPrompt()}\n\n${finalPrompt}${learningsBlock}`
        : `${finalPrompt}${learningsBlock}`;

      const completion = await openai.chat.completions.create(
        generationCompletionOptions({
          messages: [
            { role: "system", content: systemContent },
            { role: "user", content: handler.buildPrompt(type, campaign, enrichedContext, account) + diversityGuidance }
          ],
        })
      );

      let content = completion.choices?.[0]?.message?.content.trim();
      if (!content) throw new Error('Failed to generate content');

      if (isReddit) {
        content = sanitizeRedditPost(content);
      }

      this.validateContentLength(content, context.platform);
      this.recentContentCache.add(content);

      return content;
    } catch (error) {
      console.error('Error generating content:', error);
      throw error;
    }
  }

  contentSimilarity(a, b) {
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
    const union = new Set([...wordsA, ...wordsB]);
    return intersection.size / union.size;
  }

  validateContentLength(content, platform) {
    const limits = {
      x: 280,
      linkedin: 3000,
      reddit: 40000,
      tiktok: 2200
    };

    const limit = limits[platform];
    if (!limit) return;

    if (content.length > limit) {
      throw new Error(`Content exceeds ${platform}'s ${limit} character limit (${content.length} chars)`);
    }
  }

  async getRecentContent(campaignId, platform) {
    const result = await pool.query(
      `SELECT content FROM posts 
       WHERE campaign_id = $1 AND platform = $2 
       ORDER BY posted_at DESC LIMIT 5`,
      [campaignId, platform]
    );
    return result.rows.map(r => r.content);
  }

  generatePersona(campaign, account) {
    const traits = account.persona_traits;
    if (!traits) return this.generateDefaultPersona(campaign);

    return `You are a ${traits.tone} social media user with a ${traits.writingStyle} writing style.
You have background in ${traits.expertise.join(' and ')}.
You tend to write ${traits.responseLength} posts and engage as a ${traits.engagementStyle}.

Your quirks: ${traits.quirks.map(quirk => quirk.replace(/_/g, ' ')).join(', ')}.

When posting:
- Write naturally in your ${traits.writingStyle} style
- Draw from your background when relevant, but don't explicitly state it
- Keep posts ${traits.responseLength} in length
- Maintain a ${traits.tone} tone
- Incorporate your quirks naturally
- Stay in character as a ${traits.engagementStyle}

Campaign context: ${campaign.campaign_goal}

Remember: You are a real person sharing authentic thoughts - let your knowledge and experience come through naturally in your writing style and examples.`;
  }

  generateDefaultPersona(campaign) {
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

  async getRandomApprovedSubreddit(campaignId) {
    try {
      console.log('Getting random approved subreddit for campaign:', campaignId);

      // Scope simulated post counts to the active sim run so each run can post again
      let activeRun = null;
      try {
        activeRun = await campaignScorecardService.getActiveRun(campaignId);
      } catch { /* ignore */ }

      const params = [campaignId];
      let runFilter = '';
      if (activeRun?.id) {
        params.push(String(activeRun.id), activeRun.started_at);
        runFilter = `AND (
          (engagement_metrics->>'sim_run_id') = $2
          OR (metadata->>'sim_run_id') = $2
          OR (
            (engagement_metrics->>'sim_run_id') IS NULL
            AND (metadata->>'sim_run_id') IS NULL
            AND COALESCE(posted_at, created_at) >= $3
          )
        )`;
      }

      const query = `
        WITH subreddit_posts AS (
          SELECT subreddit, COUNT(*) as post_count
          FROM posts
          WHERE campaign_id = $1
            AND status IN ('simulated', 'posted')
            ${runFilter}
          GROUP BY subreddit
        )
        SELECT s.subreddit_name, s.reason
        FROM subreddit_suggestions s
        LEFT JOIN subreddit_posts p ON p.subreddit = s.subreddit_name
        WHERE s.campaign_id = $1
        AND s.status = 'approved'
        AND (p.post_count IS NULL OR p.post_count < (
          SELECT posts_per_subreddit
          FROM campaigns
          WHERE id = $1
        ))
         ORDER BY RANDOM()
        LIMIT 1`;

      const suggestionsResult = await pool.query(query, params);

      if (suggestionsResult.rows.length > 0) {
        console.log('Found approved subreddit from suggestions:', suggestionsResult.rows[0]);
        return {
          subreddit_name: suggestionsResult.rows[0].subreddit_name,
          content_rules: [],
        };
      }

      console.log('No available subreddits found for campaign:', campaignId);
      return null;
    } catch (error) {
      console.error('Error getting random subreddit:', error);
      throw error;
    }
  }

  async getAccountById(accountId) {
    if (!accountId) return null;
    const result = await pool.query('SELECT * FROM social_accounts WHERE id = $1', [accountId]);
    return result.rows[0] || null;
  }

  async getRandomAccount(platform, excludeIds = [], campaignId = null, { allowSimulated = false } = {}) {
    try {
      if (campaignId) {
        const available = await campaignAccountService.getAvailableAccounts(
          campaignId, platform, excludeIds
        );
        const usable = allowSimulated
          ? available
          : available.filter(a =>
              !a.is_simulated && a.credentials?.password !== 'default_password'
            );
        if (usable.length) {
          const account = usable[0];
          if (!account.persona_traits) {
            const persona = await commentingService.generatePersonalityTraits();
            await pool.query(
              `UPDATE social_accounts SET persona_traits = $1 WHERE id = $2`,
              [JSON.stringify(persona), account.id]
            );
            account.persona_traits = persona;
          }
          return account;
        }
        if (!allowSimulated) {
          throw new Error(
            `No real ${platform} accounts available for campaign ${campaignId}. Assign accounts on the Launch tab.`
          );
        }
      }

      const realFilter = allowSimulated
        ? ''
        : `AND COALESCE(is_simulated, false) = false
           AND COALESCE(credentials->>'password', '') != 'default_password'`;

      const query = `
        SELECT * FROM social_accounts 
        WHERE platform = $1 
        AND status = 'active'
        ${realFilter}
        ${excludeIds.length > 0 ? 'AND id != ANY($2)' : ''}
        ORDER BY RANDOM()
        LIMIT 1`;
      
      const params = excludeIds.length > 0 ? [platform, excludeIds] : [platform];
      const result = await pool.query(query, params);
      
      if (!result.rows[0]) {
        if (allowSimulated) {
          const persona = await commentingService.generatePersonalityTraits();
          const username = `sim_${Math.floor(Math.random() * 10000)}`;
          const created = await pool.query(
            `INSERT INTO social_accounts
             (platform, username, credentials, status, persona_traits, is_simulated)
             VALUES ($1, $2, $3, 'active', $4, true)
             RETURNING *`,
            [platform, username, JSON.stringify({ password: 'default_password' }), JSON.stringify(persona)]
          );
          return created.rows[0];
        }
        throw new Error(
          `No real ${platform} accounts available. Create accounts under Social Accounts.`
        );
      }

      if (!result.rows[0].persona_traits) {
        const persona = await commentingService.generatePersonalityTraits();
        await pool.query(
          `UPDATE social_accounts SET persona_traits = $1 WHERE id = $2`,
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

  async getPostCount(campaignId, platform, { simRunId = null, since = null } = {}) {
    try {
      const params = [campaignId, platform];
      let runFilter = '';
      if (simRunId) {
        params.push(String(simRunId));
        runFilter = `AND (
          (engagement_metrics->>'sim_run_id') = $3
          OR (metadata->>'sim_run_id') = $3
        )`;
        if (since) {
          params.push(since);
          runFilter = `AND (
            (engagement_metrics->>'sim_run_id') = $3
            OR (metadata->>'sim_run_id') = $3
            OR (
              (engagement_metrics->>'sim_run_id') IS NULL
              AND (metadata->>'sim_run_id') IS NULL
              AND COALESCE(posted_at, created_at) >= $4
            )
          )`;
        }
      }
      const result = await pool.query(
        `SELECT COUNT(*) FROM posts
         WHERE campaign_id = $1 AND platform = $2
           AND status IN ('simulated', 'posted')
           ${runFilter}`,
        params
      );
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      console.error('Error getting post count:', error);
      throw error;
    }
  }

  async getAccountPostCount(campaignId, accountId, { simRunId = null, since = null } = {}) {
    try {
      const params = [campaignId, accountId];
      let runFilter = '';
      if (simRunId) {
        params.push(String(simRunId));
        runFilter = `AND (
          (engagement_metrics->>'sim_run_id') = $3
          OR (metadata->>'sim_run_id') = $3
        )`;
        if (since) {
          params.push(since);
          runFilter = `AND (
            (engagement_metrics->>'sim_run_id') = $3
            OR (metadata->>'sim_run_id') = $3
            OR (
              (engagement_metrics->>'sim_run_id') IS NULL
              AND (metadata->>'sim_run_id') IS NULL
              AND COALESCE(posted_at, created_at) >= $4
            )
          )`;
        }
      }
      const result = await pool.query(
        `SELECT COUNT(*) FROM posts
         WHERE campaign_id = $1 AND social_account_id = $2
           AND status IN ('simulated', 'posted')
           ${runFilter}`,
        params
      );
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      console.error('Error getting account post count:', error);
      throw error;
    }
  }

  async generateDraftPosts(campaignId, count = 3) {
    const campaign = await this.getCampaign(campaignId);
    if (!campaign) throw new Error('Campaign not found');

    const approved = await subredditService.getApprovedSubreddits(campaignId);
    if (!approved.length) {
      throw new Error('Approve at least one subreddit before generating posts');
    }

    const uniqueSubs = [...new Map(
      approved.map(s => [s.subreddit_name.toLowerCase(), s])
    ).values()];

    const drafts = [];
    const errors = [];

    for (let i = 0; i < count; i++) {
      const sub = uniqueSubs[i % uniqueSubs.length];
      try {
        const guidelines = Array.isArray(sub.content_guidelines)
          ? sub.content_guidelines
          : (sub.content_guidelines ? JSON.parse(sub.content_guidelines) : []);

        try {
          // Only generate persona if missing — don't block draft gen on existing ones
          const existing = await audiencePersonaService.getForSubreddit(campaignId, sub.subreddit_name);
          if (!existing) {
            await audiencePersonaService.ensureForSubreddit(campaignId, sub);
          }
        } catch { /* non-blocking */ }

        const context = {
          platform: 'reddit',
          campaignId,
          subreddit: {
            subreddit_name: sub.subreddit_name,
            content_rules: guidelines,
          },
        };

        const content = await this.generateContent('post', campaign, context);
        let account = null;
        try {
          account = await this.getRandomAccount('reddit', [], campaignId);
        } catch {
          /* drafts can exist without an assigned account yet */
        }

        const result = await pool.query(
          `INSERT INTO posts (campaign_id, platform, content, subreddit, social_account_id, status, metadata, posted_at)
           VALUES ($1, 'reddit', $2, $3, $4, 'draft', $5, NOW())
           RETURNING *`,
          [
            campaignId,
            content,
            sub.subreddit_name,
            account?.id || null,
            JSON.stringify({ generated: true, subreddit_reason: sub.reason }),
          ]
        );
        drafts.push(result.rows[0]);
      } catch (err) {
        errors.push(`r/${sub.subreddit_name}: ${err.message}`);
      }
    }

    if (drafts.length === 0) {
      throw new Error(errors.join('; ') || 'Failed to generate any draft posts');
    }

    return drafts;
  }

  async updatePostStatus(postId, campaignId, status) {
    const allowed = ['draft', 'approved', 'rejected', 'simulated', 'posted', 'publishing'];
    if (!allowed.includes(status)) {
      throw new Error(`Invalid status. Must be one of: ${allowed.join(', ')}`);
    }

    const result = await pool.query(
      `UPDATE posts SET status = $1 WHERE id = $2 AND campaign_id = $3 RETURNING *`,
      [status, postId, campaignId]
    );

    if (result.rows.length === 0) {
      throw new Error('Post not found');
    }

    return result.rows[0];
  }

  async listPostsForReview(campaignId) {
    const result = await pool.query(
      `SELECT p.*, sa.username as posted_by
       FROM posts p
       LEFT JOIN social_accounts sa ON p.social_account_id = sa.id
       WHERE p.campaign_id = $1
       ORDER BY
         CASE p.status
           WHEN 'approved' THEN 1
           WHEN 'draft' THEN 2
           WHEN 'rejected' THEN 3
           ELSE 4
         END,
         p.posted_at DESC`,
      [campaignId]
    );
    return result.rows;
  }
}

module.exports = new PostingService();