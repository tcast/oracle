/**
 * Campaign reputation layer: how the audience would perceive Whisper's
 * posts + comments as a whole — including AI-likeness and spam/coordination.
 */

const AI_TELLS = [
  /\bas an ai\b/i,
  /\bin conclusion\b/i,
  /\bit'?s important to note\b/i,
  /\bin today'?s (digital|fast-paced)\b/i,
  /\bleverage\b/i,
  /\bdelve\b/i,
  /\brobust\b/i,
  /\bseamless(ly)?\b/i,
  /\bgame[- ]changer\b/i,
  /\brevolutionary\b/i,
  /\binnovative (platform|solution|approach)\b/i,
  /\bexcited to share\b/i,
  /\bwithout further ado\b/i,
  /\btapestry\b/i,
  /\bnavigate the (complex|ever)/i,
];

const SPAM_TELLS = [
  /\b(sign up|join (the|our) waitlist|limited time|click (here|the link))\b/i,
  /\b(check out|visit) (my|our|this)\b/i,
  /\b(dm me|link in (bio|comments))\b/i,
  /\bpromo code\b/i,
  /https?:\/\/\S+/gi,
];

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3);
}

function jaccard(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  return inter / (A.size + B.size - inter);
}

function avgSentenceLength(text) {
  const sentences = String(text || '').split(/[.!?]+/).filter(s => s.trim().length > 0);
  if (!sentences.length) return 0;
  const words = sentences.map(s => s.trim().split(/\s+/).length);
  return words.reduce((a, b) => a + b, 0) / words.length;
}

/**
 * AI-likeness 0..1 (higher = more detectable as AI / corporate voice)
 */
function scoreAiLikeness(content) {
  const text = content || '';
  const reasons = [];
  let score = 0.15;

  let tellHits = 0;
  for (const pat of AI_TELLS) {
    if (pat.test(text)) {
      tellHits += 1;
      reasons.push(`ai_tell:${pat.source.slice(0, 28)}`);
    }
  }
  score += Math.min(0.45, tellHits * 0.12);

  // Uniform medium-long sentences are an AI tell on Reddit
  const avgLen = avgSentenceLength(text);
  if (avgLen >= 18 && avgLen <= 32) {
    score += 0.12;
    reasons.push('uniform_sentence_length');
  }

  // Low slang / high formality proxy: few contractions + few short fragments
  const contractions = (text.match(/\b(i'?m|don'?t|can'?t|won'?t|it'?s|that'?s|gonna|wanna)\b/gi) || []).length;
  const words = tokenize(text).length;
  if (words > 40 && contractions === 0) {
    score += 0.1;
    reasons.push('no_contractions');
  }

  // Perfect punctuation / no typos vibe: many commas + balanced length
  const commas = (text.match(/,/g) || []).length;
  if (words > 50 && commas >= 4 && tellHits > 0) {
    score += 0.08;
    reasons.push('polished_corporate');
  }

  // Em-dash / semicolon density (common in LLM prose)
  const fancyPunct = (text.match(/[;—–]/g) || []).length;
  if (fancyPunct >= 2) {
    score += 0.08;
    reasons.push('fancy_punctuation');
  }

  return {
    ai_likeness: Number(Math.max(0, Math.min(1, score)).toFixed(3)),
    reasons,
  };
}

/**
 * Per-item spamminess 0..1
 */
function scoreSpamSignals(content, campaign = {}) {
  const text = content || '';
  const reasons = [];
  let score = 0.05;

  for (const pat of SPAM_TELLS) {
    if (pat.test(text)) {
      score += 0.14;
      reasons.push(`spam:${String(pat.source).slice(0, 24)}`);
    }
    // Reset lastIndex for global patterns
    if (pat.global) pat.lastIndex = 0;
  }

  if (campaign.target_url) {
    try {
      const host = new URL(campaign.target_url).hostname.replace(/^www\./, '');
      const mentions = (text.toLowerCase().match(new RegExp(host.replace(/\./g, '\\.'), 'g')) || []).length;
      if (mentions >= 2) {
        score += 0.2;
        reasons.push('repeated_url');
      } else if (mentions === 1 && /sign up|waitlist|check out/i.test(text)) {
        score += 0.15;
        reasons.push('cta_with_url');
      }
    } catch { /* ignore */ }
  }

  return {
    spam_score: Number(Math.max(0, Math.min(1, score)).toFixed(3)),
    reasons,
  };
}

/**
 * Audience reaction to a *comment* (how natives would read a bot reply).
 */
function simulateCommentReception(content, postReception = null, persona = null) {
  const skepticism = persona?.persona?.skepticism ?? persona?.skepticism ?? 0.75;
  const ai = scoreAiLikeness(content);
  const spam = scoreSpamSignals(content);
  let fit = 0.55 - ai.ai_likeness * 0.35 - spam.spam_score * 0.4;

  // Pile-on on a hostile post looks worse
  if (postReception === 'hostile') fit -= 0.15;
  if (postReception === 'skeptical') fit -= 0.08;
  if (postReception === 'supportive') fit += 0.08;

  // Short natural replies fare better
  const words = tokenize(content).length;
  if (words > 0 && words <= 25) fit += 0.08;
  if (words > 80) fit -= 0.12;

  fit = Math.max(0, Math.min(1, fit));

  let reception = 'ignored';
  const roll = Math.random();
  if (spam.spam_score > 0.45 || ai.ai_likeness > 0.65) {
    reception = roll < 0.55 ? 'hostile' : 'skeptical';
  } else if (fit < 0.35) {
    reception = roll < 0.5 ? 'ignored' : 'skeptical';
  } else if (fit < 0.55) {
    reception = roll < 0.45 ? 'skeptical' : 'curious';
  } else if (fit < 0.75) {
    reception = roll < 0.4 ? 'curious' : 'supportive';
  } else {
    reception = roll < 0.65 ? 'supportive' : 'curious';
  }

  // Skeptical communities push down
  if (skepticism > 0.8 && reception === 'supportive' && Math.random() < 0.4) {
    reception = 'curious';
  }

  return {
    reception,
    fit: Number(fit.toFixed(3)),
    ai_likeness: ai.ai_likeness,
    spam_score: spam.spam_score,
    reasons: [...ai.reasons, ...spam.reasons],
    sim: true,
  };
}

/**
 * Enrich a post reception payload with AI/spam scores.
 */
function enrichPostReputation(content, campaign, baseReception = {}) {
  const ai = scoreAiLikeness(content);
  const spam = scoreSpamSignals(content, campaign);

  // Detection risk for this single item
  const detection = Math.min(
    1,
    ai.ai_likeness * 0.55 + spam.spam_score * 0.45 + (baseReception.salesy_score || 0) * 0.25
  );

  // Downgrade reception if AI/spam is high
  let reception = baseReception.reception;
  if (detection > 0.7 && (reception === 'supportive' || reception === 'curious')) {
    reception = Math.random() < 0.5 ? 'skeptical' : 'hostile';
  } else if (detection > 0.55 && reception === 'supportive') {
    reception = 'curious';
  }

  return {
    ...baseReception,
    reception,
    ai_likeness: ai.ai_likeness,
    spam_score: spam.spam_score,
    detection_risk: Number(detection.toFixed(3)),
    reputation_reasons: [...(baseReception.reasons || []), ...ai.reasons, ...spam.reasons],
  };
}

/**
 * Corpus-level coordination / campaign smell across all Whisper content.
 */
function scoreCoordination(posts = [], comments = [], campaign = {}) {
  const items = [
    ...posts.map(p => ({
      type: 'post',
      content: p.content || p.caption || '',
      account: p.social_account_id,
      subreddit: p.subreddit,
      at: p.posted_at,
    })),
    ...comments.map(c => ({
      type: 'comment',
      content: c.content || '',
      account: c.social_account_id,
      at: c.posted_at,
    })),
  ].filter(i => i.content);

  const reasons = [];
  if (items.length < 2) {
    return {
      coordination_score: 0,
      voice_similarity: 0,
      url_density: 0,
      burstiness: 0,
      reasons: ['insufficient_volume'],
    };
  }

  // Pairwise content similarity (sample)
  let simSum = 0;
  let pairs = 0;
  const sample = items.slice(0, 25);
  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 1; j < sample.length; j++) {
      simSum += jaccard(sample[i].content, sample[j].content);
      pairs += 1;
    }
  }
  const voiceSimilarity = pairs ? simSum / pairs : 0;
  if (voiceSimilarity > 0.22) reasons.push('high_cross_content_similarity');

  // Same talking-point / URL density
  let urlHits = 0;
  let host = null;
  try {
    if (campaign.target_url) host = new URL(campaign.target_url).hostname.replace(/^www\./, '');
  } catch { /* ignore */ }
  for (const item of items) {
    if (/https?:\/\//i.test(item.content)) urlHits += 1;
    if (host && item.content.toLowerCase().includes(host)) urlHits += 0.5;
  }
  const urlDensity = urlHits / items.length;
  if (urlDensity > 0.35) reasons.push('high_url_density');

  // Burstiness: many items in short window
  const times = items
    .map(i => (i.at ? new Date(i.at).getTime() : null))
    .filter(Boolean)
    .sort((a, b) => a - b);
  let burstiness = 0;
  if (times.length >= 3) {
    const spanMin = (times[times.length - 1] - times[0]) / 60000;
    const rate = times.length / Math.max(1, spanMin);
    // >1 item per 2 minutes is bursty for organic Reddit
    burstiness = Math.min(1, rate / 0.5);
    if (burstiness > 0.5) reasons.push('bursty_posting');
  }

  // Few accounts producing lots of content
  const accounts = new Set(items.map(i => i.account).filter(Boolean));
  const accountConcentration = accounts.size
    ? Math.min(1, items.length / (accounts.size * 4))
    : 0.5;
  if (accountConcentration > 0.6) reasons.push('few_accounts_many_actions');

  const coordination = Math.min(
    1,
    voiceSimilarity * 1.2 + urlDensity * 0.7 + burstiness * 0.5 + accountConcentration * 0.35
  );

  return {
    coordination_score: Number(coordination.toFixed(3)),
    voice_similarity: Number(voiceSimilarity.toFixed(3)),
    url_density: Number(urlDensity.toFixed(3)),
    burstiness: Number(burstiness.toFixed(3)),
    account_concentration: Number(accountConcentration.toFixed(3)),
    reasons,
  };
}

/**
 * Full campaign reputation rollup.
 * Returns trust 0-100 (higher better) and detection_risk 0-100 (higher worse),
 * plus component averages.
 */
function computeCampaignReputation(posts = [], comments = [], campaign = {}) {
  const postAi = posts.map(p => Number(p.engagement_metrics?.ai_likeness) || scoreAiLikeness(p.content || '').ai_likeness);
  const postSpam = posts.map(p => Number(p.engagement_metrics?.spam_score) || scoreSpamSignals(p.content || '', campaign).spam_score);
  const commentAi = comments.map(c => Number(c.engagement_metrics?.ai_likeness) || scoreAiLikeness(c.content || '').ai_likeness);
  const commentSpam = comments.map(c => Number(c.engagement_metrics?.spam_score) || scoreSpamSignals(c.content || '', campaign).spam_score);

  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

  const avgAi = avg([...postAi, ...commentAi]);
  const avgSpam = avg([...postSpam, ...commentSpam]);
  const coordination = scoreCoordination(posts, comments, campaign);

  const commentReceptions = comments.map(c => c.engagement_metrics?.reception).filter(Boolean);
  const postReceptions = posts.map(p => p.engagement_metrics?.reception).filter(Boolean);
  const allReceptions = [...postReceptions, ...commentReceptions];
  const hostileRate = allReceptions.length
    ? allReceptions.filter(r => r === 'hostile' || r === 'skeptical').length / allReceptions.length
    : 0;
  const positiveRate = allReceptions.length
    ? allReceptions.filter(r => r === 'supportive' || r === 'curious').length / allReceptions.length
    : 0;

  // Detection risk 0-100 (higher = more likely called out as bots/spam/AI)
  const detectionRisk = Math.round(Math.min(100, (
    avgAi * 40
    + avgSpam * 30
    + coordination.coordination_score * 35
    + hostileRate * 20
  ) * 100 / 100));

  // Community trust 0-100 (higher = audience buys it as organic)
  const communityTrust = Math.round(Math.max(0, Math.min(100,
    100
    - detectionRisk * 0.55
    - avgAi * 25
    - avgSpam * 20
    - coordination.coordination_score * 25
    + positiveRate * 25
  )));

  const risks = [];
  if (avgAi > 0.45) risks.push('Content reads AI-generated across accounts');
  if (avgSpam > 0.35) risks.push('Spam/CTA patterns detectable');
  if (coordination.coordination_score > 0.4) risks.push('Coordination smell — similar voice, URLs, or burst timing');
  if (hostileRate > 0.35) risks.push('Audience reacting skeptically/hostile to Whisper activity');
  if (commentReceptions.length && commentReceptions.filter(r => r === 'hostile').length / commentReceptions.length > 0.25) {
    risks.push('Bot comments themselves are drawing heat');
  }

  return {
    community_trust: communityTrust,
    detection_risk: detectionRisk,
    components: {
      avg_ai_likeness: Number(avgAi.toFixed(3)),
      avg_spam_score: Number(avgSpam.toFixed(3)),
      coordination_score: coordination.coordination_score,
      voice_similarity: coordination.voice_similarity,
      url_density: coordination.url_density,
      burstiness: coordination.burstiness,
      hostile_rate: Number(hostileRate.toFixed(3)),
      positive_rate: Number(positiveRate.toFixed(3)),
      post_reception_n: postReceptions.length,
      comment_reception_n: commentReceptions.length,
    },
    coordination,
    risks,
  };
}

module.exports = {
  scoreAiLikeness,
  scoreSpamSignals,
  simulateCommentReception,
  enrichPostReputation,
  scoreCoordination,
  computeCampaignReputation,
};
