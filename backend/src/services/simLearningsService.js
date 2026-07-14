const pool = require('./db');
const openai = require('./openai');
const { generationCompletionOptions } = require('../config/openaiModels');

function asArray(v) {
  if (Array.isArray(v)) return v.filter(Boolean).map(String).slice(0, 8);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

function normalizeFindings(raw, runId, scorecard) {
  const overall = scorecard?.overall ?? raw?.overall ?? null;
  const grade = scorecard?.grade || raw?.grade || null;
  return {
    summary: String(raw?.summary || 'No clear findings from this run.').slice(0, 600),
    do_more: asArray(raw?.do_more),
    avoid: asArray(raw?.avoid),
    comment_style: asArray(raw?.comment_style),
    post_angles: asArray(raw?.post_angles),
    detection_fixes: asArray(raw?.detection_fixes),
    subreddit_notes:
      raw?.subreddit_notes && typeof raw.subreddit_notes === 'object' && !Array.isArray(raw.subreddit_notes)
        ? raw.subreddit_notes
        : {},
    source_run_id: runId || raw?.source_run_id || null,
    overall,
    grade,
  };
}

function heuristicFindings(scorecard, samples) {
  const risks = scorecard?.risks || [];
  const dims = scorecard?.dimensions || {};
  const do_more = [];
  const avoid = [];
  const comment_style = [];
  const post_angles = [];
  const detection_fixes = [];

  if ((dims.reception || 0) < 55) {
    avoid.push('Promotional openers and brand-forward CTAs');
    do_more.push('Lead with a specific personal observation or question');
  }
  if ((dims.stealth || 0) < 55 || (scorecard?.reputation?.detection_risk || 0) > 50) {
    detection_fixes.push('Vary sentence rhythm; cut polished marketing phrasing');
    detection_fixes.push('Reduce repeated URL/CTA patterns across posts');
  }
  if ((dims.conversation || 0) < 50) {
    comment_style.push('Ask one concrete follow-up question tied to the post');
    comment_style.push('Keep comments under 3 short sentences');
  }
  if ((dims.community_trust || 0) < 55) {
    avoid.push('Coordinated-sounding praise or identical talking points');
    do_more.push('Admit uncertainty; cite a concrete detail from the thread');
  }
  for (const r of risks.slice(0, 4)) {
    if (/promo|sales|marketing/i.test(r)) avoid.push(r);
    else if (/detect|AI|spam|coord/i.test(r)) detection_fixes.push(r);
    else do_more.push(`Address: ${r}`);
  }

  const supportive = (samples.posts || []).filter(p => p.reception === 'supportive' || p.reception === 'curious');
  if (supportive.length) {
    post_angles.push('Reuse angles that got supportive/curious reception');
  }

  return normalizeFindings(
    {
      summary: `Run scored ${scorecard?.grade || '?'} (${scorecard?.overall ?? '—'}). Focus on reception, stealth, and conversation.`,
      do_more: do_more.length ? do_more : ['Stay specific and human; avoid generic hype'],
      avoid: avoid.length ? avoid : ['Corporate enthusiasm and link dumps'],
      comment_style: comment_style.length ? comment_style : ['Sound like a real community member'],
      post_angles,
      detection_fixes,
    },
    null,
    scorecard
  );
}

class SimLearningsService {
  formatForPrompt(learnings, { emphasizeComments = false } = {}) {
    if (!learnings || typeof learnings !== 'object') return '';
    const lines = [];
    if (learnings.summary) lines.push(`Summary: ${learnings.summary}`);
    if (learnings.do_more?.length) lines.push(`Do more: ${learnings.do_more.join('; ')}`);
    if (learnings.avoid?.length) lines.push(`Avoid: ${learnings.avoid.join('; ')}`);
    if (learnings.post_angles?.length && !emphasizeComments) {
      lines.push(`Post angles: ${learnings.post_angles.join('; ')}`);
    }
    if (learnings.comment_style?.length) {
      lines.push(`Comment style: ${learnings.comment_style.join('; ')}`);
    }
    if (learnings.detection_fixes?.length) {
      lines.push(`Anti-detection: ${learnings.detection_fixes.join('; ')}`);
    }
    const notes = learnings.subreddit_notes || {};
    const noteKeys = Object.keys(notes).slice(0, 5);
    if (noteKeys.length) {
      lines.push(`Subreddit notes: ${noteKeys.map(k => `${k}: ${notes[k]}`).join(' | ')}`);
    }
    if (!lines.length) return '';
    return `\n\nFindings from previous simulations (apply these):\n${lines.join('\n')}`;
  }

  async applyToCampaign(campaignId, findings, runId) {
    const payload = { ...findings, source_run_id: runId || findings.source_run_id };
    await pool.query(
      `UPDATE campaigns
       SET active_learnings = $2::jsonb,
           active_learnings_run_id = $3,
           updated_at = NOW()
       WHERE id = $1`,
      [campaignId, JSON.stringify(payload), runId || null]
    );
    return payload;
  }

  async collectSamples(campaignId, run) {
    const params = [campaignId];
    let timeClause = '';
    if (run?.started_at) {
      params.push(run.started_at);
      timeClause = 'AND COALESCE(p.posted_at, p.created_at) >= $2';
    }

    const postsResult = await pool.query(
      `SELECT p.id, p.subreddit, p.content, p.engagement_metrics
       FROM posts p
       WHERE p.campaign_id = $1
         AND p.status IN ('simulated', 'posted')
         ${timeClause}
       ORDER BY COALESCE(p.posted_at, p.created_at) DESC
       LIMIT 12`,
      params
    );

    const commentsResult = await pool.query(
      `SELECT c.content, c.engagement_metrics, p.subreddit
       FROM comments c
       JOIN posts p ON p.id = c.post_id
       WHERE p.campaign_id = $1
         AND c.status IN ('simulated', 'posted')
         ${timeClause.replace(/p\.posted_at/g, 'c.posted_at').replace(/p\.created_at/g, 'c.posted_at')}
       ORDER BY c.posted_at DESC
       LIMIT 12`,
      params
    );

    return {
      posts: postsResult.rows.map(p => ({
        subreddit: p.subreddit,
        content: (p.content || '').slice(0, 350),
        reception: p.engagement_metrics?.reception,
        ai_likeness: p.engagement_metrics?.ai_likeness,
        spam_score: p.engagement_metrics?.spam_score,
      })),
      comments: commentsResult.rows.map(c => ({
        subreddit: c.subreddit,
        content: (c.content || '').slice(0, 220),
        reception: c.engagement_metrics?.reception,
      })),
    };
  }

  async extractFindings(campaignId, run, scorecard) {
    const samples = await this.collectSamples(campaignId, run);
    const campaign = await pool.query('SELECT campaign_goal, campaign_overview FROM campaigns WHERE id = $1', [
      campaignId,
    ]);
    const camp = campaign.rows[0] || {};

    try {
      const completion = await openai.chat.completions.create(
        generationCompletionOptions({
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'You analyze Reddit campaign simulation scorecards. Return JSON only with keys: summary, do_more[], avoid[], comment_style[], post_angles[], detection_fixes[], subreddit_notes{}. Be concrete and actionable for rewriting posts/comments. No fluff.',
            },
            {
              role: 'user',
              content: JSON.stringify({
                campaign_goal: camp.campaign_goal,
                campaign_overview: camp.campaign_overview,
                scorecard: {
                  overall: scorecard?.overall,
                  grade: scorecard?.grade,
                  dimensions: scorecard?.dimensions,
                  risks: scorecard?.risks,
                  reputation: scorecard?.reputation,
                  stats: scorecard?.stats,
                },
                sample_posts: samples.posts,
                sample_comments: samples.comments,
              }),
            },
          ],
        })
      );
      const parsed = JSON.parse(completion.choices[0].message.content);
      return normalizeFindings(parsed, run?.id, scorecard);
    } catch (err) {
      console.warn('Learnings LLM extract failed, using heuristics:', err.message);
      return normalizeFindings(heuristicFindings(scorecard, samples), run?.id, scorecard);
    }
  }

  async rewriteDraftsFromFindings(campaignId, findings) {
    // Lazy require to avoid circular dependency with postingService
    const postingService = require('./postingService');
    const drafts = await pool.query(
      `SELECT * FROM posts
       WHERE campaign_id = $1 AND status IN ('draft', 'approved')
       ORDER BY id ASC`,
      [campaignId]
    );

    if (!drafts.rows.length) {
      return { rewritten: 0 };
    }

    const campaignResult = await pool.query('SELECT * FROM campaigns WHERE id = $1', [campaignId]);
    const campaign = campaignResult.rows[0];
    if (!campaign) return { rewritten: 0 };

    // Ensure generateContent sees learnings even if DB write races
    campaign.active_learnings = findings;

    let rewritten = 0;
    for (const draft of drafts.rows) {
      try {
        const platform = draft.platform || 'reddit';
        const context = {
          platform,
          campaignId,
          active_learnings: findings,
          subreddit: draft.subreddit
            ? {
                subreddit_name: draft.subreddit,
                content_rules: draft.metadata?.subreddit_rules || [],
              }
            : undefined,
        };
        const content = await postingService.generateContent('post', campaign, context);
        const meta = {
          ...(draft.metadata || {}),
          learnings_run_id: findings.source_run_id || null,
          rewritten_from_learnings: true,
          rewritten_at: new Date().toISOString(),
        };
        await pool.query(
          `UPDATE posts
           SET content = $2,
               caption = $2,
               metadata = $3::jsonb
           WHERE id = $1`,
          [draft.id, content, JSON.stringify(meta)]
        );
        rewritten += 1;
      } catch (err) {
        console.warn(`Draft rewrite failed for post ${draft.id}:`, err.message);
      }
    }

    return { rewritten };
  }

  async processCompletedRun(campaignId, run, scorecard) {
    if (!run?.id) return null;

    const findings = await this.extractFindings(campaignId, run, scorecard);
    await pool.query(
      `UPDATE campaign_sim_runs
       SET findings = $2::jsonb,
           overall_score = $3,
           grade = $4
       WHERE id = $1`,
      [run.id, JSON.stringify(findings), scorecard?.overall ?? null, scorecard?.grade || null]
    );

    await this.applyToCampaign(campaignId, findings, run.id);

    let rewriteResult = { rewritten: 0 };
    try {
      rewriteResult = await this.rewriteDraftsFromFindings(campaignId, findings);
      await pool.query(
        `UPDATE campaign_sim_runs SET drafts_rewritten_at = NOW() WHERE id = $1`,
        [run.id]
      );
    } catch (err) {
      console.warn('Draft rewrite after sim failed:', err.message);
    }

    return { findings, rewriteResult };
  }

  async listRuns(campaignId) {
    const result = await pool.query(
      `SELECT id, campaign_id, started_at, ended_at, status, overall_score, grade,
              findings, scorecard, drafts_rewritten_at, created_at
       FROM campaign_sim_runs
       WHERE campaign_id = $1
       ORDER BY started_at DESC
       LIMIT 50`,
      [campaignId]
    );
    return result.rows.map(r => ({
      id: r.id,
      campaign_id: r.campaign_id,
      started_at: r.started_at,
      ended_at: r.ended_at,
      status: r.status,
      overall_score: r.overall_score != null ? Number(r.overall_score) : r.scorecard?.overall ?? null,
      grade: r.grade || r.scorecard?.grade || null,
      summary: r.findings?.summary || null,
      findings: r.findings,
      drafts_rewritten_at: r.drafts_rewritten_at,
      created_at: r.created_at,
    }));
  }

  async getRun(campaignId, runId) {
    const result = await pool.query(
      `SELECT * FROM campaign_sim_runs WHERE id = $1 AND campaign_id = $2`,
      [runId, campaignId]
    );
    return result.rows[0] || null;
  }
}

module.exports = new SimLearningsService();
