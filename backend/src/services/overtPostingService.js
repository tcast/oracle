const axios = require('axios');
const pool = require('./db');
const openai = require('./openai');
const { GENERATION_MODEL } = require('../config/openaiModels');
const { buildBrandPrompt } = require('./brandStyleGuide');
const brandChannelService = require('./brandChannelService');

async function getCampaignWithBrand(campaignId) {
  const { rows } = await pool.query(
    `SELECT c.*, b.name AS brand_name, b.slug AS brand_slug, b.website AS brand_website,
            b.brand_voice, b.id AS brand_table_id
     FROM campaigns c
     LEFT JOIN brands b ON b.id = c.brand_id
     WHERE c.id = $1`,
    [campaignId]
  );
  return rows[0] || null;
}

async function generateOvertContent(campaign, brand, platform) {
  const prompt = buildBrandPrompt({
    brand: {
      name: brand.brand_name || brand.name,
      brand_voice: brand.brand_voice,
      website: brand.brand_website || brand.website,
    },
    campaign,
    platform,
    mediaAssets: campaign.media_assets,
  });

  const completion = await openai.chat.completions.create({
    model: GENERATION_MODEL,
    messages: [
      { role: 'system', content: 'You are a brand social media copywriter. Respond with valid JSON only.' },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_object' },
  });

  const raw = completion.choices[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { content: raw, caption: raw };
  }
  return {
    content: parsed.content || parsed.text || '',
    caption: parsed.caption || parsed.content || '',
  };
}

async function publishLinkedIn(channel, content) {
  const authorUrn =
    channel.channel_type === 'organization'
      ? `urn:li:organization:${channel.external_id}`
      : `urn:li:person:${channel.external_id}`;

  const body = {
    author: authorUrn,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text: content },
        shareMediaCategory: 'NONE',
      },
    },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
  };

  const res = await axios.post('https://api.linkedin.com/v2/ugcPosts', body, {
    headers: {
      Authorization: `Bearer ${channel.access_token}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
    },
  });
  return { platform_post_id: res.headers['x-restli-id'] || res.data?.id || null };
}

async function publishX(channel, content) {
  const res = await axios.post(
    'https://api.twitter.com/2/tweets',
    { text: content.slice(0, 280) },
    { headers: { Authorization: `Bearer ${channel.access_token}`, 'Content-Type': 'application/json' } }
  );
  return { platform_post_id: res.data?.data?.id || null };
}

async function publishFacebook(channel, content) {
  const res = await axios.post(
    `https://graph.facebook.com/v19.0/${channel.external_id}/feed`,
    null,
    { params: { message: content, access_token: channel.access_token } }
  );
  return { platform_post_id: res.data?.id || null };
}

async function publishInstagram(channel, content, imageUrl) {
  if (!imageUrl) {
    throw new Error('Instagram publishing requires an image URL in campaign media_assets');
  }
  const container = await axios.post(
    `https://graph.facebook.com/v19.0/${channel.external_id}/media`,
    null,
    {
      params: {
        image_url: imageUrl,
        caption: content,
        access_token: channel.access_token,
      },
    }
  );
  const creationId = container.data.id;
  const publish = await axios.post(
    `https://graph.facebook.com/v19.0/${channel.external_id}/media_publish`,
    null,
    { params: { creation_id: creationId, access_token: channel.access_token } }
  );
  return { platform_post_id: publish.data?.id || creationId };
}

function firstImageUrl(mediaAssets) {
  if (!Array.isArray(mediaAssets)) return null;
  for (const asset of mediaAssets) {
    const url = typeof asset === 'string' ? asset : asset?.url || asset?.src;
    if (url && /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(url)) return url;
    if (url && asset?.type?.startsWith?.('image')) return url;
  }
  return mediaAssets[0]?.url || null;
}

async function publishToChannel(channel, { content, caption }, campaign) {
  let fresh = await brandChannelService.ensureFreshToken(channel);
  const text = caption || content;

  if (fresh.platform === 'linkedin') return publishLinkedIn(fresh, text);
  if (fresh.platform === 'x') return publishX(fresh, text);
  if (fresh.platform === 'facebook') return publishFacebook(fresh, text);
  if (fresh.platform === 'instagram') {
    return publishInstagram(fresh, text, firstImageUrl(campaign.media_assets));
  }
  throw new Error(`Unsupported overt platform: ${fresh.platform}`);
}

async function createOvertDraft(campaignId, platform, channelId = null) {
  const campaign = await getCampaignWithBrand(campaignId);
  if (!campaign) throw new Error('Campaign not found');
  const isBrand = campaign.campaign_type === 'brand' || !!campaign.overt_enabled;
  if (!isBrand) throw new Error('Overt posting is only available on brand campaigns');
  if (!campaign.brand_id) throw new Error('Campaign has no brand');

  let channel = null;
  if (channelId) {
    channel = await brandChannelService.getChannel(channelId);
  } else {
    const channels = await brandChannelService.channelsForBrandPlatforms(campaign.brand_id, [platform]);
    channel = channels[0] || null;
  }
  if (!channel) throw new Error(`No connected ${platform} channel for this brand`);

  const generated = await generateOvertContent(campaign, campaign, platform);

  const { rows } = await pool.query(
    `INSERT INTO posts
       (campaign_id, brand_channel_id, posting_track, platform, content, caption, status, metadata)
     VALUES ($1, $2, 'overt', $3, $4, $5, 'draft', $6::jsonb)
     RETURNING *`,
    [
      campaignId,
      channel.id,
      platform,
      generated.content,
      generated.caption,
      JSON.stringify({ brand_id: campaign.brand_id, channel_display_name: channel.display_name }),
    ]
  );
  return rows[0];
}

async function publishOvertPost(postId, { live = true } = {}) {
  const { rows } = await pool.query(
    `SELECT p.*, c.media_assets, c.brand_id, c.target_url
     FROM posts p
     JOIN campaigns c ON c.id = p.campaign_id
     WHERE p.id = $1 AND p.posting_track = 'overt'`,
    [postId]
  );
  const post = rows[0];
  if (!post) throw new Error('Overt post not found');
  if (!post.brand_channel_id) throw new Error('Post has no brand channel');

  const channel = await brandChannelService.getChannel(post.brand_channel_id);
  if (!channel) throw new Error('Brand channel not found');

  if (!live) {
    const { rows: updated } = await pool.query(
      `UPDATE posts SET status = 'simulated', posted_at = NOW(),
         platform_post_id = $1, metadata = COALESCE(metadata,'{}'::jsonb) || $2::jsonb
       WHERE id = $3 RETURNING *`,
      [
        `sim_overt_${Date.now()}`,
        JSON.stringify({ simulated_overt: true }),
        postId,
      ]
    );
    return updated[0];
  }

  const result = await publishToChannel(
    channel,
    { content: post.content, caption: post.caption },
    post
  );

  const { rows: updated } = await pool.query(
    `UPDATE posts SET status = 'posted', posted_at = NOW(), platform_post_id = $1
     WHERE id = $2 RETURNING *`,
    [result.platform_post_id, postId]
  );
  return updated[0];
}

async function createAndMaybePublish(campaignId, { live = false } = {}) {
  const campaign = await getCampaignWithBrand(campaignId);
  if (!campaign?.overt_enabled && campaign?.campaign_type !== 'brand') return null;

  const platforms =
    campaign.overt_platforms?.length > 0
      ? campaign.overt_platforms
      : ['linkedin', 'x', 'facebook', 'instagram'];

  const channels = await brandChannelService.channelsForBrandPlatforms(
    campaign.brand_id,
    platforms
  );
  if (!channels.length) {
    console.log(`Overt post skipped for campaign ${campaignId}: no connected channels`);
    return null;
  }

  // Avoid flooding drafts in sim; live respects interval via task queue
  if (!live) {
    const { rows: recent } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM posts
       WHERE campaign_id = $1 AND posting_track = 'overt'
         AND created_at > NOW() - INTERVAL '1 hour'`,
      [campaignId]
    );
    if ((recent[0]?.n || 0) >= 3) {
      console.log(`Overt sim draft skipped for campaign ${campaignId}: recent drafts exist`);
      return null;
    }
  }

  const channel = channels[Math.floor(Math.random() * channels.length)];
  const draft = await createOvertDraft(campaignId, channel.platform, channel.id);

  if (live) {
    await pool.query(`UPDATE posts SET status = 'approved' WHERE id = $1`, [draft.id]);
    return publishOvertPost(draft.id, { live: true });
  }

  return draft;
}

async function listOvertPosts(campaignId) {
  const { rows } = await pool.query(
    `SELECT p.*, bc.display_name AS channel_name, bc.platform AS channel_platform
     FROM posts p
     LEFT JOIN brand_channels bc ON bc.id = p.brand_channel_id
     WHERE p.campaign_id = $1 AND p.posting_track = 'overt'
     ORDER BY p.created_at DESC`,
    [campaignId]
  );
  return rows;
}

module.exports = {
  generateOvertContent,
  createOvertDraft,
  publishOvertPost,
  createAndMaybePublish,
  listOvertPosts,
  getCampaignWithBrand,
};
