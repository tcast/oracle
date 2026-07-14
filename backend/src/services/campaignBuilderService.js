const axios = require('axios');
const openai = require('./openai');
const { generationCompletionOptions } = require('../config/openaiModels');

const URL_REGEX = /https?:\/\/[^\s<>"']+|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?:\/[^\s<>"']*)?/g;

function extractUrls(text) {
  const matches = text.match(URL_REGEX) || [];
  return [...new Set(matches.map(u => (u.startsWith('http') ? u : `https://${u}`)))];
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractMeta(html, baseUrl) {
  const get = (pattern) => {
    const m = html.match(pattern);
    return m ? m[1].trim() : null;
  };

  const resolve = (url) => {
    if (!url) return null;
    try {
      return new URL(url, baseUrl).href;
    } catch {
      return url;
    }
  };

  const title =
    get(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    get(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i) ||
    get(/<title[^>]*>([^<]+)<\/title>/i);

  const description =
    get(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
    get(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i) ||
    get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);

  const ogImage =
    get(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    get(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);

  const assets = [];
  if (ogImage) assets.push({ type: 'image', url: resolve(ogImage), label: 'og:image' });

  const favicon =
    get(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']+)["']/i) ||
    get(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'](?:shortcut )?icon["']/i);
  if (favicon) assets.push({ type: 'image', url: resolve(favicon), label: 'favicon' });

  return { title, description, assets };
}

async function fetchWebsite(url) {
  try {
    const response = await axios.get(url, {
      timeout: 15000,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WhisperCampaignBot/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
      validateStatus: (s) => s < 400,
    });

    const html = response.data;
    if (typeof html !== 'string') {
      return { url, error: 'Non-HTML response', title: url, snippet: '', assets: [] };
    }

    const meta = extractMeta(html, url);
    const text = stripHtml(html).slice(0, 8000);

    return {
      url,
      title: meta.title || url,
      description: meta.description || '',
      snippet: text.slice(0, 3000),
      assets: meta.assets,
    };
  } catch (err) {
    return {
      url,
      error: err.message,
      title: url,
      snippet: '',
      assets: [],
    };
  }
}

async function researchUrls(urls) {
  const unique = [...new Set(urls)].slice(0, 5);
  return Promise.all(unique.map(fetchWebsite));
}

function parseJsonBlock(content) {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function chat(messages) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured. Add it to your .env file.');
  }

  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const urls = extractUrls(lastUser?.content || '');
  const allText = messages.map(m => m.content).join('\n');
  const inferredUrls = extractUrls(allText);
  const toResearch = [...new Set([...urls, ...inferredUrls])];

  let research = [];
  if (toResearch.length > 0) {
    research = await researchUrls(toResearch);
  }

  const researchContext = research.length
    ? research
        .map(r => {
          const parts = [`URL: ${r.url}`, `Title: ${r.title}`];
          if (r.description) parts.push(`Description: ${r.description}`);
          if (r.snippet) parts.push(`Page content:\n${r.snippet}`);
          if (r.error) parts.push(`Fetch note: ${r.error}`);
          return parts.join('\n');
        })
        .join('\n\n---\n\n')
    : 'No websites researched yet.';

  const systemPrompt = `You are Whisper's AI Campaign Builder. You help users create social media campaigns by doing real research and filling in details they don't provide.

Your job:
1. Understand what the user wants (platform, goal, audience, tone)
2. Use the RESEARCH DATA from websites you've fetched to understand the product/brand
3. Ask only the questions you truly need — if research answers it, don't ask again
4. When you have enough info, produce a complete campaign draft

Always respond with valid JSON in this exact shape:
{
  "message": "Your conversational reply to the user (markdown ok)",
  "status": "gathering" | "ready",
  "campaignDraft": null | {
    "name": "Campaign name",
    "campaign_overview": "2-4 paragraph overview of the campaign strategy",
    "campaign_goal": "Specific measurable goal",
    "post_goal": 10,
    "comment_goal": 5,
    "target_sentiment": "positive",
    "platform": ["reddit"],
    "target_url": "https://...",
    "media_assets": [{"type": "image", "url": "...", "label": "..."}],
    "suggested_subreddits": ["subreddit1", "subreddit2"],
    "content_themes": ["theme1", "theme2"],
    "sample_posts": ["Example post 1", "Example post 2"]
  }
}

Rules:
- Default platform to ["reddit"] if user mentions Reddit or doesn't specify
- Pull product facts, value props, and CTAs from research — don't invent features
- Include discovered image URLs in media_assets when relevant
- Set status to "ready" only when campaignDraft is complete and user would approve it
- If user gives a detailed brief + you have research, lean toward "ready" with a strong draft they can edit
- Be concise in message but thorough in campaignDraft`;

  const completion = await openai.chat.completions.create(
    generationCompletionOptions({
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `RESEARCH DATA:\n${researchContext}\n\nCONVERSATION:\n${messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n')}`,
        },
      ],
      response_format: { type: 'json_object' },
    })
  );

  const raw = completion.choices?.[0]?.message?.content;
  const parsed = parseJsonBlock(raw) || {
    message: raw || 'I had trouble processing that. Could you try again?',
    status: 'gathering',
    campaignDraft: null,
  };

  // Merge discovered assets into draft if AI missed them
  if (parsed.campaignDraft && research.length) {
    const discoveredAssets = research.flatMap(r => r.assets || []);
    const existing = parsed.campaignDraft.media_assets || [];
    const seen = new Set(existing.map(a => a.url));
    for (const asset of discoveredAssets) {
      if (asset.url && !seen.has(asset.url)) {
        existing.push(asset);
        seen.add(asset.url);
      }
    }
    parsed.campaignDraft.media_assets = existing;

    if (!parsed.campaignDraft.target_url && research[0]?.url) {
      parsed.campaignDraft.target_url = research[0].url;
    }
  }

  return {
    reply: parsed.message,
    status: parsed.status || 'gathering',
    campaignDraft: parsed.campaignDraft || null,
    research,
  };
}

module.exports = { chat, extractUrls, fetchWebsite, researchUrls };
