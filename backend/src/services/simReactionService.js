const audiencePersonaService = require('./audiencePersonaService');
const {
  enrichPostReputation,
  simulateCommentReception,
} = require('./campaignReputationService');
const { PLATFORM_DEFAULTS } = audiencePersonaService;

const SALESY_PATTERNS = [
  /\b(check out|sign up|limited time|don't miss|game.?changer|revolutionary|innovative platform)\b/i,
  /\b(visit (our|my) (site|website)|click (here|the link)|link in (bio|comments))\b/i,
  /^(hey|hello|hi)\b.*[!]/i,
  /\b(excited to (share|announce)|thrilled to|proud to introduce)\b/i,
  /\b(waitlist is open|join (the|our) waitlist)\b/i,
];

const SUPPORTIVE_PATTERNS = [
  /\b(same here|this|exactly|been looking|curious|anyone else|worth a look|interesting)\b/i,
];

/**
 * Heuristic fit of content against an audience persona.
 * Returns { fit 0-1, salesyScore 0-1, tabooHits[], hookHits[], reasons[] }
 */
function scoreMessageFit(content, persona, campaign = {}) {
  const text = (content || '').toLowerCase();
  const p = persona?.persona || persona || {};
  const reasons = [];
  let fit = 0.55;
  let salesyScore = 0;

  for (const pat of SALESY_PATTERNS) {
    if (pat.test(content || '')) {
      salesyScore += 0.2;
      reasons.push(`salesy:${pat.source.slice(0, 24)}`);
    }
  }
  salesyScore = Math.min(1, salesyScore);

  const taboos = p.taboos || [];
  const tabooHits = taboos.filter(t => text.includes(String(t).toLowerCase()));
  if (tabooHits.length) {
    fit -= 0.12 * tabooHits.length;
    reasons.push(`taboo:${tabooHits.join(',')}`);
  }

  const hooks = p.hooks || [];
  const hookHits = hooks.filter(h => {
    const words = String(h).toLowerCase().split(/\s+/).filter(w => w.length > 3);
    return words.some(w => text.includes(w));
  });
  if (hookHits.length) {
    fit += 0.08 * Math.min(hookHits.length, 3);
    reasons.push(`hooks:${hookHits.length}`);
  }

  const fails = p.what_fails || [];
  for (const f of fails) {
    const key = String(f).toLowerCase().split(/\s+/).find(w => w.length > 4);
    if (key && text.includes(key)) {
      fit -= 0.08;
      reasons.push(`fails:${key}`);
    }
  }

  // Soft mention of target URL is ok; hard CTA is not
  if (campaign.target_url) {
    try {
      const host = new URL(campaign.target_url).hostname.replace(/^www\./, '');
      if (text.includes(host) && salesyScore < 0.3) {
        fit += 0.05;
        reasons.push('natural_url');
      } else if (text.includes(host) && salesyScore >= 0.3) {
        fit -= 0.1;
        reasons.push('promo_url');
      }
    } catch { /* ignore */ }
  }

  const skepticism = typeof p.skepticism === 'number' ? p.skepticism : 0.7;
  fit -= salesyScore * (0.35 + skepticism * 0.35);
  fit = Math.max(0, Math.min(1, fit));

  return { fit, salesyScore, tabooHits, hookHits, reasons, skepticism };
}

function pickReception(fit, salesyScore, skepticism) {
  // Reddit-heavy: most posts land skeptical/ignored unless fit is strong
  const roll = Math.random();
  const hostileThresh = 0.15 + salesyScore * 0.35 + skepticism * 0.1;
  const ignoredThresh = hostileThresh + 0.25 + (1 - fit) * 0.2;
  const skepticalThresh = ignoredThresh + 0.25;
  const curiousThresh = skepticalThresh + 0.2 * fit;

  if (salesyScore > 0.55 || (fit < 0.35 && roll < hostileThresh)) return 'hostile';
  if (roll < ignoredThresh || fit < 0.4) return 'ignored';
  if (roll < skepticalThresh) return 'skeptical';
  if (roll < curiousThresh) return 'curious';
  return 'supportive';
}

function receptionToMetrics(platform, reception, fit) {
  const jitter = () => 0.7 + Math.random() * 0.6;

  if (platform === 'reddit') {
    const tables = {
      supportive: { upvotes: [40, 220], downvotes: [0, 15], awards: [0, 2] },
      curious: { upvotes: [12, 80], downvotes: [1, 20], awards: [0, 1] },
      skeptical: { upvotes: [3, 35], downvotes: [5, 40], awards: [0, 0] },
      hostile: { upvotes: [0, 12], downvotes: [20, 120], awards: [0, 0] },
      ignored: { upvotes: [0, 8], downvotes: [0, 5], awards: [0, 0] },
    };
    const t = tables[reception] || tables.ignored;
    const up = Math.floor((t.upvotes[0] + Math.random() * (t.upvotes[1] - t.upvotes[0])) * jitter() * (0.6 + fit * 0.5));
    const down = Math.floor(t.downvotes[0] + Math.random() * (t.downvotes[1] - t.downvotes[0]));
    return {
      upvotes: up,
      downvotes: down,
      awards: Math.floor(t.awards[0] + Math.random() * (t.awards[1] - t.awards[0] + 0.01)),
      views: up * (8 + Math.floor(Math.random() * 20)),
      shares: Math.floor(up * 0.05),
      reception,
      fit: Number(fit.toFixed(3)),
    };
  }

  if (platform === 'x') {
    const mult = { supportive: 1, curious: 0.6, skeptical: 0.35, hostile: 0.2, ignored: 0.1 }[reception] || 0.2;
    const likes = Math.floor((5 + Math.random() * 200) * mult * jitter());
    return {
      likes,
      retweets: Math.floor(likes * 0.15),
      quotes: Math.floor(likes * 0.05),
      views: likes * 25,
      shares: Math.floor(likes * 0.1),
      reception,
      fit: Number(fit.toFixed(3)),
    };
  }

  // linkedin / default
  const mult = { supportive: 1, curious: 0.7, skeptical: 0.4, hostile: 0.15, ignored: 0.2 }[reception] || 0.3;
  const likes = Math.floor((8 + Math.random() * 150) * mult * jitter());
  return {
    likes,
    comments: Math.floor(likes * 0.08),
    impressions: likes * 40,
    views: likes * 30,
    shares: Math.floor(likes * 0.06),
    reception,
    fit: Number(fit.toFixed(3)),
  };
}

/**
 * Simulate community reception for a post.
 */
async function simulateReception(post, campaign, personaRow = null) {
  const platform = post.platform || 'reddit';
  let persona = personaRow;
  if (!persona && post.subreddit && campaign?.id) {
    persona = await audiencePersonaService.getForSubreddit(campaign.id, post.subreddit);
  }
  if (!persona && campaign?.id) {
    persona = await audiencePersonaService.getPersona(campaign.id, 'platform', platform);
  }

  const content = post.content || post.caption;
  const scored = scoreMessageFit(content, persona, campaign);
  let reception = pickReception(scored.fit, scored.salesyScore, scored.skepticism);
  let metrics = receptionToMetrics(platform, reception, scored.fit);

  const enriched = enrichPostReputation(content, campaign, {
    ...metrics,
    salesy_score: Number(scored.salesyScore.toFixed(3)),
    taboo_hits: scored.tabooHits,
    hook_hits: scored.hookHits,
    reasons: scored.reasons,
  });

  // Recompute vanity metrics if reception was downgraded by AI/spam detection
  if (enriched.reception !== reception) {
    metrics = receptionToMetrics(platform, enriched.reception, scored.fit);
  }

  return {
    ...metrics,
    ...enriched,
    reception: enriched.reception,
    salesy_score: enriched.salesy_score,
    taboo_hits: scored.tabooHits,
    hook_hits: scored.hookHits,
    reasons: enriched.reputation_reasons || scored.reasons,
    persona_id: persona?.id || null,
    sim: true,
  };
}

/**
 * Heuristic sentiment for a comment (−1..1). Cheap, no LLM required per comment.
 */
function scoreCommentSentiment(content, receptionHint = null) {
  const text = (content || '').toLowerCase();
  let score = 0;

  if (/\b(love|great|thanks|helpful|same|agree|exactly|awesome)\b/.test(text)) score += 0.35;
  if (/\b(curious|interesting|maybe|wonder|anyone)\b/.test(text)) score += 0.1;
  if (/\b(scam|spam|ad|shill|promo|astroturf|cringe|shut up)\b/.test(text)) score -= 0.45;
  if (/\b(doubt|skeptic|not sure|sounds like|marketing)\b/.test(text)) score -= 0.25;
  if (/\b(hate|trash|garbage|ban)\b/.test(text)) score -= 0.4;

  if (receptionHint === 'hostile') score -= 0.2;
  if (receptionHint === 'supportive') score += 0.15;
  if (receptionHint === 'skeptical') score -= 0.1;

  for (const pat of SUPPORTIVE_PATTERNS) {
    if (pat.test(text)) score += 0.1;
  }

  return Math.max(-1, Math.min(1, Number(score.toFixed(3))));
}

function pickCommenterArchetype(persona) {
  const archetypes = persona?.persona?.commenter_archetypes
    || PLATFORM_DEFAULTS?.reddit?.commenter_archetypes
    || [];
  if (!archetypes.length) return { name: 'skeptic', tone: 'doubtful' };
  const total = archetypes.reduce((s, a) => s + (a.weight || 0.2), 0);
  let roll = Math.random() * total;
  for (const a of archetypes) {
    roll -= a.weight || 0.2;
    if (roll <= 0) return a;
  }
  return archetypes[0];
}

module.exports = {
  scoreMessageFit,
  simulateReception,
  scoreCommentSentiment,
  pickCommenterArchetype,
  pickReception,
  simulateCommentReception,
};
