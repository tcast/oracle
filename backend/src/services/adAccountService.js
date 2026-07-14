const crypto = require('crypto');
const axios = require('axios');
const pool = require('./db');
const brandChannelService = require('./brandChannelService');
const brandOAuthAppService = require('./brandOAuthAppService');

function baseUrl() {
  return brandChannelService.baseUrl();
}

function frontendUrl() {
  return brandChannelService.frontendUrl();
}

async function listAdAccounts(brandId) {
  const { rows } = await pool.query(
    `SELECT id, brand_id, platform, external_account_id, name, currency, status, meta,
            token_expires_at, created_at, updated_at,
            (access_token IS NOT NULL) AS connected
     FROM ad_accounts WHERE brand_id = $1 ORDER BY platform, name`,
    [brandId]
  );
  return rows;
}

async function getAdAccount(id) {
  const { rows } = await pool.query(`SELECT * FROM ad_accounts WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function disconnectAdAccount(brandId, accountId) {
  const { rows } = await pool.query(
    `DELETE FROM ad_accounts WHERE id = $1 AND brand_id = $2 RETURNING id`,
    [accountId, brandId]
  );
  return rows[0] || null;
}

async function getAdsAuthUrl(brandId, platform, userId) {
  const creds = await brandOAuthAppService.resolveCredentials(brandId, platform);
  const state = brandChannelService.storeState({ brandId, platform, userId, kind: 'ads' });
  const redirectUri = `${baseUrl()}/api/oauth/${platform}/callback`;

  if (platform === 'google_ads') {
    const params = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/adwords',
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  if (platform === 'meta_ads') {
    const params = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: redirectUri,
      state,
      scope: 'ads_management,ads_read,business_management',
      response_type: 'code',
    });
    return `https://www.facebook.com/v19.0/dialog/oauth?${params}`;
  }

  throw new Error(`Unsupported ads platform: ${platform}`);
}

async function upsertAdAccount(brandId, data) {
  const { platform, external_account_id, name, currency, access_token, refresh_token, token_expires_at, meta } = data;
  const { rows } = await pool.query(
    `INSERT INTO ad_accounts
       (brand_id, platform, external_account_id, name, currency, access_token, refresh_token,
        token_expires_at, meta, status, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'active',NOW())
     ON CONFLICT (brand_id, platform, external_account_id) DO UPDATE SET
       name = EXCLUDED.name,
       access_token = EXCLUDED.access_token,
       refresh_token = COALESCE(EXCLUDED.refresh_token, ad_accounts.refresh_token),
       token_expires_at = EXCLUDED.token_expires_at,
       meta = EXCLUDED.meta,
       status = 'active',
       updated_at = NOW()
     RETURNING *`,
    [
      brandId,
      platform,
      external_account_id,
      name,
      currency || 'USD',
      access_token,
      refresh_token || null,
      token_expires_at || null,
      JSON.stringify(meta || {}),
    ]
  );
  return rows[0];
}

async function handleAdsCallback(platform, { code, state }) {
  const ctx = brandChannelService.consumeState(state);
  if (!ctx || ctx.platform !== platform) {
    throw new Error('Invalid or expired OAuth state');
  }

  const creds = await brandOAuthAppService.resolveCredentials(ctx.brandId, platform);
  const redirectUri = `${baseUrl()}/api/oauth/${platform}/callback`;

  if (platform === 'google_ads') {
    const tokenRes = await axios.post(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        code,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const accessToken = tokenRes.data.access_token;
    const refreshToken = tokenRes.data.refresh_token;
    const expiresAt = new Date(Date.now() + (tokenRes.data.expires_in || 3600) * 1000);

    let accounts = [];
    const developerToken = creds.extra?.developer_token;
    if (developerToken) {
      try {
        const listRes = await axios.get(
          'https://googleads.googleapis.com/v17/customers:listAccessibleCustomers',
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'developer-token': developerToken,
            },
          }
        );
        accounts = (listRes.data.resourceNames || []).map((rn) => {
          const id = rn.split('/')[1];
          return { id, name: `Google Ads ${id}` };
        });
      } catch (err) {
        console.warn('Google Ads list customers failed:', err.message);
      }
    }

    if (!accounts.length) {
      accounts = [{ id: `pending_${crypto.randomBytes(4).toString('hex')}`, name: 'Google Ads (linked — set customer id)' }];
    }

    for (const acct of accounts) {
      await upsertAdAccount(ctx.brandId, {
        platform: 'google_ads',
        external_account_id: acct.id,
        name: acct.name,
        access_token: accessToken,
        refresh_token: refreshToken,
        token_expires_at: expiresAt,
        meta: { resource: acct },
      });
    }
  } else if (platform === 'meta_ads') {
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
    } catch (_) { /* keep */ }

    const adAccountsRes = await axios.get('https://graph.facebook.com/v19.0/me/adaccounts', {
      params: {
        access_token: accessToken,
        fields: 'id,name,account_id,currency,account_status',
      },
    });
    const accounts = adAccountsRes.data.data || [];
    if (!accounts.length) {
      throw new Error('No Meta ad accounts found for this user');
    }

    for (const acct of accounts) {
      await upsertAdAccount(ctx.brandId, {
        platform: 'meta_ads',
        external_account_id: acct.account_id || acct.id.replace(/^act_/, ''),
        name: acct.name,
        currency: acct.currency || 'USD',
        access_token: accessToken,
        meta: { act_id: acct.id, account_status: acct.account_status },
      });
    }
  } else {
    throw new Error(`Unsupported ads platform: ${platform}`);
  }

  return {
    brandId: ctx.brandId,
    platform,
    redirect: `${frontendUrl()}/brands/${ctx.brandId}?connected=${platform}`,
  };
}

async function refreshGoogleToken(account) {
  if (!account.refresh_token) return account;
  const creds = await brandOAuthAppService.resolveCredentials(account.brand_id, 'google_ads');
  const tokenRes = await axios.post(
    'https://oauth2.googleapis.com/token',
    new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: account.refresh_token,
      grant_type: 'refresh_token',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  const { rows } = await pool.query(
    `UPDATE ad_accounts SET access_token = $1, token_expires_at = $2, updated_at = NOW()
     WHERE id = $3 RETURNING *`,
    [
      tokenRes.data.access_token,
      new Date(Date.now() + (tokenRes.data.expires_in || 3600) * 1000),
      account.id,
    ]
  );
  return rows[0];
}

async function ensureFreshAdToken(account) {
  if (
    account.platform === 'google_ads' &&
    account.token_expires_at &&
    new Date(account.token_expires_at).getTime() < Date.now() + 60_000
  ) {
    return refreshGoogleToken(account);
  }
  return account;
}

module.exports = {
  listAdAccounts,
  getAdAccount,
  disconnectAdAccount,
  getAdsAuthUrl,
  handleAdsCallback,
  upsertAdAccount,
  ensureFreshAdToken,
};
