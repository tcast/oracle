const axios = require('axios');
const pool = require('./db');
const adAccountService = require('./adAccountService');

async function listAdCampaigns(campaignId) {
  const { rows } = await pool.query(
    `SELECT ac.*, aa.name AS ad_account_name, aa.external_account_id, aa.currency
     FROM ad_campaigns ac
     JOIN ad_accounts aa ON aa.id = ac.ad_account_id
     WHERE ac.campaign_id = $1
     ORDER BY ac.created_at DESC`,
    [campaignId]
  );
  return rows;
}

async function getAdCampaign(id) {
  const { rows } = await pool.query(`SELECT * FROM ad_campaigns WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function createMetaAdCampaign(account, payload, whisperCampaign) {
  const actId = account.meta?.act_id || `act_${account.external_account_id}`;
  const objective = payload.objective || 'OUTCOME_TRAFFIC';
  const dailyBudget = payload.budget_daily_cents || 1000;

  const campRes = await axios.post(
    `https://graph.facebook.com/v19.0/${actId}/campaigns`,
    null,
    {
      params: {
        name: payload.name,
        objective,
        status: 'PAUSED',
        special_ad_categories: '[]',
        access_token: account.access_token,
      },
    }
  );

  const externalCampaignId = campRes.data.id;
  const link = whisperCampaign.target_url || payload.creative?.link || 'https://example.com';

  const adSetRes = await axios.post(
    `https://graph.facebook.com/v19.0/${actId}/adsets`,
    null,
    {
      params: {
        name: `${payload.name} — Ad Set`,
        campaign_id: externalCampaignId,
        daily_budget: dailyBudget,
        billing_event: 'IMPRESSIONS',
        optimization_goal: 'LINK_CLICKS',
        bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
        targeting: JSON.stringify(payload.targeting || { geo_locations: { countries: ['US'] }, age_min: 18 }),
        status: 'PAUSED',
        access_token: account.access_token,
      },
    }
  );

  const creative = {
    name: `${payload.name} — Creative`,
    object_story_spec: {
      page_id: payload.creative?.page_id || account.meta?.page_id,
      link_data: {
        message: payload.creative?.message || whisperCampaign.campaign_goal || payload.name,
        link,
        name: payload.creative?.headline || whisperCampaign.name,
        description: payload.creative?.description || whisperCampaign.campaign_overview || '',
      },
    },
  };

  let adId = null;
  if (creative.object_story_spec.page_id) {
    const creativeRes = await axios.post(
      `https://graph.facebook.com/v19.0/${actId}/adcreatives`,
      null,
      { params: { ...flattenCreative(creative), access_token: account.access_token } }
    );
    const adRes = await axios.post(
      `https://graph.facebook.com/v19.0/${actId}/ads`,
      null,
      {
        params: {
          name: `${payload.name} — Ad`,
          adset_id: adSetRes.data.id,
          creative: JSON.stringify({ creative_id: creativeRes.data.id }),
          status: 'PAUSED',
          access_token: account.access_token,
        },
      }
    );
    adId = adRes.data.id;
  }

  return {
    external_campaign_id: externalCampaignId,
    status: 'paused',
    creative: { ...payload.creative, ad_set_id: adSetRes.data.id, ad_id: adId, link },
    metrics: {},
  };
}

function flattenCreative(creative) {
  return {
    name: creative.name,
    object_story_spec: JSON.stringify(creative.object_story_spec),
  };
}

async function createGoogleAdCampaign(account, payload, whisperCampaign) {
  const brandOAuthAppService = require('./brandOAuthAppService');
  let developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  let loginCustomerId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  try {
    const creds = await brandOAuthAppService.resolveCredentials(account.brand_id, 'google_ads');
    developerToken = creds.extra?.developer_token || developerToken;
    loginCustomerId = creds.extra?.login_customer_id || loginCustomerId;
  } catch (_) { /* fall back to env */ }

  if (!developerToken) {
    // Store locally without remote create when developer token missing
    return {
      external_campaign_id: `local_gads_${Date.now()}`,
      status: 'draft',
      creative: {
        ...(payload.creative || {}),
        note: 'Stored locally — add Google Ads Developer Token on the brand OAuth apps page to push live',
        headlines: payload.creative?.headlines || [whisperCampaign.name],
        descriptions: payload.creative?.descriptions || [whisperCampaign.campaign_goal],
        final_url: whisperCampaign.target_url,
      },
      metrics: {},
    };
  }

  const fresh = await adAccountService.ensureFreshAdToken(account);
  const customerId = String(fresh.external_account_id).replace(/-/g, '');
  if (customerId.startsWith('pending_')) {
    return {
      external_campaign_id: `local_gads_${Date.now()}`,
      status: 'draft',
      creative: payload.creative || {},
      metrics: { warning: 'Update ad account with real Google Ads customer id' },
    };
  }

  const budgetMicros = (payload.budget_daily_cents || 1000) * 10_000;

  // Create budget + campaign via Google Ads mutate
  const operations = [
    {
      campaignBudgetOperation: {
        create: {
          name: `${payload.name} Budget ${Date.now()}`,
          deliveryMethod: 'STANDARD',
          amountMicros: String(budgetMicros),
          explicitlyShared: false,
        },
      },
    },
  ];

  // Simplified: use REST searchStream-style mutate if available; fall back to local
  try {
    const mutateRes = await axios.post(
      `https://googleads.googleapis.com/v17/customers/${customerId}/campaignBudgets:mutate`,
      {
        operations: [
          {
            create: {
              name: `${payload.name} Budget ${Date.now()}`,
              deliveryMethod: 'STANDARD',
              amountMicros: String(budgetMicros),
              explicitlyShared: false,
            },
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${fresh.access_token}`,
          'developer-token': developerToken,
          ...(loginCustomerId ? { 'login-customer-id': loginCustomerId.replace(/-/g, '') } : {}),
          'Content-Type': 'application/json',
        },
      }
    );
    const budgetResource = mutateRes.data.results?.[0]?.resourceName;
    const campRes = await axios.post(
      `https://googleads.googleapis.com/v17/customers/${customerId}/campaigns:mutate`,
      {
        operations: [
          {
            create: {
              name: payload.name,
              status: 'PAUSED',
              advertisingChannelType: 'SEARCH',
              campaignBudget: budgetResource,
              networkSettings: {
                targetGoogleSearch: true,
                targetSearchNetwork: true,
              },
              containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
            },
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${fresh.access_token}`,
          'developer-token': developerToken,
          ...(loginCustomerId ? { 'login-customer-id': loginCustomerId.replace(/-/g, '') } : {}),
          'Content-Type': 'application/json',
        },
      }
    );
    return {
      external_campaign_id: campRes.data.results?.[0]?.resourceName || `gads_${Date.now()}`,
      status: 'paused',
      creative: {
        ...(payload.creative || {}),
        headlines: payload.creative?.headlines || [whisperCampaign.name],
        descriptions: payload.creative?.descriptions || [whisperCampaign.campaign_goal],
        final_url: whisperCampaign.target_url,
      },
      metrics: {},
    };
  } catch (err) {
    console.warn('Google Ads remote create failed, storing draft:', err.response?.data || err.message);
    return {
      external_campaign_id: `local_gads_${Date.now()}`,
      status: 'draft',
      creative: {
        ...(payload.creative || {}),
        error: err.response?.data || err.message,
        final_url: whisperCampaign.target_url,
      },
      metrics: {},
    };
  }
}

async function createAdCampaign(campaignId, payload) {
  const { rows: campRows } = await pool.query(`SELECT * FROM campaigns WHERE id = $1`, [campaignId]);
  const whisperCampaign = campRows[0];
  if (!whisperCampaign) throw new Error('Campaign not found');
  if (whisperCampaign.campaign_type !== 'brand' && !whisperCampaign.ads_enabled) {
    throw new Error('Ads are only available on brand campaigns');
  }

  const account = await adAccountService.getAdAccount(payload.ad_account_id);
  if (!account) throw new Error('Ad account not found');
  if (account.brand_id !== whisperCampaign.brand_id) {
    throw new Error('Ad account does not belong to this campaign brand');
  }

  let libraryCreative = null;
  if (payload.ad_creative_id) {
    const { rows } = await pool.query(
      'SELECT * FROM ad_creatives WHERE id = $1 AND brand_id = $2',
      [payload.ad_creative_id, whisperCampaign.brand_id]
    );
    libraryCreative = rows[0];
    if (!libraryCreative) throw new Error('Saved ad does not belong to this campaign brand');
    payload.creative = {
      ...(libraryCreative.content || {}),
      ...(payload.creative || {}),
      image_url: payload.creative?.image_url || libraryCreative.image_url || null,
    };
  }

  let remote;
  if (account.platform === 'meta_ads') {
    remote = await createMetaAdCampaign(account, payload, whisperCampaign);
  } else if (account.platform === 'google_ads') {
    remote = await createGoogleAdCampaign(account, payload, whisperCampaign);
  } else {
    throw new Error(`Unsupported ads platform: ${account.platform}`);
  }

  const { rows } = await pool.query(
    `INSERT INTO ad_campaigns
       (campaign_id, ad_account_id, platform, external_campaign_id, name, objective, status,
        budget_daily_cents, budget_total_cents, targeting, creative, metrics, ad_creative_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13)
     RETURNING *`,
    [
      campaignId,
      account.id,
      account.platform,
      remote.external_campaign_id,
      payload.name,
      payload.objective || (account.platform === 'meta_ads' ? 'OUTCOME_TRAFFIC' : 'SEARCH'),
      remote.status,
      payload.budget_daily_cents || 1000,
      payload.budget_total_cents || null,
      JSON.stringify(payload.targeting || {}),
      JSON.stringify(remote.creative || {}),
      JSON.stringify(remote.metrics || {}),
      libraryCreative?.id || null,
    ]
  );
  return rows[0];
}

async function setAdCampaignStatus(adCampaignId, status) {
  const adCamp = await getAdCampaign(adCampaignId);
  if (!adCamp) throw new Error('Ad campaign not found');
  const account = await adAccountService.getAdAccount(adCamp.ad_account_id);
  const fresh = await adAccountService.ensureFreshAdToken(account);
  const brandOAuthAppService = require('./brandOAuthAppService');

  const remoteStatus = status === 'active' ? 'ACTIVE' : status === 'paused' ? 'PAUSED' : status.toUpperCase();

  if (fresh.platform === 'meta_ads' && adCamp.external_campaign_id && !String(adCamp.external_campaign_id).startsWith('local_')) {
    await axios.post(
      `https://graph.facebook.com/v19.0/${adCamp.external_campaign_id}`,
      null,
      { params: { status: remoteStatus, access_token: fresh.access_token } }
    );
  }

  if (fresh.platform === 'google_ads' && !String(adCamp.external_campaign_id).startsWith('local_')) {
    let developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    try {
      const creds = await brandOAuthAppService.resolveCredentials(fresh.brand_id, 'google_ads');
      developerToken = creds.extra?.developer_token || developerToken;
    } catch (_) { /* env fallback */ }
    if (developerToken) {
    const customerId = String(fresh.external_account_id).replace(/-/g, '');
    const resourceName = adCamp.external_campaign_id.includes('/')
      ? adCamp.external_campaign_id
      : `customers/${customerId}/campaigns/${adCamp.external_campaign_id}`;
    try {
      await axios.post(
        `https://googleads.googleapis.com/v17/customers/${customerId}/campaigns:mutate`,
        {
          operations: [{ update: { resourceName, status: remoteStatus }, updateMask: 'status' }],
        },
        {
          headers: {
            Authorization: `Bearer ${fresh.access_token}`,
            'developer-token': developerToken,
            'Content-Type': 'application/json',
          },
        }
      );
    } catch (err) {
      console.warn('Google Ads status update failed:', err.response?.data || err.message);
    }
    }
  }

  const { rows } = await pool.query(
    `UPDATE ad_campaigns SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [status, adCampaignId]
  );
  return rows[0];
}

async function syncAdCampaignMetrics(adCampaignId) {
  const adCamp = await getAdCampaign(adCampaignId);
  if (!adCamp) throw new Error('Ad campaign not found');
  const account = await adAccountService.getAdAccount(adCamp.ad_account_id);
  const fresh = await adAccountService.ensureFreshAdToken(account);
  let metrics = { ...(adCamp.metrics || {}), synced_at: new Date().toISOString() };

  if (fresh.platform === 'meta_ads' && adCamp.external_campaign_id && !String(adCamp.external_campaign_id).startsWith('local_')) {
    try {
      const insights = await axios.get(
        `https://graph.facebook.com/v19.0/${adCamp.external_campaign_id}/insights`,
        {
          params: {
            fields: 'impressions,clicks,spend,cpc,ctr',
            access_token: fresh.access_token,
          },
        }
      );
      const row = insights.data.data?.[0] || {};
      metrics = {
        ...metrics,
        impressions: Number(row.impressions || 0),
        clicks: Number(row.clicks || 0),
        spend: Number(row.spend || 0),
        cpc: Number(row.cpc || 0),
        ctr: Number(row.ctr || 0),
      };
    } catch (err) {
      metrics.sync_error = err.response?.data?.error?.message || err.message;
    }
  }

  const { rows } = await pool.query(
    `UPDATE ad_campaigns SET metrics = $1::jsonb, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [JSON.stringify(metrics), adCampaignId]
  );
  return rows[0];
}

module.exports = {
  listAdCampaigns,
  getAdCampaign,
  createAdCampaign,
  setAdCampaignStatus,
  syncAdCampaignMetrics,
};
