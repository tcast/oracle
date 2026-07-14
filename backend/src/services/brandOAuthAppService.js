const pool = require('./db');

/** Map connect platform → oauth app provider row */
const PLATFORM_TO_PROVIDER = {
  linkedin: 'linkedin',
  x: 'x',
  facebook: 'meta',
  instagram: 'meta',
  meta_ads: 'meta',
  google_ads: 'google_ads',
};

const PROVIDERS = ['linkedin', 'x', 'meta', 'google_ads'];

function providerForPlatform(platform) {
  const p = PLATFORM_TO_PROVIDER[platform];
  if (!p) throw new Error(`Unknown platform for oauth apps: ${platform}`);
  return p;
}

function maskSecret(secret) {
  if (!secret) return null;
  if (secret.length <= 8) return '••••';
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

async function listOAuthApps(brandId, { includeSecrets = false } = {}) {
  const { rows } = await pool.query(
    `SELECT id, brand_id, provider, client_id, client_secret, extra, created_at, updated_at
     FROM brand_oauth_apps WHERE brand_id = $1 ORDER BY provider`,
    [brandId]
  );

  const byProvider = Object.fromEntries(PROVIDERS.map((p) => [p, null]));
  for (const row of rows) {
    byProvider[row.provider] = {
      id: row.id,
      brand_id: row.brand_id,
      provider: row.provider,
      client_id: row.client_id,
      client_secret: includeSecrets ? row.client_secret : maskSecret(row.client_secret),
      has_secret: !!row.client_secret,
      extra: row.extra || {},
      configured: !!(row.client_id && row.client_secret),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
  // Mark configured for google if client_id + developer_token even without secret edge cases
  for (const p of PROVIDERS) {
    if (!byProvider[p]) {
      byProvider[p] = {
        provider: p,
        client_id: null,
        client_secret: null,
        has_secret: false,
        extra: {},
        configured: false,
      };
    }
  }
  return byProvider;
}

async function getOAuthApp(brandId, provider) {
  const { rows } = await pool.query(
    `SELECT * FROM brand_oauth_apps WHERE brand_id = $1 AND provider = $2`,
    [brandId, provider]
  );
  return rows[0] || null;
}

/**
 * Resolve credentials for a connect platform.
 * DB per-brand first; env vars as global fallback.
 */
async function resolveCredentials(brandId, platform) {
  const provider = providerForPlatform(platform);
  const row = await getOAuthApp(brandId, provider);
  const extra = row?.extra || {};

  if (provider === 'linkedin') {
    const clientId = row?.client_id || process.env.LINKEDIN_CLIENT_ID;
    const clientSecret = row?.client_secret || process.env.LINKEDIN_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error(
        'LinkedIn OAuth app not configured for this brand. Add Client ID and Secret on the brand page.'
      );
    }
    return { provider, clientId, clientSecret, extra };
  }

  if (provider === 'x') {
    const clientId = row?.client_id || process.env.X_CLIENT_ID;
    const clientSecret = row?.client_secret || process.env.X_CLIENT_SECRET || '';
    if (!clientId) {
      throw new Error(
        'X OAuth app not configured for this brand. Add Client ID (and Secret) on the brand page.'
      );
    }
    return { provider, clientId, clientSecret, extra };
  }

  if (provider === 'meta') {
    const clientId = row?.client_id || process.env.META_APP_ID;
    const clientSecret = row?.client_secret || process.env.META_APP_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error(
        'Meta OAuth app not configured for this brand. Add App ID and App Secret on the brand page (used for Facebook, Instagram, and Meta Ads).'
      );
    }
    return { provider, clientId, clientSecret, extra };
  }

  if (provider === 'google_ads') {
    const clientId = row?.client_id || process.env.GOOGLE_ADS_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
    const clientSecret =
      row?.client_secret || process.env.GOOGLE_ADS_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
    const developerToken =
      extra.developer_token || process.env.GOOGLE_ADS_DEVELOPER_TOKEN || null;
    const loginCustomerId =
      extra.login_customer_id || process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || null;
    if (!clientId || !clientSecret) {
      throw new Error(
        'Google Ads OAuth app not configured for this brand. Add Client ID, Client Secret, and Developer Token on the brand page.'
      );
    }
    return {
      provider,
      clientId,
      clientSecret,
      extra: { ...extra, developer_token: developerToken, login_customer_id: loginCustomerId },
    };
  }

  throw new Error(`Unsupported oauth provider: ${provider}`);
}

async function upsertOAuthApp(brandId, provider, { client_id, client_secret, extra }) {
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`Invalid provider: ${provider}. Use one of: ${PROVIDERS.join(', ')}`);
  }

  const existing = await getOAuthApp(brandId, provider);
  const nextSecret =
    client_secret === undefined || client_secret === null || client_secret === ''
      ? existing?.client_secret || null
      : client_secret;
  // Don't overwrite secret if UI sends masked placeholder
  const secretLooksMasked =
    typeof client_secret === 'string' &&
    (client_secret.includes('…') || client_secret.includes('••••') || client_secret.includes('...'));
  const finalSecret = secretLooksMasked ? existing?.client_secret || null : nextSecret;

  const nextExtra = {
    ...(existing?.extra || {}),
    ...(extra || {}),
  };

  const { rows } = await pool.query(
    `INSERT INTO brand_oauth_apps (brand_id, provider, client_id, client_secret, extra, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
     ON CONFLICT (brand_id, provider) DO UPDATE SET
       client_id = EXCLUDED.client_id,
       client_secret = COALESCE(EXCLUDED.client_secret, brand_oauth_apps.client_secret),
       extra = EXCLUDED.extra,
       updated_at = NOW()
     RETURNING id, brand_id, provider, client_id, extra, created_at, updated_at,
               (client_secret IS NOT NULL) AS has_secret`,
    [
      brandId,
      provider,
      client_id || null,
      finalSecret,
      JSON.stringify(nextExtra),
    ]
  );

  const row = rows[0];
  return {
    ...row,
    client_secret: maskSecret(finalSecret),
    configured: !!(row.client_id && finalSecret),
  };
}

async function deleteOAuthApp(brandId, provider) {
  const { rows } = await pool.query(
    `DELETE FROM brand_oauth_apps WHERE brand_id = $1 AND provider = $2 RETURNING id`,
    [brandId, provider]
  );
  return rows[0] || null;
}

module.exports = {
  PROVIDERS,
  PLATFORM_TO_PROVIDER,
  providerForPlatform,
  listOAuthApps,
  getOAuthApp,
  resolveCredentials,
  upsertOAuthApp,
  deleteOAuthApp,
};
