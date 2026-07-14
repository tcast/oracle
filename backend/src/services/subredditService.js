const pool = require('./db');
const OpenAI = require('openai');
const { generationCompletionOptions } = require('../config/openaiModels');

class SubredditService {
  constructor() {
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
    }
  }

  async suggestSubreddits(campaignId, goal, options = {}) {
    try {
      if (!campaignId) {
        throw new Error('Campaign ID is required');
      }
      if (!goal) {
        throw new Error('Campaign goal is required');
      }

      console.log('Starting subreddit suggestion generation for campaign:', campaignId);
      
      const campaignResult = await pool.query(
        'SELECT campaign_overview, campaign_goal FROM campaigns WHERE id = $1',
        [campaignId]
      );
      
      if (campaignResult.rows.length === 0) {
        throw new Error('Campaign not found');
      }

      const { campaign_overview, campaign_goal } = campaignResult.rows[0];
      const existing = await this.getSubredditsForCampaign(campaignId);
      const prompt = this.buildSuggestionPrompt({
        campaign_overview,
        campaign_goal: campaign_goal || goal,
        existing,
        ...options,
      });

      const formattedSuggestions = await this.fetchSuggestionsFromAI(prompt);
      return await this.storeSuggestions(campaignId, formattedSuggestions);
    } catch (error) {
      console.error('Error in suggestSubreddits:', error);
      throw new Error(`Failed to generate suggestions: ${error.message}`);
    }
  }

  async refineSubreddits(campaignId, { seedSubreddits = [], hint = '' } = {}) {
    if (!campaignId) throw new Error('Campaign ID is required');
    if (!seedSubreddits.length) throw new Error('At least one approved subreddit is required to refine');

    const campaignResult = await pool.query(
      'SELECT campaign_overview, campaign_goal FROM campaigns WHERE id = $1',
      [campaignId]
    );
    if (campaignResult.rows.length === 0) throw new Error('Campaign not found');

    const existing = await this.getSubredditsForCampaign(campaignId);
    const seeds = existing.filter(s => seedSubreddits.includes(s.subreddit_name));
    const rejected = existing.filter(s => s.status === 'rejected').map(s => s.subreddit_name);

    const prompt = this.buildSuggestionPrompt({
      campaign_overview: campaignResult.rows[0].campaign_overview,
      campaign_goal: campaignResult.rows[0].campaign_goal,
      existing,
      seedSubreddits: seeds,
      rejectedSubreddits: rejected,
      hint,
      refine: true,
    });

    const formattedSuggestions = await this.fetchSuggestionsFromAI(prompt);
    return await this.storeSuggestions(campaignId, formattedSuggestions);
  }

  buildSuggestionPrompt({
    campaign_overview,
    campaign_goal,
    existing = [],
    seedSubreddits = [],
    rejectedSubreddits = [],
    hint = '',
    refine = false,
  }) {
    const existingNames = existing.map(s => s.subreddit_name).join(', ') || 'none';
    const seedBlock = seedSubreddits.length
      ? seedSubreddits.map(s => `- r/${s.subreddit_name}: ${s.reason}`).join('\n')
      : '';
    const rejectedBlock = rejectedSubreddits.length ? rejectedSubreddits.map(n => `- r/${n}`).join('\n') : '';

    const task = refine
      ? `The user approved these subreddits as a good fit. Suggest 5-8 MORE subreddits that are similar in audience, tone, and topic — adjacent communities, sister subs, and niches the same users frequent.

Approved subreddits (use as seeds):
${seedBlock}

Do NOT suggest any subreddit already in the list or rejected list.`
      : `Suggest 6-10 relevant subreddits where this content would be well-received.
Include a mix of:
1. Large, mainstream subreddits (1M+ subscribers)
2. Medium-sized topical subreddits (100K-1M subscribers)
3. Smaller, highly-focused niche subreddits (<100K subscribers)`;

    let extra = '';
    if (rejectedBlock) extra += `\nRejected subreddits (do NOT suggest these):\n${rejectedBlock}\n`;
    if (hint) extra += `\nUser refinement hint: "${hint}"\n`;
    if (existingNames !== 'none') extra += `\nAlready suggested (do NOT duplicate): ${existingNames}\n`;

    return `${task}

Campaign Overview: "${campaign_overview}"
Campaign Goal: "${campaign_goal}"
${extra}
For each subreddit, provide:
1. The exact subreddit name (without r/)
2. A detailed reason why this community would be interested
3. Estimated subscriber count (use format: 50000, 50K, or 1.8M)
4. Key content guidelines to follow

Format your response as a JSON object:
{
  "subreddits": [
    {
      "subreddit_name": "example",
      "reason": "Detailed explanation...",
      "subscriber_count": "1.8M",
      "content_guidelines": ["Guideline 1", "Guideline 2"]
    }
  ]
}`;
  }

  async fetchSuggestionsFromAI(userPrompt) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OpenAI API key is not configured');
    }

    if (!this.openai) {
      this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }

    const completion = await this.openai.chat.completions.create(
      generationCompletionOptions({
        messages: [
          {
            role: 'system',
            content: 'You are a Reddit expert who understands each subreddit\'s culture, rules, and engagement patterns. Suggest real, active subreddits. Always format subscriber counts as numbers or with K/M suffix (e.g., 50000, 50K, 1.8M). Return valid JSON only.',
          },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
      })
    );

    const content = completion.choices[0].message.content;
    let cleanedContent = content
      .replace(/Million/g, 'M')
      .replace(/Thousand/g, 'K');

    const jsonMatch = cleanedContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Invalid response format from OpenAI');

    const suggestions = JSON.parse(jsonMatch[0]);
    return (suggestions.subreddits || []).map(s => ({
      subreddit_name: s.subreddit_name.replace(/^\/?r\//, ''),
      reason: s.reason,
      subscriber_count: this.parseSubscriberCount(s.subscriber_count),
      content_guidelines: s.content_guidelines || [],
    }));
  }

  async addManualSubreddit(campaignId, subredditName, reason) {
    const name = subredditName.replace(/^\/?r\//, '').trim();
    if (!name) throw new Error('Subreddit name is required');

    const existing = await pool.query(
      'SELECT id FROM subreddit_suggestions WHERE campaign_id = $1 AND LOWER(subreddit_name) = LOWER($2)',
      [campaignId, name]
    );
    if (existing.rows.length) {
      throw new Error(`r/${name} is already in the list`);
    }

    const rows = await this.storeSuggestions(campaignId, [{
      subreddit_name: name,
      reason: reason || `Manually added r/${name}`,
      subscriber_count: 0,
      content_guidelines: [],
    }]);
    return rows[0];
  }

  parseSubscriberCount(count) {
    if (typeof count === 'number') return count;
    
    if (typeof count === 'string') {
      // Remove any commas and convert Million/Thousand to M/K
      count = count.replace(/,/g, '')
                   .replace(/Million/gi, 'M')
                   .replace(/Thousand/gi, 'K');
      
      // Handle millions
      if (count.endsWith('M')) {
        return Math.round(parseFloat(count) * 1000000);
      }
      // Handle thousands
      if (count.endsWith('K')) {
        return Math.round(parseFloat(count) * 1000);
      }
      // Handle regular numbers
      return parseInt(count, 10);
    }
    
    return 0; // fallback value
  }

  async storeSuggestions(campaignId, suggestions, client = null) {
    const db = client || pool;
    try {
      if (!Array.isArray(suggestions)) {
        throw new Error('Suggestions must be an array');
      }

      const existing = await db.query(
        'SELECT subreddit_name FROM subreddit_suggestions WHERE campaign_id = $1',
        [campaignId]
      );
      const existingNames = new Set(existing.rows.map(r => r.subreddit_name.toLowerCase()));

      const toInsert = suggestions.filter(s => {
        if (!s.subreddit_name || !s.reason || typeof s.subscriber_count === 'undefined') {
          throw new Error('Invalid suggestion format - missing required fields');
        }
        return !existingNames.has(s.subreddit_name.toLowerCase());
      });

      if (toInsert.length === 0) return [];

      const results = await Promise.all(toInsert.map(async s => {
        const result = await db.query(
          `INSERT INTO subreddit_suggestions
           (campaign_id, subreddit_name, reason, subscriber_count, content_guidelines)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [
            campaignId,
            s.subreddit_name,
            s.reason,
            s.subscriber_count,
            s.content_guidelines ? JSON.stringify(s.content_guidelines) : JSON.stringify([]),
          ]
        );
        return result.rows[0];
      }));

      return results;
    } catch (error) {
      console.error('Error in storeSuggestions:', error);
      throw new Error(`Failed to store suggestions: ${error.message}`);
    }
  }

  async getSubredditsForCampaign(campaignId) {
    try {
      const result = await pool.query(
        'SELECT * FROM subreddit_suggestions WHERE campaign_id = $1',
        [campaignId]
      );
      return result.rows;
    } catch (error) {
      console.error('Error getting subreddits for campaign:', error);
      throw new Error('Failed to fetch subreddits');
    }
  }

  async updateSuggestionStatus(id, status) {
    try {
      const result = await pool.query(
        `UPDATE subreddit_suggestions 
         SET status = $1, 
             updated_at = NOW() 
         WHERE id = $2 
         RETURNING *`,
        [status, id]
      );

      if (result.rows.length === 0) {
        throw new Error('Subreddit suggestion not found');
      }

      const suggestion = result.rows[0];
      console.log('Updated subreddit suggestion:', suggestion);

      // Generate persona in background — don't block the approve response
      if (status === 'approved' && suggestion.campaign_id) {
        setImmediate(() => {
          const audiencePersonaService = require('./audiencePersonaService');
          audiencePersonaService
            .ensureForSubreddit(suggestion.campaign_id, suggestion)
            .catch((personaErr) => {
              console.warn('Persona generation on approve failed:', personaErr.message);
            });
        });
      }

      return suggestion;
    } catch (error) {
      console.error('Error in updateSuggestionStatus:', error);
      throw new Error(`Failed to update suggestion status: ${error.message}`);
    }
  }

  async getApprovedSubreddits(campaignId) {
    try {
      const result = await pool.query(
        `SELECT * FROM subreddit_suggestions 
         WHERE campaign_id = $1 AND status = 'approved'
         ORDER BY subscriber_count DESC`,
        [campaignId]
      );
      return result.rows;
    } catch (error) {
      console.error('Error getting approved subreddits:', error);
      throw error;
    }
  }

  async getRandomApprovedSubreddit(campaignId) {
    try {
      console.log('Getting random approved subreddit for campaign:', campaignId);
      
      // Get all approved subreddits that haven't reached their post limit
      const query = `
        WITH subreddit_posts AS (
          SELECT subreddit, COUNT(*) as post_count
          FROM posts
          WHERE campaign_id = $1 
          AND status IN ('simulated', 'posted')
          GROUP BY subreddit
        )
        SELECT s.subreddit_name, s.reason, s.content_guidelines
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
      
      console.log('Executing query:', query);
      console.log('With campaign ID:', campaignId);
      
      const suggestionsResult = await pool.query(query, [campaignId]);
      console.log('Query result:', suggestionsResult.rows);

      // If we find an approved suggestion that hasn't reached its limit, use it
      if (suggestionsResult.rows.length > 0) {
        const suggestion = suggestionsResult.rows[0];
        console.log('Found approved subreddit from suggestions:', suggestion);
        return {
          subreddit_name: suggestion.subreddit_name,
          content_rules: suggestion.content_guidelines || []
        };
      }

      console.log('No available subreddits found for campaign:', campaignId);
      return null;
    } catch (error) {
      console.error('Error getting random subreddit:', error);
      throw error;
    }
  }
}

module.exports = new SubredditService();