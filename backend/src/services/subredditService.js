const pool = require('./db');
const { Configuration, OpenAIApi } = require('openai');

class SubredditService {
  constructor() {
    if (process.env.OPENAI_API_KEY) {
      this.configuration = new Configuration({
        apiKey: process.env.OPENAI_API_KEY,
      });
      this.openai = new OpenAIApi(this.configuration);
    }
  }

  async suggestSubreddits(campaignId, goal) {
    try {
      if (!campaignId) {
        throw new Error('Campaign ID is required');
      }
      if (!goal) {
        throw new Error('Campaign goal is required');
      }

      console.log('Starting subreddit suggestion generation for campaign:', campaignId);
      
      // Get campaign details
      const campaignResult = await pool.query(
        'SELECT campaign_overview, campaign_goal FROM campaigns WHERE id = $1',
        [campaignId]
      );
      
      if (campaignResult.rows.length === 0) {
        throw new Error('Campaign not found');
      }

      const { campaign_overview, campaign_goal } = campaignResult.rows[0];
      console.log('Campaign overview:', campaign_overview);
      console.log('Campaign goal:', campaign_goal);

      // Verify OpenAI configuration
      if (!process.env.OPENAI_API_KEY) {
        throw new Error('OpenAI API key is not configured');
      }

      if (!this.openai) {
        this.configuration = new Configuration({
          apiKey: process.env.OPENAI_API_KEY,
        });
        this.openai = new OpenAIApi(this.configuration);
      }

      console.log('Making OpenAI API request...');
      
      const completion = await this.openai.createChatCompletion({
        model: "gpt-4",
        messages: [
          {
            role: "system",
            content: "You are a Reddit expert who understands each subreddit's culture, rules, and engagement patterns. Suggest both mainstream and niche subreddits that would be receptive to the content. Always format subscriber counts as numbers or with K/M suffix (e.g., 50000, 50K, 1.8M)."
          },
          {
            role: "user",
            content: `Based on this campaign:

Campaign Overview: "${campaign_overview}"
Campaign Goal: "${campaign_goal}"

Suggest relevant subreddits where this content would be well-received.
Include a mix of:
1. Large, mainstream subreddits (1M+ subscribers)
2. Medium-sized topical subreddits (100K-1M subscribers)
3. Smaller, highly-focused niche subreddits (<100K subscribers)

For each subreddit, provide:
1. The exact subreddit name (without r/)
2. A detailed reason why this community would be interested
3. Estimated subscriber count (use format: 50000, 50K, or 1.8M)
4. Key content guidelines to follow
                     
Format your response as a JSON object with this structure:
{
  "subreddits": [
    {
      "subreddit_name": "example",
      "reason": "Detailed explanation...",
      "subscriber_count": "1.8M",
      "content_guidelines": ["Guideline 1", "Guideline 2"]
    }
  ]
}`
          }
        ],
        temperature: 0.7
      });


      // ... rest of OpenAI response handling ...

      const content = completion.data.choices[0].message.content;
      console.log('Received response from OpenAI:', content);

      // Parse and clean the response before JSON parsing
      let cleanedContent = content.replace(/Million/g, 'M')
                                .replace(/Thousand/g, 'K')
                                .replace(/(\d+)K/g, '$1000')
                                .replace(/(\d+\.\d+)K/g, (match, p1) => (parseFloat(p1) * 1000).toString());

      const jsonMatch = cleanedContent.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Invalid response format from OpenAI');
      }

      let suggestions = JSON.parse(jsonMatch[0]);
      
      // Convert subscriber counts and format data
      const formattedSuggestions = suggestions.subreddits.map(s => ({
        subreddit_name: s.subreddit_name,
        reason: s.reason,
        subscriber_count: this.parseSubscriberCount(s.subscriber_count)
      }));

      console.log('Formatted suggestions:', formattedSuggestions);  // Add this for debugging

      return await this.storeSuggestions(campaignId, formattedSuggestions);

    } catch (error) {
      console.error('Error in suggestSubreddits:', error);
      throw new Error(`Failed to generate suggestions: ${error.message}`);
    }
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

  async storeSuggestions(campaignId, suggestions) {
    try {
      console.log('Storing suggestions:', suggestions);  // Add this for debugging

      // Validate input
      if (!Array.isArray(suggestions)) {
        throw new Error('Suggestions must be an array');
      }

      const values = suggestions.map(s => {
        // Only check for required fields
        if (!s.subreddit_name || !s.reason || typeof s.subscriber_count === 'undefined') {
          console.error('Invalid suggestion format:', s);  // Add this for debugging
          throw new Error('Invalid suggestion format - missing required fields');
        }
        return [
          campaignId,
          s.subreddit_name,
          s.reason,
          s.subscriber_count,
          s.content_guidelines ? JSON.stringify(s.content_guidelines) : JSON.stringify([])
        ];
      });

      const results = await Promise.all(values.map(async v => {
        try {
          const result = await pool.query(
            `INSERT INTO subreddit_suggestions 
             (campaign_id, subreddit_name, reason, subscriber_count, content_guidelines)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            v
          );
          return result.rows[0];
        } catch (error) {
          console.error('Error inserting suggestion:', error, 'Values:', v);
          throw error;
        }
      }));

      console.log('Successfully stored suggestions:', results);
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

      console.log('Updated subreddit suggestion:', result.rows[0]);
      return result.rows[0];
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