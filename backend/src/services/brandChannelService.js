const crypto = require('crypto');
const axios = require('axios');
const pool = require('./db');
const brandOAuthAppService = require('./brandOAuthAppService');

const OAUTH_STATES = new Map(); // state -> { brandId, platform, userId, codeVerifier?, expiresAt }

const PLATFORM_SCOPES = {
  linkedin: 'openid profile w_member_social w_organization_social r_organization_social rw_organization_admin',
  x: 'tweet.read tweet.write users.read offline.access',
  facebook: 'pages_show_list pages_manage_posts pages_read_engagement business_management',
  instagram: 'instagram_basic instagram_content_publish pages_show_list business_management',
  google_ads: 'https://www.googleapis.com/auth/adwords',
  meta_ads: 'ads_management ads_read business_management',
};

function baseUrl() {
  return process.env.APP_BASE_URL || process.env.BACKEND_URL || 'http://localhost:3021';
}

function frontendUrl() {
  return process.env.FRONTEND_URL || 'http://localhost:3020';
}

function storeState(payload) {
  const state = crypto.randomBytes(24).toString('hex');
  OAUTH_STATES.set(state, { ...payload, expiresAt: Date.now() + 15 * 60 * 1000 });
  return state;
}

function consumeState(state) {
  const data = OAUTH_STATES.get(state);
  OAUTH_STATES.delete(state);
  if (!data || data.expiresAt < Date.now()) return null;
  return data;
}

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function listChannels(brandId) {
  const { rows } = await pool.query(
    `SELECT id, brand_id, platform, channel_type, external_id, display_name, scopes, meta, status,
            token_expires_at, created_at, updated_at,
            (access_token IS NOT NULL) AS connected
     FROM brand_channels WHERE brand_id = $1 ORDER BY platform, display_name`,
    [brandId]
  );
  return rows;
}

async function disconnectChannel(brandId, channelId) {
  const { rows } = await pool.query(
    `DELETE FROM brand_channels WHERE id = $1 AND brand_id = $2 RETURNING id`,
    [channelId, brandId]
  );
  return rows[0] || null;
}

async function getAuthUrl(brandId, platform, userId) {
  const creds = await brandOAuthAppService.resolveCredentials(brandId, platform);
  const state = storeState({ brandId, platform, userId });
  const redirectUri = `${baseUrl()}/api/oauth/${platform}/callback`;

  if (platform === 'linkedin') {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: creds.clientId,
      redirect_uri: redirectUri,
      state,
      scope: PLATFORM_SCOPES.linkedin,
    });
    return `https://www.linkedin.com/oauth/v2/authorization?${params}`;
  }

  if (platform === 'x') {
    const { verifier, challenge } = pkcePair();
    consumeState(state);
    const state2 = storeState({ brandId, platform, userId, codeVerifier: verifier });
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: creds.clientId,
      redirect_uri: redirectUri,
      scope: PLATFORM_SCOPES.x,
      state: state2,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return `https://twitter.com/i/oauth2/authorize?${params}`;
  }

  if (platform === 'facebook' || platform === 'instagram') {
    const scope = platform === 'instagram' ? PLATFORM_SCOPES.instagram : PLATFORM_SCOPES.facebook;
    const params = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: redirectUri,
      state,
      scope,
      response_type: 'code',
    });
    return `https://www.facebook.com/v19.0/dialog/oauth?${params}`;
  }

  throw new Error(`Unsupported platform: ${platform}`);
}

async function upsertChannel(brandId, data) {
  const {
    platform,
    channel_type,
    external_id,
    display_name,
    access_token,
    refresh_token,
    token_expires_at,
    scopes,
    meta,
  } = data;

  const { rows } = await pool.query(
    `INSERT INTO brand_channels
       (brand_id, platform, channel_type, external_id, display_name, access_token, refresh_token,
        token_expires_at, scopes, meta, status, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'active',NOW())
     ON CONFLICT (brand_id, platform, external_id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       access_token = EXCLUDED.access_token,
       refresh_token = COALESCE(EXCLUDED.refresh_token, brand_channels.refresh_token),
       token_expires_at = EXCLUDED.token_expires_at,
       scopes = EXCLUDED.scopes,
       meta = EXCLUDED.meta,
       status = 'active',
       updated_at = NOW()
     RETURNING *`,
    [
      brandId,
      platform,
      channel_type || 'page',
      external_id,
      display_name,
      access_token,
      refresh_token || null,
      token_expires_at || null,
      scopes || null,
      JSON.stringify(meta || {}),
    ]
  );
  return rows[0];
}

async function handleCallback(platform, { code, state }) {
  const ctx = consumeState(state);
  if (!ctx || ctx.platform !== platform) {
    throw new Error('Invalid or expired OAuth state');
  }

  const creds = await brandOAuthAppService.resolveCredentials(ctx.brandId, platform);
  const redirectUri = `${baseUrl()}/api/oauth/${platform}/callback`;

  if (platform === 'linkedin') {
    const tokenRes = await axios.post(
      'https://www.linkedin.com/oauth/v2/accessToken',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const accessToken = tokenRes.data.access_token;
    const expiresIn = tokenRes.data.expires_in || 3600;

    let orgs = [];
    try {
      const orgRes = await axios.get(
        'https://api.linkedin.com/v2/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&projection=(elements*(organization~(id,localizedName)))',
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      orgs = (orgRes.data.elements || []).map((el) => ({
        id: String(el['organization~']?.id || el.organization?.split(':').pop()),
        name: el['organization~']?.localizedName || 'LinkedIn Organization',
      }));
    } catch (err) {
      console.warn('LinkedIn org fetch failed, storing user token:', err.message);
    }

    if (!orgs.length) {
      const me = await axios.get('https://api.linkedin.com/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      }).catch(() => ({ data: { sub: 'me', name: 'LinkedIn User' } }));
      orgs = [{ id: me.data.sub || 'me', name: me.data.name || 'LinkedIn Profile' }];
    }

    for (const org of orgs) {
      await upsertChannel(ctx.brandId, {
        platform: 'linkedin',
        channel_type: org.id === 'me' || String(org.id).length > 20 ? 'profile' : 'organization',
        external_id: org.id,
        display_name: org.name,
        access_token: accessToken,
        refresh_token: tokenRes.data.refresh_token || null,
        token_expires_at: new Date(Date.now() + expiresIn * 1000),
        scopes: PLATFORM_SCOPES.linkedin,
        meta: { raw: org },
      });
    }
  } else if (platform === 'x') {
    const tokenRes = await axios.post(
      'https://api.twitter.com/2/oauth2/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: ctx.codeVerifier,
        client_id: creds.clientId,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret || ''}`).toString('base64')}`,
        },
      }
    );
    const accessToken = tokenRes.data.access_token;
    const me = await axios.get('https://api.twitter.com/2/users/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    await upsertChannel(ctx.brandId, {
      platform: 'x',
      channel_type: 'profile',
      external_id: me.data.data.id,
      display_name: `@${me.data.data.username}`,
      access_token: accessToken,
      refresh_token: tokenRes.data.refresh_token || null,
      token_expires_at: new Date(Date.now() + (tokenRes.data.expires_in || 7200) * 1000),
      scopes: PLATFORM_SCOPES.x,
      meta: me.data.data,
    });
  } else if (platform === 'facebook' || platform === 'instagram') {
    const tokenRes = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
      params: {
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        redirect_uri: redirectUri,
        code,
      },
    });
    let accessToken = tokenRes.data.access_token;

    try {
      const longRes = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
        params: {
          grant_type: 'fb_exchange_token',
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          fb_exchange_token: accessToken,
        },
      });
      accessToken = longRes.data.access_token || accessToken;
    } catch (_) { /* keep short token */ }

    const pagesRes = await axios.get('https://graph.facebook.com/v19.0/me/accounts', {
      params: { access_token: accessToken, fields: 'id,name,access_token,instagram_business_account' },
    });
    const pages = pagesRes.data.data || [];

    for (const page of pages) {
      if (platform === 'facebook') {
        await upsertChannel(ctx.brandId, {
          platform: 'facebook',
          channel_type: 'page',
          external_id: page.id,
          display_name: page.name,
          access_token: page.access_token || accessToken,
          token_expires_at: null,
          scopes: PLATFORM_SCOPES.facebook,
          meta: { page_id: page.id },
        });
      }
      if (platform === 'instagram' && page.instagram_business_account) {
        const igId = page.instagram_business_account.id;
        let igName = page.name;
        try {
          const ig = await axios.get(`https://graph.facebook.com/v19.0/${igId}`, {
            params: { fields: 'username,name', access_token: page.access_token || accessToken },
          });
          igName = ig.data.username ? `@${ig.data.username}` : ig.data.name || igName;
        } catch (_) { /* ignore */ }
        await upsertChannel(ctx.brandId, {
          platform: 'instagram',
          channel_type: 'page',
          external_id: igId,
          display_name: igName,
          access_token: page.access_token || accessToken,
          token_expires_at: null,
          scopes: PLATFORM_SCOPES.instagram,
          meta: { page_id: page.id, ig_id: igId },
        });
      }
    }

    if (!pages.length) {
      throw new Error('No Facebook Pages found for this account. Connect a Page first in Meta Business Suite.');
    }
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  return {
    brandId: ctx.brandId,
    platform,
    redirect: `${frontendUrl()}/brands/${ctx.brandId}?connected=${platform}`,
  };
}

async function getChannel(channelId) {
  const { rows } = await pool.query(`SELECT * FROM brand_channels WHERE id = $1`, [channelId]);
  return rows[0] || null;
}

async function refreshChannelToken(channel) {
  if (!channel.refresh_token) return channel;
  const creds = await brandOAuthAppService.resolveCredentials(channel.brand_id, channel.platform);

  if (channel.platform === 'x') {
    const tokenRes = await axios.post(
      'https://api.twitter.com/2/oauth2/token',
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: channel.refresh_token,
        client_id: creds.clientId,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret || ''}`).toString('base64')}`,
        },
      }
    );
    const { rows } = await pool.query(
      `UPDATE brand_channels SET access_token = $1, refresh_token = COALESCE($2, refresh_token),
         token_expires_at = $3, updated_at = NOW() WHERE id = $4 RETURNING *`,
      [
        tokenRes.data.access_token,
        tokenRes.data.refresh_token || null,
        new Date(Date.now() + (tokenRes.data.expires_in || 7200) * 1000),
        channel.id,
      ]
    );
    return rows[0];
  }

  if (channel.platform === 'linkedin' && channel.refresh_token) {
    const tokenRes = await axios.post(
      'https://www.linkedin.com/oauth/v2/accessToken',
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: channel.refresh_token,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const { rows } = await pool.query(
      `UPDATE brand_channels SET access_token = $1, refresh_token = COALESCE($2, refresh_token),
         token_expires_at = $3, updated_at = NOW() WHERE id = $4 RETURNING *`,
      [
        tokenRes.data.access_token,
        tokenRes.data.refresh_token || null,
        new Date(Date.now() + (tokenRes.data.expires_in || 3600) * 1000),
        channel.id,
      ]
    );
    return rows[0];
  }

  return channel;
}

async function ensureFreshToken(channel) {
  if (
    channel.token_expires_at &&
    new Date(channel.token_expires_at).getTime() < Date.now() + 60_000
  ) {
    return refreshChannelToken(channel);
  }
  return channel;
}

async function channelsForBrandPlatforms(brandId, platforms) {
  const { rows } = await pool.query(
    `SELECT * FROM brand_channels
     WHERE brand_id = $1 AND status = 'active'
       AND ($2::text[] IS NULL OR cardinality($2::text[]) = 0 OR platform = ANY($2::text[]))`,
    [brandId, platforms || []]
  );
  return rows;
}

module.exports = {
  PLATFORM_SCOPES,
  listChannels,
  disconnectChannel,
  getAuthUrl,
  handleCallback,
  getChannel,
  ensureFreshToken,
  refreshChannelToken,
  channelsForBrandPlatforms,
  upsertChannel,
  frontendUrl,
  baseUrl,
  storeState,
  consumeState,
  pkcePair,
};
