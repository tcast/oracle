const pool = require('./db');
const openai = require('./openai');
const { generationCompletionOptions } = require('../config/openaiModels');

const PLATFORM_DEFAULTS = {
  reddit: {
    tone: 'cynical, skeptical, anti-promo',
    skepticism: 0.85,
    taboos: ['overt ads', 'corporate enthusiasm', 'hey fellow kids', 'link dumps'],
    hooks: ['personal experience', 'specific question', 'contrarian take', 'shared frustration'],
    jargon: [],
    what_works: ['show dont sell', 'admit uncertainty', 'ask genuine questions'],
    what_fails: ['marketing voice', 'exclamation-heavy openers', 'brand CTAs'],
    commenter_archetypes: [
      { name: 'skeptic', weight: 0.35, tone: 'doubtful' },
      { name: 'curious', weight: 0.25, tone: 'interested but cautious' },
      { name: 'hostile', weight: 0.15, tone: 'calls out promo' },
      { name: 'supportive', weight: 0.15, tone: 'shares similar experience' },
      { name: 'lurker', weight: 0.1, tone: 'one-liner' },
    ],
  },
  x: {
    tone: 'punchy, opinionated, fast',
    skepticism: 0.55,
    taboos: ['long essays', 'corporate jargon'],
    hooks: ['hot take', 'thread opener', 'relatable gripe'],
    jargon: [],
    what_works: ['brevity', 'sharp opinion', 'wit'],
    what_fails: ['soft marketing', 'hashtag spam'],
    commenter_archetypes: [
      { name: 'agree', weight: 0.3, tone: 'quick affirmation' },
      { name: 'ratio', weight: 0.25, tone: 'pushback' },
      { name: 'curious', weight: 0.25, tone: 'asks for link/detail' },
      { name: 'joke', weight: 0.2, tone: 'meme reply' },
    ],
  },
  linkedin: {
    tone: 'professional, polished, career-aware',
    skepticism: 0.4,
    taboos: ['memes', 'hostility', 'slang-heavy posts'],
    hooks: ['lesson learned', 'industry insight', 'career story'],
    jargon: [],
    what_works: ['credibility', 'value-first', 'modest CTA'],
    what_fails: ['bro-marketing', 'engagement bait'],
    commenter_archetypes: [
      { name: 'supportive', weight: 0.4, tone: 'congratulatory' },
      { name: 'curious', weight: 0.3, tone: 'asks clarifying question' },
      { name: 'networker', weight: 0.2, tone: 'adds perspective' },
      { name: 'skeptic', weight: 0.1, tone: 'polite doubt' },
    ],
  },
};

function normalizePersona(raw, fallback = PLATFORM_DEFAULTS.reddit) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return {
    tone: p.tone || fallback.tone,
    skepticism: typeof p.skepticism === 'number' ? p.skepticism : fallback.skepticism,
    taboos: Array.isArray(p.taboos) ? p.taboos : fallback.taboos,
    hooks: Array.isArray(p.hooks) ? p.hooks : fallback.hooks,
    jargon: Array.isArray(p.jargon) ? p.jargon : [],
    what_works: Array.isArray(p.what_works) ? p.what_works : fallback.what_works,
    what_fails: Array.isArray(p.what_fails) ? p.what_fails : fallback.what_fails,
    commenter_archetypes: Array.isArray(p.commenter_archetypes) && p.commenter_archetypes.length
      ? p.commenter_archetypes
      : fallback.commenter_archetypes,
    summary: p.summary || `Audience is ${p.tone || fallback.tone}`,
  };
}

class AudiencePersonaService {
  async list(campaignId) {
    const result = await pool.query(
      `SELECT * FROM audience_personas
       WHERE campaign_id = $1
       ORDER BY scope_type, scope_key`,
      [campaignId]
    );
    return result.rows.map(row => ({
      ...row,
      persona: normalizePersona(row.persona, PLATFORM_DEFAULTS[row.scope_key] || PLATFORM_DEFAULTS.reddit),
    }));
  }

  async getPersona(campaignId, scopeType, scopeKey) {
    const result = await pool.query(
      `SELECT * FROM audience_personas
       WHERE campaign_id = $1 AND scope_type = $2 AND lower(scope_key) = lower($3)`,
      [campaignId, scopeType, scopeKey]
    );
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    return {
      ...row,
      persona: normalizePersona(
        row.persona,
        PLATFORM_DEFAULTS[scopeType === 'platform' ? scopeKey : 'reddit'] || PLATFORM_DEFAULTS.reddit
      ),
    };
  }

  async getForSubreddit(campaignId, subredditName) {
    return this.getPersona(campaignId, 'subreddit', subredditName);
  }

  async upsert(campaignId, scopeType, scopeKey, persona, source = 'ai') {
    const normalized = normalizePersona(
      persona,
      PLATFORM_DEFAULTS[scopeType === 'platform' ? scopeKey : 'reddit'] || PLATFORM_DEFAULTS.reddit
    );
    const result = await pool.query(
      `INSERT INTO audience_personas (campaign_id, scope_type, scope_key, persona, source, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
       ON CONFLICT (campaign_id, scope_type, scope_key)
       DO UPDATE SET persona = EXCLUDED.persona, source = EXCLUDED.source, updated_at = NOW()
       RETURNING *`,
      [campaignId, scopeType, scopeKey, JSON.stringify(normalized), source]
    );
    return { ...result.rows[0], persona: normalized };
  }

  async generateForSubreddit(campaignId, suggestion) {
    const campaign = await this.getCampaign(campaignId);
    if (!campaign) throw new Error('Campaign not found');

    const name = suggestion.subreddit_name || suggestion;
    const guidelines = Array.isArray(suggestion.content_guidelines)
      ? suggestion.content_guidelines
      : (suggestion.content_guidelines
        ? (typeof suggestion.content_guidelines === 'string'
          ? JSON.parse(suggestion.content_guidelines)
          : suggestion.content_guidelines)
        : []);

    const prompt = `You model Reddit audiences. r/${name} users are typically cynical and anti-promo.

Campaign overview: ${campaign.campaign_overview || 'n/a'}
Campaign goal: ${campaign.campaign_goal || 'n/a'}
Why this sub was suggested: ${suggestion.reason || 'n/a'}
Existing culture notes: ${guidelines.length ? guidelines.join('; ') : 'none'}

Return ONLY valid JSON with this shape:
{
  "summary": "1 sentence audience snapshot",
  "tone": "short tone description",
  "skepticism": 0.0-1.0,
  "taboos": ["things that get downvoted or removed"],
  "hooks": ["angles that earn engagement"],
  "jargon": ["community terms"],
  "what_works": ["content patterns that work"],
  "what_fails": ["content patterns that fail"],
  "commenter_archetypes": [
    {"name":"skeptic","weight":0.35,"tone":"..."},
    {"name":"curious","weight":0.25,"tone":"..."},
    {"name":"hostile","weight":0.15,"tone":"..."},
    {"name":"supportive","weight":0.15,"tone":"..."},
    {"name":"lurker","weight":0.1,"tone":"..."}
  ]
}

Weights must sum to ~1. Bias toward skepticism for Reddit.`;

    let persona;
    try {
      const completion = await openai.chat.completions.create(
        generationCompletionOptions({
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'You are an expert Reddit community analyst. Output JSON only.' },
            { role: 'user', content: prompt },
          ],
        })
      );
      persona = JSON.parse(completion.choices[0].message.content);
    } catch (err) {
      console.warn('Persona AI generation failed, using Reddit defaults:', err.message);
      persona = {
        ...PLATFORM_DEFAULTS.reddit,
        summary: `r/${name} leans skeptical and anti-promo`,
        jargon: [],
      };
    }

    return this.upsert(campaignId, 'subreddit', name, persona, 'ai');
  }

  async generateForPlatform(campaignId, platform) {
    const base = PLATFORM_DEFAULTS[platform] || PLATFORM_DEFAULTS.reddit;
    const campaign = await this.getCampaign(campaignId);
    const prompt = `Create a short audience persona for ${platform} for this campaign.

Goal: ${campaign?.campaign_goal || 'n/a'}
Overview: ${campaign?.campaign_overview || 'n/a'}

Return ONLY JSON with: summary, tone, skepticism (0-1), taboos[], hooks[], jargon[], what_works[], what_fails[], commenter_archetypes[{name,weight,tone}].`;

    let persona = { ...base, summary: `${platform} audience for this campaign` };
    try {
      const completion = await openai.chat.completions.create(
        generationCompletionOptions({
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'Output JSON only for social audience personas.' },
            { role: 'user', content: prompt },
          ],
        })
      );
      persona = JSON.parse(completion.choices[0].message.content);
    } catch (err) {
      console.warn('Platform persona generation failed:', err.message);
    }
    return this.upsert(campaignId, 'platform', platform, persona, 'ai');
  }

  async generateForApprovedSubreddits(campaignId) {
    const approved = await pool.query(
      `SELECT * FROM subreddit_suggestions
       WHERE campaign_id = $1 AND status = 'approved'`,
      [campaignId]
    );
    const results = [];
    for (const sub of approved.rows) {
      results.push(await this.generateForSubreddit(campaignId, sub));
    }
    return results;
  }

  async ensureForSubreddit(campaignId, suggestion) {
    const existing = await this.getForSubreddit(campaignId, suggestion.subreddit_name);
    if (existing) return existing;
    return this.generateForSubreddit(campaignId, suggestion);
  }

  formatForPrompt(personaRow) {
    if (!personaRow?.persona) return '';
    const p = personaRow.persona;
    return `
Audience persona for this community:
- Snapshot: ${p.summary || p.tone}
- Tone: ${p.tone}
- Skepticism (0-1): ${p.skepticism}
- Hooks that work: ${(p.hooks || []).join('; ')}
- Taboos (avoid): ${(p.taboos || []).join('; ')}
- Jargon: ${(p.jargon || []).join(', ') || 'n/a'}
- What works: ${(p.what_works || []).join('; ')}
- What fails: ${(p.what_fails || []).join('; ')}

Write to earn trust from THIS audience. Never sound like marketing.`;
  }

  async getCampaign(campaignId) {
    const result = await pool.query('SELECT * FROM campaigns WHERE id = $1', [campaignId]);
    return result.rows[0];
  }
}

const service = new AudiencePersonaService();
service.PLATFORM_DEFAULTS = PLATFORM_DEFAULTS;
service.normalizePersona = normalizePersona;
module.exports = service;
