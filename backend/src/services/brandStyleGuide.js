/**
 * Brand voice prompt guide for overt / traditional marketing posts.
 * Opposite of redditStyleGuide — CTAs and brand identity are encouraged.
 */

function buildBrandPrompt({ brand, campaign, platform, mediaAssets }) {
  const voice = brand.brand_voice || `Speak as the official ${brand.name} brand account.`;
  const goal = campaign.campaign_goal || campaign.campaign_overview || '';
  const overview = campaign.campaign_overview || '';
  const targetUrl = campaign.target_url || brand.website || '';

  const platformRules = {
    linkedin: `LinkedIn company post. Professional, insight-led, 2-4 short paragraphs. Soft CTA. No hashtag spam (0-3 relevant tags).`,
    x: `X/Twitter post. Punchy, under 260 chars preferred. One clear CTA or link. Max 2 hashtags.`,
    facebook: `Facebook Page post. Conversational brand voice, 1-3 paragraphs. Clear CTA. Can include a link.`,
    instagram: `Instagram caption. Visual-first brand storytelling, emoji sparingly, 3-8 hashtags at end. CTA in caption.`,
  };

  return `You write OVERT brand marketing content for ${brand.name}.

BRAND VOICE:
${voice}

CAMPAIGN OVERVIEW:
${overview}

CAMPAIGN GOAL:
${goal}

TARGET URL (include when natural): ${targetUrl || 'none'}

PLATFORM: ${platform}
${platformRules[platform] || 'Write a clear branded social post with a CTA.'}

${mediaAssets?.length ? `Media assets available: ${JSON.stringify(mediaAssets).slice(0, 500)}` : ''}

RULES:
- You ARE the brand. Be proud, clear, and useful.
- Include a call-to-action when it fits the goal.
- Do not pretend to be a random user or hide the brand.
- No engagement-bait questions without substance.
- Return JSON only: {"content":"...","caption":"..."}
  For X/LinkedIn/Facebook use content. For Instagram put caption in caption and content can match.`;
}

module.exports = { buildBrandPrompt };
