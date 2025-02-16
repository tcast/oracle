const pool = require('./db');
const openai = require('./openai');

class SubredditService {
  async suggestSubreddits(campaignId, goal) {
    try {
      console.log('Generating subreddit suggestions for campaign:', campaignId, 'with goal:', goal);

      const prompt = `Based on this campaign goal: "${goal}"
                   Suggest as many relevant subreddits as needed where this content would be well-received.
                   For each subreddit, provide:
                   1. The exact subreddit name (without r/)
                   2. A detailed reason why this community would be interested
                   3. Estimated subscriber count
                   4. Key content guidelines to follow
                   
                   Format your response as a JSON object with this exact structure:
                   {
                     "subreddits": [
                       {
                         "subreddit_name": "example",
                         "reason": "Detailed explanation...",
                         "subscriber_count": 50000,
                         "content_guidelines": ["Guideline 1", "Guideline 2"]
                       }
                     ]
                   }`;

      console.log('Sending prompt to OpenAI:', prompt);

      const completion = await openai.createChatCompletion({
        model: "gpt-4",
        messages: [
          {
            role: "system",
            content: "You are a Reddit expert who understands each subreddit's culture, rules, and engagement patterns. You analyze campaign goals and suggest the most relevant subreddits while being mindful of Reddit's promotion rules."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.7
      });

      console.log('Raw OpenAI response:', completion.data);
      const content = completion.data.choices[0].message.content;
      console.log('Response content:', content);

      // Extract just the JSON portion
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Could not find valid JSON in response');
      }
      
      const suggestions = JSON.parse(jsonMatch[0]);
      console.log('Parsed suggestions:', suggestions);

    
      // Store suggestions in database
      return await this.storeSuggestions(campaignId, suggestions.subreddits);
    } catch (error) {
      console.error('Error in suggestSubreddits:', error);
      if (error.response) {
        console.error('OpenAI API error:', error.response.data);
      }
      throw error;
    }
  }
  
  async storeSuggestions(campaignId, suggestions) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get or create campaign network
      const networkResult = await client.query(
        `INSERT INTO campaign_networks (campaign_id, network_type, settings)
         VALUES ($1, 'reddit', '{}')
         ON CONFLICT (campaign_id, network_type) DO UPDATE 
         SET updated_at = NOW()
         RETURNING id`,
        [campaignId]
      );

      const networkId = networkResult.rows[0].id;
      const storedSuggestions = [];

      for (const suggestion of suggestions) {
        // Store subreddit
        const subredditResult = await client.query(
          `INSERT INTO reddit_subreddits 
           (subreddit_name, description, subscriber_count, content_rules)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (subreddit_name) 
           DO UPDATE SET 
             subscriber_count = EXCLUDED.subscriber_count,
             content_rules = EXCLUDED.content_rules
           RETURNING *`,
          [
            suggestion.subreddit_name,
            suggestion.reason,
            suggestion.subscriber_count,
            suggestion.content_guidelines
          ]
        );

        // Create campaign_subreddits relationship
        const relationResult = await client.query(
          `INSERT INTO campaign_subreddits 
           (campaign_network_id, subreddit_id, status)
           VALUES ($1, $2, 'pending')
           ON CONFLICT (campaign_network_id, subreddit_id) 
           DO UPDATE SET status = 'pending'
           RETURNING *`,
          [networkId, subredditResult.rows[0].id]
        );

        storedSuggestions.push({
          ...subredditResult.rows[0],
          status: relationResult.rows[0].status
        });
      }

      await client.query('COMMIT');
      return storedSuggestions;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getSubredditsForCampaign(campaignId) {
    try {
      const result = await pool.query(
        `SELECT rs.*, cs.status
         FROM reddit_subreddits rs
         JOIN campaign_subreddits cs ON cs.subreddit_id = rs.id
         JOIN campaign_networks cn ON cs.campaign_network_id = cn.id
         WHERE cn.campaign_id = $1
         ORDER BY rs.subscriber_count DESC`,
        [campaignId]
      );
      return result.rows;
    } catch (error) {
      console.error('Error fetching subreddits:', error);
      throw error;
    }
  }

  async updateSubredditStatus(suggestionId, status) {
    try {
      const result = await pool.query(
        `UPDATE campaign_subreddits
         SET status = $2
         WHERE subreddit_id = $1
         RETURNING *`,
        [suggestionId, status]
      );
      return result.rows[0];
    } catch (error) {
      console.error('Error updating subreddit status:', error);
      throw error;
    }
  }

  async getApprovedSubreddits(campaignId) {
    try {
      const result = await pool.query(
        `SELECT rs.* 
         FROM reddit_subreddits rs
         JOIN campaign_subreddits cs ON cs.subreddit_id = rs.id
         JOIN campaign_networks cn ON cs.campaign_network_id = cn.id
         WHERE cn.campaign_id = $1 
         AND cs.status = 'approved'
         ORDER BY rs.subscriber_count DESC`,
        [campaignId]
      );
      return result.rows;
    } catch (error) {
      console.error('Error getting approved subreddits:', error);
      throw error;
    }
  }
}

module.exports = new SubredditService();