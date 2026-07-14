const pool = require('./db');
const openai = require('./openai');
const { computeCampaignReputation } = require('./campaignReputationService');
const { generationCompletionOptions } = require('../config/openaiModels');
const simLearningsService = require('./simLearningsService');

function letterGrade(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function clamp(n, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, n));
}

class CampaignScorecardService {
  async startSimRun(campaignId) {
    // Close any prior running run
    await pool.query(
      `UPDATE campaign_sim_runs
       SET status = 'abandoned', ended_at = NOW()
       WHERE campaign_id = $1 AND status = 'running'`,
      [campaignId]
    );

    const campaign = await this.getCampaign(campaignId);
    const objectives = {
      campaign_goal: campaign?.campaign_goal || '',
      campaign_overview: campaign?.campaign_overview || '',
      post_goal: parseInt(campaign?.post_goal, 10) || 5,
      comment_goal: parseInt(campaign?.comment_goal, 10) || 3,
      target_sentiment: Number(campaign?.target_sentiment) || 0.5,
      target_url: campaign?.target_url || null,
    };

    const result = await pool.query(
      `INSERT INTO campaign_sim_runs (campaign_id, status, objectives_snapshot)
       VALUES ($1, 'running', $2::jsonb)
       RETURNING *`,
      [campaignId, JSON.stringify(objectives)]
    );
    return result.rows[0];
  }

  async getActiveRun(campaignId) {
    const result = await pool.query(
      `SELECT * FROM campaign_sim_runs
       WHERE campaign_id = $1 AND status = 'running'
       ORDER BY started_at DESC
       LIMIT 1`,
      [campaignId]
    );
    return result.rows[0] || null;
  }

  async getLatestRun(campaignId) {
    const result = await pool.query(
      `SELECT * FROM campaign_sim_runs
       WHERE campaign_id = $1
       ORDER BY started_at DESC
       LIMIT 1`,
      [campaignId]
    );
    return result.rows[0] || null;
  }

  async finalizeSimRun(campaignId) {
    const run = await this.getActiveRun(campaignId);
    if (!run) {
      // Score latest abandoned/completed or create snapshot from all sim data
      const latest = await this.getLatestRun(campaignId);
      if (latest?.scorecard) return latest;
      const scorecard = await this.computeScorecard(campaignId, null);
      return { campaign_id: campaignId, status: 'completed', scorecard, mode: 'sim' };
    }

    const scorecard = await this.computeScorecard(campaignId, run);
    const updated = await pool.query(
      `UPDATE campaign_sim_runs
       SET status = 'completed', ended_at = NOW(), scorecard = $2::jsonb,
           overall_score = $3, grade = $4
       WHERE id = $1
       RETURNING *`,
      [run.id, JSON.stringify(scorecard), scorecard?.overall ?? null, scorecard?.grade || null]
    );
    const completed = updated.rows[0];

    try {
      const learnResult = await simLearningsService.processCompletedRun(campaignId, completed, scorecard);
      if (learnResult?.findings) {
        completed.findings = learnResult.findings;
      }
    } catch (err) {
      console.warn('Sim learnings processing failed:', err.message);
    }

    return completed;
  }

  async computeScorecard(campaignId, run = null) {
    const campaign = await this.getCampaign(campaignId);
    const objectives = run?.objectives_snapshot || {
      post_goal: parseInt(campaign?.post_goal, 10) || 5,
      comment_goal: parseInt(campaign?.comment_goal, 10) || 3,
      target_sentiment: Number(campaign?.target_sentiment) || 0.5,
      campaign_goal: campaign?.campaign_goal || '',
    };

    const since = run?.started_at || null;
    const runId = run?.id != null ? String(run.id) : null;
    const params = [campaignId];
    let timeClause = '';
    let commentTimeClause = '';

    if (runId && since) {
      params.push(runId, since);
      timeClause = `AND (
        (p.engagement_metrics->>'sim_run_id') = $2
        OR (p.metadata->>'sim_run_id') = $2
        OR (
          (p.engagement_metrics->>'sim_run_id') IS NULL
          AND (p.metadata->>'sim_run_id') IS NULL
          AND COALESCE(p.posted_at, p.created_at) >= $3
        )
      )`;
      commentTimeClause = `AND (
        (c.engagement_metrics->>'sim_run_id') = $2
        OR (
          (c.engagement_metrics->>'sim_run_id') IS NULL
          AND c.posted_at >= $3
        )
      )`;
    } else if (runId) {
      params.push(runId);
      timeClause = `AND (
        (p.engagement_metrics->>'sim_run_id') = $2
        OR (p.metadata->>'sim_run_id') = $2
      )`;
      commentTimeClause = `AND (c.engagement_metrics->>'sim_run_id') = $2`;
    } else if (since) {
      params.push(since);
      timeClause = `AND COALESCE(p.posted_at, p.created_at) >= $2`;
      commentTimeClause = `AND c.posted_at >= $2`;
    }

    const postsResult = await pool.query(
      `SELECT p.id, p.content, p.caption, p.subreddit, p.platform, p.engagement_metrics,
              p.status, p.metadata, p.social_account_id, p.posted_at
       FROM posts p
       WHERE p.campaign_id = $1
         AND p.status IN ('simulated', 'posted')
         ${timeClause}`,
      params
    );
    const posts = postsResult.rows;

    const commentsResult = await pool.query(
      `SELECT c.id, c.content, c.sentiment_score, c.engagement_metrics, c.status,
              c.social_account_id, c.posted_at, c.post_id
       FROM comments c
       JOIN posts p ON p.id = c.post_id
       WHERE p.campaign_id = $1
         AND c.status IN ('simulated', 'posted')
         ${commentTimeClause}`,
      params
    );
    const comments = commentsResult.rows;

    // Ensure posts query includes account + time for coordination
    // (already selected via p.* fields — re-fetch light fields if missing)
    const postsForRep = posts.map(p => ({
      ...p,
      social_account_id: p.social_account_id,
      posted_at: p.posted_at,
    }));

    const postGoal = Math.max(1, parseInt(objectives.post_goal, 10) || 5);
    const commentGoal = Math.max(1, parseInt(objectives.comment_goal, 10) || 3);
    const targetSentiment = Number(objectives.target_sentiment);
    const targetSentimentNum = Number.isFinite(targetSentiment) ? targetSentiment : 0.5;

    // Reach
    const reach = clamp((posts.length / postGoal) * 100);

    // Conversation
    const conversation = clamp((comments.length / commentGoal) * 100);

    // Sentiment
    const sentiments = comments
      .map(c => Number(c.sentiment_score))
      .filter(n => Number.isFinite(n));
    const meanSentiment = sentiments.length
      ? sentiments.reduce((a, b) => a + b, 0) / sentiments.length
      : 0;
    // Map mean (−1..1) distance from target (0..1 scale stored as 0.3/0.5/0.7) onto 0-100
    // target_sentiment in DB is 0-1-ish; convert target to −1..1: (t*2 - 1)
    const targetSigned = targetSentimentNum <= 1 ? targetSentimentNum * 2 - 1 : targetSentimentNum;
    const sentimentDelta = Math.abs(meanSentiment - targetSigned);
    const sentimentScore = clamp(100 - sentimentDelta * 80);

    // Reception mix
    const receptions = posts.map(p => p.engagement_metrics?.reception).filter(Boolean);
    const positive = receptions.filter(r => r === 'supportive' || r === 'curious').length;
    const negative = receptions.filter(r => r === 'skeptical' || r === 'hostile').length;
    const ignored = receptions.filter(r => r === 'ignored').length;
    const receptionScore = receptions.length
      ? clamp(((positive + 0.3 * ignored) / receptions.length) * 100 - (negative / receptions.length) * 40)
      : 40;

    // Risk from salesy / hostile
    const salesyAvg = posts.length
      ? posts.reduce((s, p) => s + (Number(p.engagement_metrics?.salesy_score) || 0), 0) / posts.length
      : 0;
    const hostileRate = receptions.length
      ? receptions.filter(r => r === 'hostile').length / receptions.length
      : 0;

    // Full reputation: AI detection + spam + coordination + comment reactions
    const reputation = computeCampaignReputation(postsForRep, comments, campaign);
    const riskScore = clamp(
      100 - salesyAvg * 40 - hostileRate * 30 - reputation.detection_risk * 0.45
    );
    const trustScore = reputation.community_trust;
    const stealthScore = clamp(100 - reputation.detection_risk);

    // Objective fit (LLM short rubric, with heuristic fallback)
    let objectiveFit = await this.scoreObjectiveFit(campaign, posts, comments, objectives);
    if (objectiveFit == null) {
      objectiveFit = clamp(45 + meanSentiment * 20 + (positive / Math.max(1, receptions.length)) * 30 - salesyAvg * 25);
    }

    const dimensions = {
      reach: Math.round(reach),
      conversation: Math.round(conversation),
      sentiment: Math.round(sentimentScore),
      reception: Math.round(receptionScore),
      objective_fit: Math.round(objectiveFit),
      risk: Math.round(riskScore),
      community_trust: Math.round(trustScore),
      stealth: Math.round(stealthScore),
    };

    const weights = {
      reach: 0.1,
      conversation: 0.1,
      sentiment: 0.12,
      reception: 0.15,
      objective_fit: 0.15,
      risk: 0.08,
      community_trust: 0.18,
      stealth: 0.12,
    };
    const overall = Math.round(
      Object.entries(weights).reduce((s, [k, w]) => s + dimensions[k] * w, 0)
    );

    const risks = [];
    if (salesyAvg > 0.35) risks.push('Messaging reads promotional for a cynical audience');
    if (hostileRate > 0.2) risks.push('High hostile reception rate — risk of bans/downvotes');
    if (posts.length < postGoal) risks.push(`Only ${posts.length}/${postGoal} posts vs post goal`);
    if (comments.length < commentGoal) risks.push(`Only ${comments.length}/${commentGoal} comments vs comment goal`);
    if (meanSentiment < targetSigned - 0.3) risks.push('Sentiment below target');
    for (const r of reputation.risks || []) risks.push(r);
    if (!risks.length) risks.push('No major red flags in this sim run');

    const commentReceptions = comments.map(c => c.engagement_metrics?.reception).filter(Boolean);

    return {
      mode: 'sim',
      overall,
      grade: letterGrade(overall),
      dimensions,
      reputation: {
        community_trust: reputation.community_trust,
        detection_risk: reputation.detection_risk,
        components: reputation.components,
        coordination: reputation.coordination,
      },
      stats: {
        posts: posts.length,
        comments: comments.length,
        mean_sentiment: Number(meanSentiment.toFixed(3)),
        target_sentiment_signed: Number(targetSigned.toFixed(3)),
        reception_mix: {
          supportive: receptions.filter(r => r === 'supportive').length,
          curious: receptions.filter(r => r === 'curious').length,
          skeptical: receptions.filter(r => r === 'skeptical').length,
          hostile: receptions.filter(r => r === 'hostile').length,
          ignored,
        },
        comment_reception_mix: {
          supportive: commentReceptions.filter(r => r === 'supportive').length,
          curious: commentReceptions.filter(r => r === 'curious').length,
          skeptical: commentReceptions.filter(r => r === 'skeptical').length,
          hostile: commentReceptions.filter(r => r === 'hostile').length,
          ignored: commentReceptions.filter(r => r === 'ignored').length,
        },
        avg_salesy_score: Number(salesyAvg.toFixed(3)),
        avg_ai_likeness: reputation.components.avg_ai_likeness,
        avg_spam_score: reputation.components.avg_spam_score,
        coordination_score: reputation.components.coordination_score,
      },
      objectives,
      risks,
      computed_at: new Date().toISOString(),
    };
  }

  async scoreObjectiveFit(campaign, posts, comments, objectives) {
    if (!posts.length) return 35;
    try {
      const samplePosts = posts.slice(0, 5).map(p => ({
        subreddit: p.subreddit,
        content: (p.content || '').slice(0, 400),
        reception: p.engagement_metrics?.reception,
      }));
      const completion = await openai.chat.completions.create(
        generationCompletionOptions({
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: 'Score campaign messaging fit. Reddit audiences are cynical. Return JSON {"score":0-100,"rationale":"..."}.',
            },
            {
              role: 'user',
              content: JSON.stringify({
                campaign_goal: objectives.campaign_goal || campaign?.campaign_goal,
                sample_posts: samplePosts,
                comment_count: comments.length,
              }),
            },
          ],
        })
      );
      const parsed = JSON.parse(completion.choices[0].message.content);
      if (typeof parsed.score === 'number') return clamp(parsed.score);
    } catch (err) {
      console.warn('Objective fit LLM skipped:', err.message);
    }
    return null;
  }

  async getScorecard(campaignId) {
    const latest = await this.getLatestRun(campaignId);
    // Always recompute so reputation / detection layers stay current
    const scorecard = await this.computeScorecard(
      campaignId,
      latest?.status === 'running' ? latest : (latest || null)
    );

    // Persist refreshed scorecard onto completed runs
    if (latest?.id && latest.status === 'completed') {
      await pool.query(
        `UPDATE campaign_sim_runs SET scorecard = $2::jsonb WHERE id = $1`,
        [latest.id, JSON.stringify(scorecard)]
      ).catch(() => {});
    }

    const campaign = await this.getCampaign(campaignId);
    const recentRuns = await simLearningsService.listRuns(campaignId);

    return {
      run: latest,
      scorecard,
      live_preview: latest?.status === 'running',
      mode: 'sim',
      active_learnings: campaign?.active_learnings || null,
      active_learnings_run_id: campaign?.active_learnings_run_id || null,
      recent_runs: recentRuns.slice(0, 8),
    };
  }

  async getCampaign(campaignId) {
    const result = await pool.query('SELECT * FROM campaigns WHERE id = $1', [campaignId]);
    return result.rows[0];
  }
}

module.exports = new CampaignScorecardService();
