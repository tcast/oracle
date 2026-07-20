const pool = require('./db');
const proxyService = require('./proxyService');
const { classifyFailure } = require('./failureClassifier');

/**
 * Aggregate ops metrics for the NOC dashboard (single round-trip payload).
 */
class NocService {
  async getDashboard() {
    const [
      proxies,
      accounts,
      posting,
      errors,
      mapping,
      queue,
    ] = await Promise.all([
      this.getProxyHealth(),
      this.getAccountStatus(),
      this.getPostingStatus(),
      this.getErrorDigest(),
      proxyService.getProxyMappingStatus().catch((e) => ({ ok: false, error: e.message })),
      this.getQueueStatus(),
    ]);

    return {
      generated_at: new Date().toISOString(),
      proxies,
      accounts,
      posting,
      errors,
      mapping: {
        ok: mapping.ok,
        ...(mapping.overview || {}),
        multi_assigned: mapping.accounts_with_multiple_proxies?.length || 0,
        shared_proxies: mapping.proxies_shared_across_accounts?.length || 0,
        accounts_without_proxy_sample: (mapping.accounts_without_proxy || []).slice(0, 15),
      },
      queue,
      protection: proxyService.getProtectionThresholds(),
    };
  }

  async getProxyHealth() {
    const overview = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE is_active)::int AS active,
        COUNT(*) FILTER (WHERE NOT is_active)::int AS inactive,
        COUNT(*) FILTER (
          WHERE is_active AND cooldown_until IS NOT NULL AND cooldown_until > NOW()
        )::int AS in_cooldown,
        COUNT(*) FILTER (
          WHERE is_active AND (cooldown_until IS NULL OR cooldown_until <= NOW())
            AND consecutive_failures = 0
        )::int AS healthy,
        COUNT(*) FILTER (
          WHERE is_active AND consecutive_failures >= 1
            AND (cooldown_until IS NULL OR cooldown_until <= NOW())
        )::int AS degraded,
        COUNT(*) FILTER (WHERE is_active AND NOT EXISTS (
          SELECT 1 FROM social_account_proxies sap
          WHERE sap.proxy_id = proxies.id AND sap.is_active = true
        ))::int AS free,
        COUNT(*) FILTER (WHERE is_active AND EXISTS (
          SELECT 1 FROM social_account_proxies sap
          WHERE sap.proxy_id = proxies.id AND sap.is_active = true
        ))::int AS assigned,
        COALESCE(SUM(success_count), 0)::int AS total_successes,
        COALESCE(SUM(failure_count), 0)::int AS total_failures
      FROM proxies
    `);

    const byProvider = await pool.query(`
      SELECT
        COALESCE(NULLIF(TRIM(provider), ''), 'unknown') AS provider,
        COALESCE(metadata->>'zone', '') AS zone,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE is_active)::int AS active,
        COUNT(*) FILTER (WHERE NOT is_active)::int AS inactive,
        COUNT(*) FILTER (
          WHERE is_active AND cooldown_until IS NOT NULL AND cooldown_until > NOW()
        )::int AS in_cooldown,
        COUNT(*) FILTER (WHERE is_active AND NOT EXISTS (
          SELECT 1 FROM social_account_proxies sap
          WHERE sap.proxy_id = proxies.id AND sap.is_active = true
        ))::int AS free,
        COUNT(*) FILTER (WHERE is_active AND EXISTS (
          SELECT 1 FROM social_account_proxies sap
          WHERE sap.proxy_id = proxies.id AND sap.is_active = true
        ))::int AS assigned,
        ROUND(AVG(consecutive_failures)::numeric, 1) AS avg_consecutive_failures,
        MAX(last_failure_at) AS last_failure_at,
        MAX(last_success_at) AS last_success_at
      FROM proxies
      GROUP BY 1, 2
      ORDER BY total DESC
    `);

    const unhealthy = await pool.query(`
      SELECT
        p.id, p.name, p.provider, p.server, p.country,
        p.is_active, p.cooldown_until, p.consecutive_failures,
        p.failure_count, p.success_count, p.last_error,
        p.last_success_at, p.last_failure_at, p.last_used_at,
        p.last_health_ok, p.last_health_check_at,
        p.metadata->>'zone' AS zone,
        p.metadata->>'sticky' AS sticky,
        sa.id AS account_id, sa.username AS account_username, sa.platform AS account_platform
      FROM proxies p
      LEFT JOIN social_account_proxies sap
        ON sap.proxy_id = p.id AND sap.is_active = true
      LEFT JOIN social_accounts sa ON sa.id = sap.social_account_id
      WHERE NOT p.is_active
         OR (p.cooldown_until IS NOT NULL AND p.cooldown_until > NOW())
         OR p.consecutive_failures >= 2
         OR COALESCE(p.last_health_ok, true) = false
      ORDER BY
        CASE WHEN NOT p.is_active THEN 0
             WHEN p.cooldown_until > NOW() THEN 1
             ELSE 2 END,
        p.consecutive_failures DESC,
        p.last_failure_at DESC NULLS LAST
      LIMIT 40
    `);

    const recentHealth = await pool.query(`
      SELECT
        id, name, provider, is_active,
        consecutive_failures, failure_count, success_count,
        last_error, last_success_at, last_failure_at,
        last_health_ok, last_health_check_at, cooldown_until,
        metadata->>'zone' AS zone
      FROM proxies
      WHERE last_used_at IS NOT NULL OR last_health_check_at IS NOT NULL
      ORDER BY GREATEST(
        COALESCE(last_used_at, '1970-01-01'::timestamp),
        COALESCE(last_health_check_at, '1970-01-01'::timestamp)
      ) DESC
      LIMIT 25
    `);

    const o = overview.rows[0] || {};
    const failTotal = Number(o.total_failures) || 0;
    const okTotal = Number(o.total_successes) || 0;
    const attempts = failTotal + okTotal;

    return {
      overview: {
        ...o,
        error_rate: attempts > 0 ? Math.round((failTotal / attempts) * 1000) / 10 : 0,
      },
      by_provider: byProvider.rows,
      unhealthy: unhealthy.rows,
      recent: recentHealth.rows,
    };
  }

  async getAccountStatus() {
    const byPlatform = await pool.query(`
      SELECT
        platform,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'active')::int AS active,
        COUNT(*) FILTER (WHERE status IN ('banned', 'suspended', 'disabled'))::int AS banned,
        COUNT(*) FILTER (WHERE status IN ('error', 'failed', 'login_failed'))::int AS error,
        COUNT(*) FILTER (
          WHERE warmup_status IN ('warming', 'pending', 'new') OR status = 'warming'
        )::int AS warming,
        COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM social_account_proxies sap
          WHERE sap.social_account_id = social_accounts.id AND sap.is_active = true
        ))::int AS with_proxy,
        COUNT(*) FILTER (WHERE NOT EXISTS (
          SELECT 1 FROM social_account_proxies sap
          WHERE sap.social_account_id = social_accounts.id AND sap.is_active = true
        ))::int AS without_proxy
      FROM social_accounts
      WHERE COALESCE(is_simulated, false) = false
      GROUP BY platform
      ORDER BY total DESC
    `);

    const recentJobFailures = await pool.query(`
      SELECT 'organic' AS source, sa.platform, sa.username, j.failure_class, j.last_error,
             j.consecutive_failures, j.cooldown_until, j.updated_at
      FROM organic_comment_jobs j
      JOIN social_accounts sa ON sa.id = j.social_account_id
      WHERE j.last_error IS NOT NULL
         OR j.consecutive_failures > 0
         OR (j.cooldown_until IS NOT NULL AND j.cooldown_until > NOW())
      ORDER BY j.updated_at DESC NULLS LAST
      LIMIT 15
    `).catch(() => ({ rows: [] }));

    const xFailures = await pool.query(`
      SELECT 'x_follow' AS source, sa.platform, sa.username, j.failure_class, j.last_error,
             j.consecutive_failures, j.cooldown_until, j.updated_at
      FROM x_follow_jobs j
      JOIN social_accounts sa ON sa.id = j.social_account_id
      WHERE j.last_error IS NOT NULL
         OR j.consecutive_failures > 0
         OR (j.cooldown_until IS NOT NULL AND j.cooldown_until > NOW())
      ORDER BY j.updated_at DESC NULLS LAST
      LIMIT 10
    `).catch(() => ({ rows: [] }));

    const warmFailures = await pool.query(`
      SELECT 'warm' AS source, sa.platform, sa.username, j.failure_class, j.last_error,
             j.consecutive_failures, j.cooldown_until, j.updated_at
      FROM social_warm_jobs j
      JOIN social_accounts sa ON sa.id = j.social_account_id
      WHERE j.last_error IS NOT NULL
         OR j.consecutive_failures > 0
         OR (j.cooldown_until IS NOT NULL AND j.cooldown_until > NOW())
      ORDER BY j.updated_at DESC NULLS LAST
      LIMIT 10
    `).catch(() => ({ rows: [] }));

    const recent_failures = [
      ...recentJobFailures.rows,
      ...xFailures.rows,
      ...warmFailures.rows,
    ]
      .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0))
      .slice(0, 25);

    return {
      by_platform: byPlatform.rows,
      recent_failures,
    };
  }

  async getPostingStatus() {
    const organicSettings = await pool.query(
      `SELECT * FROM organic_comment_settings WHERE id = 1`
    ).catch(() => ({ rows: [] }));

    const organicToday = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'posted')::int AS posted,
        COUNT(*) FILTER (WHERE status = 'error')::int AS failed,
        COUNT(*) FILTER (WHERE status = 'simulated')::int AS simulated
      FROM organic_comments
      WHERE created_at::date = CURRENT_DATE
    `).catch(() => ({ rows: [{ posted: 0, failed: 0, simulated: 0 }] }));

    const organicJobs = await pool.query(`
      SELECT
        COUNT(*)::int AS total_jobs,
        COUNT(*) FILTER (WHERE enabled)::int AS enabled,
        COUNT(*) FILTER (WHERE status = 'running')::int AS running,
        COUNT(*) FILTER (
          WHERE enabled AND (cooldown_until IS NULL OR cooldown_until <= NOW())
            AND next_due_at IS NOT NULL AND next_due_at <= NOW()
        )::int AS due_now,
        COUNT(*) FILTER (
          WHERE cooldown_until IS NOT NULL AND cooldown_until > NOW()
        )::int AS in_cooldown
      FROM organic_comment_jobs
    `).catch(() => ({ rows: [{}] }));

    const xToday = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'followed' OR status = 'success')::int AS followed,
        COUNT(*) FILTER (WHERE status = 'error' OR status = 'failed')::int AS failed
      FROM x_follows
      WHERE created_at::date = CURRENT_DATE
    `).catch(() => ({ rows: [{ followed: 0, failed: 0 }] }));

    const xJobs = await pool.query(`
      SELECT
        COUNT(*)::int AS total_jobs,
        COUNT(*) FILTER (WHERE enabled)::int AS enabled,
        COUNT(*) FILTER (WHERE status = 'running')::int AS running
      FROM x_follow_jobs
    `).catch(() => ({ rows: [{}] }));

    const warmToday = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('ok', 'success', 'done'))::int AS ok,
        COUNT(*) FILTER (WHERE status = 'error' OR status = 'failed')::int AS failed
      FROM social_warm_actions
      WHERE created_at::date = CURRENT_DATE
    `).catch(() => ({ rows: [{ ok: 0, failed: 0 }] }));

    const settings = organicSettings.rows[0] || {};
    const now = new Date();
    const hour = now.getHours();
    const qStart = settings.quiet_hours_start ?? 1;
    const qEnd = settings.quiet_hours_end ?? 7;
    let inQuiet = false;
    if (qStart === qEnd) inQuiet = false;
    else if (qStart < qEnd) inQuiet = hour >= qStart && hour < qEnd;
    else inQuiet = hour >= qStart || hour < qEnd;

    return {
      organic: {
        enabled: !!settings.enabled,
        quiet_hours: { start: qStart, end: qEnd, active: inQuiet },
        min_per_day: settings.min_per_day,
        max_per_day: settings.max_per_day,
        max_concurrent: settings.max_concurrent,
        today: organicToday.rows[0] || { posted: 0, failed: 0, simulated: 0 },
        jobs: organicJobs.rows[0] || {},
      },
      x_follow: {
        today: xToday.rows[0] || { followed: 0, failed: 0 },
        jobs: xJobs.rows[0] || {},
      },
      warm: {
        today: warmToday.rows[0] || { ok: 0, failed: 0 },
      },
    };
  }

  async getErrorDigest() {
    const organicErrors = await pool.query(`
      SELECT last_error AS message, failure_class, COUNT(*)::int AS count,
             MAX(updated_at) AS last_seen
      FROM organic_comment_jobs
      WHERE last_error IS NOT NULL
        AND updated_at > NOW() - INTERVAL '24 hours'
      GROUP BY last_error, failure_class
      ORDER BY count DESC
      LIMIT 20
    `).catch(() => ({ rows: [] }));

    const commentErrors = await pool.query(`
      SELECT error AS message, COUNT(*)::int AS count, MAX(created_at) AS last_seen
      FROM organic_comments
      WHERE status = 'error'
        AND created_at > NOW() - INTERVAL '24 hours'
        AND error IS NOT NULL
      GROUP BY error
      ORDER BY count DESC
      LIMIT 10
    `).catch(() => ({ rows: [] }));

    const proxyErrors = await pool.query(`
      SELECT last_error AS message, COUNT(*)::int AS count,
             MAX(last_failure_at) AS last_seen
      FROM proxies
      WHERE last_error IS NOT NULL
        AND last_failure_at > NOW() - INTERVAL '24 hours'
      GROUP BY last_error
      ORDER BY count DESC
      LIMIT 15
    `).catch(() => ({ rows: [] }));

    const samples = [];
    for (const row of organicErrors.rows) {
      const cls = row.failure_class || classifyFailure(row.message);
      samples.push({
        source: 'organic_job',
        class: cls,
        message: row.message,
        count: row.count,
        last_seen: row.last_seen,
      });
    }
    for (const row of commentErrors.rows) {
      samples.push({
        source: 'organic_comment',
        class: classifyFailure(row.message),
        message: row.message,
        count: row.count,
        last_seen: row.last_seen,
      });
    }
    for (const row of proxyErrors.rows) {
      samples.push({
        source: 'proxy',
        class: classifyFailure(row.message),
        message: row.message,
        count: row.count,
        last_seen: row.last_seen,
      });
    }

    const byClass = {};
    for (const s of samples) {
      byClass[s.class] = (byClass[s.class] || 0) + s.count;
    }

    samples.sort((a, b) => b.count - a.count || new Date(b.last_seen || 0) - new Date(a.last_seen || 0));

    return {
      last_24h_by_class: Object.entries(byClass)
        .map(([failure_class, count]) => ({ failure_class, count }))
        .sort((a, b) => b.count - a.count),
      samples: samples.slice(0, 30),
    };
  }

  async getQueueStatus() {
    try {
      const durableQueue = require('./durableQueue');
      return await durableQueue.getStatus();
    } catch (err) {
      return { started: false, error: err.message };
    }
  }
}

module.exports = new NocService();
