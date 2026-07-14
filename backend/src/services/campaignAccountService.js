const pool = require('./db');

class CampaignAccountService {
  async list(campaignId) {
    const result = await pool.query(
      `SELECT ca.*, sa.username, sa.platform, sa.status AS account_status,
              sa.is_simulated, sa.warmup_status, sa.warmed_up_at,
              EXISTS (
                SELECT 1 FROM social_account_proxies sap
                WHERE sap.social_account_id = sa.id AND sap.is_active = true
              ) AS has_proxy
       FROM campaign_accounts ca
       JOIN social_accounts sa ON sa.id = ca.social_account_id
       WHERE ca.campaign_id = $1
       ORDER BY sa.platform, sa.username`,
      [campaignId]
    );
    return result.rows;
  }

  async assign(campaignId, socialAccountId, role = 'both') {
    const account = await pool.query(
      `SELECT id, platform, status, credentials, is_simulated
       FROM social_accounts WHERE id = $1`,
      [socialAccountId]
    );
    if (!account.rows[0]) throw new Error('Social account not found');
    if (account.rows[0].status !== 'active') {
      throw new Error('Account must be active to assign');
    }
    if (account.rows[0].is_simulated || account.rows[0].credentials?.password === 'default_password') {
      throw new Error('Cannot assign simulated/fake accounts to a campaign');
    }

    const result = await pool.query(
      `INSERT INTO campaign_accounts (campaign_id, social_account_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (campaign_id, social_account_id)
       DO UPDATE SET role = EXCLUDED.role
       RETURNING *`,
      [campaignId, socialAccountId, role]
    );
    return result.rows[0];
  }

  async unassign(campaignId, socialAccountId) {
    const result = await pool.query(
      `DELETE FROM campaign_accounts
       WHERE campaign_id = $1 AND social_account_id = $2
       RETURNING *`,
      [campaignId, socialAccountId]
    );
    return result.rows[0];
  }

  async getAvailableAccounts(campaignId, platform, excludeIds = []) {
    const params = [campaignId, platform];
    let excludeClause = '';
    if (excludeIds.length) {
      params.push(excludeIds);
      excludeClause = `AND sa.id != ALL($${params.length})`;
    }

    const assigned = await pool.query(
      `SELECT sa.*
       FROM campaign_accounts ca
       JOIN social_accounts sa ON sa.id = ca.social_account_id
       WHERE ca.campaign_id = $1
         AND sa.platform = $2
         AND sa.status = 'active'
         AND COALESCE(sa.is_simulated, false) = false
         AND COALESCE(sa.credentials->>'password', '') != 'default_password'
         ${excludeClause}
       ORDER BY RANDOM()`,
      params
    );

    if (assigned.rows.length) return assigned.rows;

    // Fall back to global real accounts when none assigned to campaign
    const globalParams = [platform];
    let globalExclude = '';
    if (excludeIds.length) {
      globalParams.push(excludeIds);
      globalExclude = 'AND id != ALL($2)';
    }
    const global = await pool.query(
      `SELECT * FROM social_accounts
       WHERE platform = $1
         AND status = 'active'
         AND COALESCE(credentials->>'password', '') != 'default_password'
         AND COALESCE(credentials->>'password', '') != ''
         ${globalExclude}
       ORDER BY
         CASE WHEN COALESCE(is_simulated, false) = false THEN 0 ELSE 1 END,
         RANDOM()`,
      globalParams
    );
    return global.rows;
  }

  async listEngagementTargets(campaignId) {
    const result = await pool.query(
      `SELECT * FROM engagement_targets
       WHERE campaign_id = $1
       ORDER BY created_at DESC`,
      [campaignId]
    );
    return result.rows;
  }

  async addEngagementTarget(campaignId, { target_url, platform = 'reddit', notes }) {
    if (!target_url || !String(target_url).includes('reddit.com')) {
      throw new Error('target_url must be a Reddit post URL');
    }
    const result = await pool.query(
      `INSERT INTO engagement_targets (campaign_id, platform, target_url, notes, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING *`,
      [campaignId, platform, target_url.trim(), notes || null]
    );
    return result.rows[0];
  }

  async updateEngagementTarget(campaignId, targetId, { status, notes }) {
    const result = await pool.query(
      `UPDATE engagement_targets
       SET status = COALESCE($3, status),
           notes = COALESCE($4, notes),
           last_engaged_at = CASE WHEN $3 = 'engaged' THEN NOW() ELSE last_engaged_at END
       WHERE id = $1 AND campaign_id = $2
       RETURNING *`,
      [targetId, campaignId, status || null, notes ?? null]
    );
    if (!result.rows[0]) throw new Error('Engagement target not found');
    return result.rows[0];
  }

  async deleteEngagementTarget(campaignId, targetId) {
    const result = await pool.query(
      `DELETE FROM engagement_targets WHERE id = $1 AND campaign_id = $2 RETURNING *`,
      [targetId, campaignId]
    );
    return result.rows[0];
  }

  async getPendingEngagementTarget(campaignId) {
    const result = await pool.query(
      `SELECT * FROM engagement_targets
       WHERE campaign_id = $1 AND status = 'pending'
       ORDER BY created_at ASC
       LIMIT 1`,
      [campaignId]
    );
    return result.rows[0] || null;
  }
}

module.exports = new CampaignAccountService();
