const BAD_OPENING_PATTERNS = [
  /^hey[,!\s]/i,
  /^hello[,!\s]/i,
  /^hi[,!\s]+(?:everyone|all|folks|guys|friends|fellow)/i,
  /^what'?s up[,!\s]/i,
  /^greetings[,!\s]/i,
  /^dear\s+/i,
  /^fellow\s+/i,
  /^attention\s+/i,
  /^i'?m excited to (?:share|announce|introduce)/i,
  /^i'?m thrilled/i,
  /^i'?m happy to (?:share|announce)/i,
  /^allow me to introduce/i,
  /^have you heard about/i,
  /^introducing\s+/i,
];

const EXAMPLES = `
GOOD Reddit posts (sound like real users):
- "Anyone else feel like daily fantasy is basically renting players for a night? Found something that actually lets you keep guys on your roster and I'm kinda hooked."
- "Been burned by salary cap chalk one too many times. Started looking at platforms where depth actually matters — role players, breakouts, all of it. Worth a look if you're tired of the same 5 stars every slate."
- "Not sure if this is allowed here but has anyone tried roster-based fantasy where you own the cards/players? Saw JockBroker mentioned in another thread and the waitlist is open."
- "Hot take: most DFS content ignores the 80% of the league that's actually playable. That's why I've been paying more attention to stuff with real scarcity built in."
- "TL;DR at bottom. I've been playing fantasy for years and always hated losing my lineup every week. Found a waitlist for something that keeps your players — link in comments if mods ok."

BAD Reddit posts (marketing voice — NEVER write like this):
- "Hey, fantasy baseball aficionados! I'm excited to share..."
- "Hello fellow sports fans! Allow me to introduce an innovative platform..."
- "Greetings r/fantasyfootball! Are you tired of disposable lineups? Look no further!"
- "I'm thrilled to announce JockBroker, a revolutionary new way to..."
- "Attention DFS players! You won't want to miss this amazing opportunity..."
`;

function getRedditSystemPrompt() {
  return `You are a regular Reddit user writing a self-post or discussion post. You are NOT a marketer, brand ambassador, or copywriter.

How real Reddit posts work:
- Start mid-thought: a question, observation, frustration, discovery, or specific situation
- Write like you're typing to strangers who share your hobby — casual, direct, sometimes blunt
- Use "I" naturally when sharing experience; don't perform enthusiasm
- One idea per paragraph; short blocks of text
- Questions should feel genuine, not rhetorical engagement bait
- If mentioning a product/site, frame it as something you found, tried, or are curious about — never as a pitch
- No exclamation marks in the opening sentence
- No addressing the subreddit by name ("hey r/...")
- No sign-offs, no "thanks for reading", no corporate CTAs
- Links only if natural: "waitlist is at jockbroker.com" not "Visit our website today!"

Structure options (pick what fits):
1. Question-first: lead with a specific question from your situation
2. Experience-first: "I've been doing X for Y years and recently..."
3. Discovery: "Saw this mentioned in another thread / stumbled on..."
4. Discussion: "Curious what you all think about..."
5. TL;DR style: short summary upfront, details below

${EXAMPLES}

Output ONLY the post body text. No title line unless it's a natural first sentence that's part of the post. No quotes around the post. No meta commentary.`;
}

function buildRedditUserPrompt(campaign, context, account) {
  const sub = context.subreddit?.subreddit_name || context.subreddit || 'unknown';
  const subName = typeof sub === 'object' ? sub.subreddit_name : sub;
  const rules = context.subreddit?.content_rules || context.content_rules;
  const rulesBlock = rules?.length
    ? `\nSubreddit culture notes:\n${rules.map(r => `- ${r}`).join('\n')}`
    : '';

  const targetUrl = campaign.target_url ? `\nSite to mention naturally (if relevant): ${campaign.target_url}` : '';
  const audienceBlock = context.audiencePersonaPrompt || '';

  return `Write a post for r/${subName}.

Background (do NOT copy this verbatim — internalize it and write like a user who cares about this):
${campaign.campaign_overview}

What you're trying to get across (subtle, not salesy):
${campaign.campaign_goal}
${targetUrl}
${rulesBlock}
${audienceBlock}

Voice: ${account?.persona_traits?.tone || 'casual'} Reddit user, ${account?.persona_traits?.writingStyle || 'direct'} style.

Before you write, pick ONE authentic angle from the audience hooks (question, personal experience, discovery, or debate) — not a product announcement. Avoid every taboo listed.

Write the post now.`;
}

function sanitizeRedditPost(content) {
  if (!content) return content;

  let text = content.trim();

  // Strip wrapping quotes if model added them
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }

  // Remove common label prefixes
  text = text.replace(/^(?:Title|Post|Body):\s*/im, '');

  const sentences = text.split(/(?<=[.!?])\s+/);
  if (sentences.length > 1 && BAD_OPENING_PATTERNS.some(p => p.test(sentences[0]))) {
    text = sentences.slice(1).join(' ').trim();
  } else if (BAD_OPENING_PATTERNS.some(p => p.test(text.split('\n')[0]))) {
    text = text.split('\n').slice(1).join('\n').trim();
  }

  return text;
}

/** Derive a Reddit title + body from a single content blob (no title column in DB). */
function splitRedditTitleBody(content) {
  const text = sanitizeRedditPost(content) || 'Thoughts?';
  const firstSentence = (text.split(/(?<=[.!?])\s+/)[0] || text).replace(/\n/g, ' ').trim();
  let title = firstSentence;
  if (title.length > 300) title = `${title.slice(0, 297)}...`;
  if (title.length < 3) {
    title = text.replace(/\n/g, ' ').trim().slice(0, 80) || 'Discussion';
  }
  return { title, body: text };
}

function buildRedditPostUrl(post) {
  if (!post) return null;
  if (post.platform_post_url) return post.platform_post_url;
  const id = post.platform_post_id;
  if (!id) return null;
  if (String(id).startsWith('http')) return id;
  const sub = post.subreddit || 'all';
  return `https://www.reddit.com/r/${sub}/comments/${id}/`;
}

module.exports = {
  getRedditSystemPrompt,
  buildRedditUserPrompt,
  sanitizeRedditPost,
  splitRedditTitleBody,
  buildRedditPostUrl,
};
