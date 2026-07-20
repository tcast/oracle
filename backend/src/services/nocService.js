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
      postingByPlatform,
      errors,
      mapping,
      queue,
      geo,
      events,
      accountCreation,
    ] = await Promise.all([
      this.getProxyHealth(),
      this.getAccountStatus(),
      this.getPostingStatus(),
      this.getPostingByPlatform(),
      this.getErrorDigest(),
      proxyService.getProxyMappingStatus().catch((e) => ({ ok: false, error: e.message })),
      this.getQueueStatus(),
      this.getGeoNodes(),
      this.getLiveEvents(),
      this.getAccountCreationStats(),
    ]);

    const flow = this.buildFlowGraph({
      proxies,
      accounts,
      posting,
      postingByPlatform,
      queue,
      accountCreation,
    });

    return {
      generated_at: new Date().toISOString(),
      proxies,
      accounts,
      posting,
      postingByPlatform,
      errors,
      geo,
      events,
      flow,
      accountCreation,
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

  /**
   * Quiet-hours helper shared by posting aggregates.
   */
  quietHoursFromSettings(settings = {}) {
    const now = new Date();
    const hour = now.getHours();
    const qStart = settings.quiet_hours_start ?? 1;
    const qEnd = settings.quiet_hours_end ?? 7;
    let inQuiet = false;
    if (qStart === qEnd) inQuiet = false;
    else if (qStart < qEnd) inQuiet = hour >= qStart && hour < qEnd;
    else inQuiet = hour >= qStart || hour < qEnd;
    return { start: qStart, end: qEnd, active: inQuiet };
  }

  /**
   * Derive a compact NOC status for a platform strip.
   * healthy | quiet | failing | idle
   */
  derivePlatformStatus({
    jobsEnabled,
    todayPosted,
    todayFailed,
    lastSuccessAt,
    quietActive,
    organicEnabled,
  }) {
    const lastSuccessMs = lastSuccessAt
      ? Date.now() - new Date(lastSuccessAt).getTime()
      : null;
    const recentSuccess = lastSuccessMs != null && lastSuccessMs < 6 * 3600 * 1000;
    const failHeavy =
      todayFailed > 0 && todayFailed >= Math.max(1, todayPosted);

    if (quietActive && organicEnabled && jobsEnabled > 0) return 'quiet';
    if (failHeavy || (todayFailed > 2 && !recentSuccess)) return 'failing';
    if (todayPosted > 0 || recentSuccess) return 'healthy';
    return 'idle';
  }

  /**
   * Per-network posting/comment activity for the NOC strip.
   */
  async getPostingByPlatform() {
    const organicSettings = await pool.query(
      `SELECT * FROM organic_comment_settings WHERE id = 1`
    ).catch(() => ({ rows: [] }));
    const settings = organicSettings.rows[0] || {};
    const quiet = this.quietHoursFromSettings(settings);
    const organicEnabled = !!settings.enabled;

    const platforms = await pool.query(`
      SELECT
        platform,
        COUNT(*)::int AS accounts_total,
        COUNT(*) FILTER (WHERE status = 'active')::int AS accounts_active
      FROM social_accounts
      WHERE COALESCE(is_simulated, false) = false
      GROUP BY platform
      ORDER BY accounts_total DESC
    `).catch(() => ({ rows: [] }));

    const organicByPlatform = await pool.query(`
      SELECT
        sa.platform,
        COUNT(*) FILTER (
          WHERE oc.status = 'posted' AND oc.created_at::date = CURRENT_DATE
        )::int AS today_posted,
        COUNT(*) FILTER (
          WHERE oc.status = 'error' AND oc.created_at::date = CURRENT_DATE
        )::int AS today_failed,
        COUNT(*) FILTER (
          WHERE oc.status = 'posted' AND oc.created_at > NOW() - INTERVAL '24 hours'
        )::int AS posted_24h,
        COUNT(*) FILTER (
          WHERE oc.status = 'error' AND oc.created_at > NOW() - INTERVAL '24 hours'
        )::int AS failed_24h,
        MAX(oc.created_at) FILTER (WHERE oc.status = 'posted') AS last_success_at,
        MAX(oc.created_at) FILTER (WHERE oc.status = 'error') AS last_failure_at
      FROM organic_comments oc
      JOIN social_accounts sa ON sa.id = oc.social_account_id
      GROUP BY sa.platform
    `).catch(() => ({ rows: [] }));

    const postsByPlatform = await pool.query(`
      SELECT
        platform,
        COUNT(*) FILTER (
          WHERE status IN ('posted', 'published', 'live', 'approved')
            AND COALESCE(posted_at, created_at)::date = CURRENT_DATE
        )::int AS today_posted,
        COUNT(*) FILTER (
          WHERE status IN ('error', 'failed', 'rejected')
            AND COALESCE(posted_at, created_at)::date = CURRENT_DATE
        )::int AS today_failed,
        MAX(COALESCE(posted_at, created_at)) FILTER (
          WHERE status IN ('posted', 'published', 'live', 'approved')
        ) AS last_success_at,
        MAX(COALESCE(posted_at, created_at)) FILTER (
          WHERE status IN ('error', 'failed', 'rejected')
        ) AS last_failure_at
      FROM posts
      WHERE platform IS NOT NULL AND platform <> ''
      GROUP BY platform
    `).catch(() => ({ rows: [] }));

    const commentsByPlatform = await pool.query(`
      SELECT
        sa.platform,
        COUNT(*) FILTER (
          WHERE c.status IN ('posted', 'published', 'live')
            AND COALESCE(c.posted_at, c.created_at)::date = CURRENT_DATE
        )::int AS today_posted,
        COUNT(*) FILTER (
          WHERE c.status IN ('error', 'failed')
            AND COALESCE(c.posted_at, c.created_at)::date = CURRENT_DATE
        )::int AS today_failed,
        MAX(COALESCE(c.posted_at, c.created_at)) FILTER (
          WHERE c.status IN ('posted', 'published', 'live')
        ) AS last_success_at
      FROM comments c
      JOIN social_accounts sa ON sa.id = c.social_account_id
      GROUP BY sa.platform
    `).catch(() => ({ rows: [] }));

    const jobsByPlatform = await pool.query(`
      SELECT
        sa.platform,
        COUNT(*)::int AS jobs_total,
        COUNT(*) FILTER (WHERE j.enabled)::int AS jobs_enabled,
        COUNT(*) FILTER (
          WHERE j.enabled AND sa.status = 'active'
        )::int AS accounts_with_jobs,
        COUNT(*) FILTER (WHERE j.status = 'running')::int AS running,
        COUNT(*) FILTER (
          WHERE j.cooldown_until IS NOT NULL AND j.cooldown_until > NOW()
        )::int AS in_cooldown,
        COUNT(*) FILTER (
          WHERE j.enabled
            AND (j.cooldown_until IS NULL OR j.cooldown_until <= NOW())
            AND j.next_due_at IS NOT NULL AND j.next_due_at <= NOW()
        )::int AS due_now
      FROM organic_comment_jobs j
      JOIN social_accounts sa ON sa.id = j.social_account_id
      GROUP BY sa.platform
    `).catch(() => ({ rows: [] }));

    const lastErrors = await pool.query(`
      SELECT DISTINCT ON (sa.platform)
        sa.platform,
        j.last_error AS last_error,
        j.failure_class,
        j.updated_at AS last_error_at
      FROM organic_comment_jobs j
      JOIN social_accounts sa ON sa.id = j.social_account_id
      WHERE j.last_error IS NOT NULL
        AND j.updated_at > NOW() - INTERVAL '24 hours'
      ORDER BY sa.platform, j.updated_at DESC
    `).catch(() => ({ rows: [] }));

    const organicMap = Object.fromEntries(
      organicByPlatform.rows.map((r) => [r.platform, r])
    );
    const postsMap = Object.fromEntries(
      postsByPlatform.rows.map((r) => [r.platform, r])
    );
    const commentsMap = Object.fromEntries(
      commentsByPlatform.rows.map((r) => [r.platform, r])
    );
    const jobsMap = Object.fromEntries(
      jobsByPlatform.rows.map((r) => [r.platform, r])
    );
    const errorMap = Object.fromEntries(
      lastErrors.rows.map((r) => [r.platform, r])
    );

    const later = (a, b) => {
      if (!a) return b || null;
      if (!b) return a;
      return new Date(a) >= new Date(b) ? a : b;
    };

    const rows = platforms.rows.map((p) => {
      const organic = organicMap[p.platform] || {};
      const posts = postsMap[p.platform] || {};
      const comments = commentsMap[p.platform] || {};
      const jobs = jobsMap[p.platform] || {};
      const err = errorMap[p.platform] || {};

      const todayPosted =
        (organic.today_posted || 0) +
        (posts.today_posted || 0) +
        (comments.today_posted || 0);
      const todayFailed =
        (organic.today_failed || 0) +
        (posts.today_failed || 0) +
        (comments.today_failed || 0);
      const lastSuccessAt = later(
        later(organic.last_success_at, posts.last_success_at),
        comments.last_success_at
      );
      const lastFailureAt = later(
        organic.last_failure_at,
        posts.last_failure_at
      );
      const jobsEnabled = jobs.jobs_enabled || 0;

      const status = this.derivePlatformStatus({
        jobsEnabled,
        todayPosted,
        todayFailed,
        lastSuccessAt,
        quietActive: quiet.active,
        organicEnabled,
      });

      return {
        platform: p.platform,
        accounts_total: p.accounts_total,
        accounts_active: p.accounts_active,
        jobs_enabled: jobsEnabled,
        jobs_total: jobs.jobs_total || 0,
        accounts_with_jobs: jobs.accounts_with_jobs || 0,
        running: jobs.running || 0,
        due_now: jobs.due_now || 0,
        in_cooldown: jobs.in_cooldown || 0,
        today_posted: todayPosted,
        today_failed: todayFailed,
        posted_24h: organic.posted_24h || 0,
        failed_24h: organic.failed_24h || 0,
        organic_today: {
          posted: organic.today_posted || 0,
          failed: organic.today_failed || 0,
        },
        posts_today: {
          posted: posts.today_posted || 0,
          failed: posts.today_failed || 0,
        },
        last_success_at: lastSuccessAt,
        last_failure_at: lastFailureAt,
        last_error: err.last_error || null,
        failure_class: err.failure_class || null,
        last_error_at: err.last_error_at || null,
        status,
      };
    });

    return {
      organic_enabled: organicEnabled,
      quiet_hours: quiet,
      platforms: rows,
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
    const quiet = this.quietHoursFromSettings(settings);

    return {
      organic: {
        enabled: !!settings.enabled,
        quiet_hours: quiet,
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

  /**
   * Account creation: created vs attempted (today + 24h) for NOC social category.
   */
  async getAccountCreationStats() {
    const empty = {
      today: { attempted: 0, created: 0, failed: 0, blocked: 0, skipped: 0, success_rate: 0 },
      last_24h: { attempted: 0, created: 0, failed: 0, blocked: 0, skipped: 0, success_rate: 0 },
      by_platform: [],
      recent: [],
    };

    const overview = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE)::int AS today_attempted,
        COUNT(*) FILTER (
          WHERE created_at::date = CURRENT_DATE AND status = 'created'
        )::int AS today_created,
        COUNT(*) FILTER (
          WHERE created_at::date = CURRENT_DATE AND status = 'attempt_failed'
        )::int AS today_failed,
        COUNT(*) FILTER (
          WHERE created_at::date = CURRENT_DATE AND status = 'blocked'
        )::int AS today_blocked,
        COUNT(*) FILTER (
          WHERE created_at::date = CURRENT_DATE AND status = 'skipped'
        )::int AS today_skipped,
        COUNT(*) FILTER (
          WHERE created_at > NOW() - INTERVAL '24 hours'
        )::int AS h24_attempted,
        COUNT(*) FILTER (
          WHERE created_at > NOW() - INTERVAL '24 hours' AND status = 'created'
        )::int AS h24_created,
        COUNT(*) FILTER (
          WHERE created_at > NOW() - INTERVAL '24 hours' AND status = 'attempt_failed'
        )::int AS h24_failed,
        COUNT(*) FILTER (
          WHERE created_at > NOW() - INTERVAL '24 hours' AND status = 'blocked'
        )::int AS h24_blocked,
        COUNT(*) FILTER (
          WHERE created_at > NOW() - INTERVAL '24 hours' AND status = 'skipped'
        )::int AS h24_skipped
      FROM account_creation_attempts
    `).catch(() => ({ rows: [{}] }));

    const byPlatform = await pool.query(`
      SELECT
        platform,
        COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE)::int AS today_attempted,
        COUNT(*) FILTER (
          WHERE created_at::date = CURRENT_DATE AND status = 'created'
        )::int AS today_created,
        COUNT(*) FILTER (
          WHERE created_at::date = CURRENT_DATE
            AND status IN ('attempt_failed', 'blocked', 'skipped')
        )::int AS today_failed,
        COUNT(*) FILTER (
          WHERE created_at > NOW() - INTERVAL '24 hours'
        )::int AS h24_attempted,
        COUNT(*) FILTER (
          WHERE created_at > NOW() - INTERVAL '24 hours' AND status = 'created'
        )::int AS h24_created,
        COUNT(*) FILTER (
          WHERE created_at > NOW() - INTERVAL '24 hours'
            AND status IN ('attempt_failed', 'blocked', 'skipped')
        )::int AS h24_failed,
        MAX(created_at) FILTER (WHERE status = 'created') AS last_created_at,
        MAX(created_at) AS last_attempt_at
      FROM account_creation_attempts
      GROUP BY platform
      ORDER BY today_attempted DESC, h24_attempted DESC, platform
    `).catch(() => ({ rows: [] }));

    // Also surface inventory (active accounts) so social category shows stock even with 0 attempts
    const inventory = await pool.query(`
      SELECT platform, COUNT(*) FILTER (WHERE status = 'active')::int AS active
      FROM social_accounts
      WHERE COALESCE(is_simulated, false) = false
      GROUP BY platform
    `).catch(() => ({ rows: [] }));
    const invMap = Object.fromEntries(inventory.rows.map((r) => [r.platform, r.active]));

    const o = overview.rows[0] || {};
    const rate = (created, attempted) =>
      attempted > 0 ? Math.round((created / attempted) * 1000) / 10 : 0;

    const today = {
      attempted: o.today_attempted || 0,
      created: o.today_created || 0,
      failed: o.today_failed || 0,
      blocked: o.today_blocked || 0,
      skipped: o.today_skipped || 0,
      success_rate: rate(o.today_created || 0, o.today_attempted || 0),
    };
    const last_24h = {
      attempted: o.h24_attempted || 0,
      created: o.h24_created || 0,
      failed: o.h24_failed || 0,
      blocked: o.h24_blocked || 0,
      skipped: o.h24_skipped || 0,
      success_rate: rate(o.h24_created || 0, o.h24_attempted || 0),
    };

    const known = ['reddit', 'x', 'instagram', 'tiktok', 'linkedin'];
    const platMap = Object.fromEntries(byPlatform.rows.map((r) => [r.platform, r]));
    const by_platform = known.map((platform) => {
      const row = platMap[platform] || {};
      const attempted = row.today_attempted || 0;
      const created = row.today_created || 0;
      return {
        platform,
        accounts_active: invMap[platform] || 0,
        today_attempted: attempted,
        today_created: created,
        today_failed: row.today_failed || 0,
        today_success_rate: rate(created, attempted),
        h24_attempted: row.h24_attempted || 0,
        h24_created: row.h24_created || 0,
        h24_failed: row.h24_failed || 0,
        h24_success_rate: rate(row.h24_created || 0, row.h24_attempted || 0),
        last_created_at: row.last_created_at || null,
        last_attempt_at: row.last_attempt_at || null,
      };
    });

    const recent = await pool.query(`
      SELECT
        id, platform, status, error_class, error_message,
        proxy_id, social_account_id, username, email, source, created_at
      FROM account_creation_attempts
      ORDER BY created_at DESC
      LIMIT 40
    `).catch(() => ({ rows: [] }));

    return {
      today,
      last_24h,
      by_platform,
      recent: recent.rows,
    };
  }

  /**
   * Stable hash → US city anchor for proxies without lat/lon.
   * Bright Data / ProxyBase rarely store exact geo; we place by id+zone.
   */
  proxyGeoAnchor(proxy) {
    const US_CITIES = [
      { city: 'New York', lat: 40.71, lon: -74.01 },
      { city: 'Los Angeles', lat: 34.05, lon: -118.24 },
      { city: 'Chicago', lat: 41.88, lon: -87.63 },
      { city: 'Houston', lat: 29.76, lon: -95.37 },
      { city: 'Phoenix', lat: 33.45, lon: -112.07 },
      { city: 'Philadelphia', lat: 39.95, lon: -75.17 },
      { city: 'San Antonio', lat: 29.42, lon: -98.49 },
      { city: 'San Diego', lat: 32.72, lon: -117.16 },
      { city: 'Dallas', lat: 32.78, lon: -96.8 },
      { city: 'San Jose', lat: 37.34, lon: -121.89 },
      { city: 'Austin', lat: 30.27, lon: -97.74 },
      { city: 'Jacksonville', lat: 30.33, lon: -81.66 },
      { city: 'Fort Worth', lat: 32.76, lon: -97.33 },
      { city: 'Columbus', lat: 39.96, lon: -82.99 },
      { city: 'Charlotte', lat: 35.23, lon: -80.84 },
      { city: 'Seattle', lat: 47.61, lon: -122.33 },
      { city: 'Denver', lat: 39.74, lon: -104.99 },
      { city: 'Washington', lat: 38.91, lon: -77.04 },
      { city: 'Boston', lat: 42.36, lon: -71.06 },
      { city: 'Nashville', lat: 36.16, lon: -86.78 },
      { city: 'Detroit', lat: 42.33, lon: -83.05 },
      { city: 'Portland', lat: 45.52, lon: -122.68 },
      { city: 'Las Vegas', lat: 36.17, lon: -115.14 },
      { city: 'Atlanta', lat: 33.75, lon: -84.39 },
      { city: 'Miami', lat: 25.76, lon: -80.19 },
    ];
    const key = `${proxy.id}:${proxy.zone || ''}:${proxy.sticky_id || ''}:${proxy.provider || ''}`;
    let h = 0;
    for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    const base = US_CITIES[h % US_CITIES.length];
    const jitterLat = ((h % 97) / 97 - 0.5) * 1.8;
    const jitterLon = (((h >> 8) % 89) / 89 - 0.5) * 2.4;
    return {
      city: base.city,
      lat: Math.round((base.lat + jitterLat) * 1000) / 1000,
      lon: Math.round((base.lon + jitterLon) * 1000) / 1000,
      approximated: true,
    };
  }

  async getGeoNodes() {
    const result = await pool.query(`
      SELECT
        p.id, p.name, p.provider, p.country, p.is_active,
        p.cooldown_until, p.consecutive_failures, p.failure_count, p.success_count,
        p.last_success_at, p.last_failure_at, p.last_used_at, p.last_health_ok,
        p.metadata->>'zone' AS zone,
        p.metadata->>'sticky_id' AS sticky_id,
        p.metadata->>'session_type' AS session_type,
        p.metadata->>'country' AS meta_country,
        sa.platform AS account_platform,
        sa.username AS account_username
      FROM proxies p
      LEFT JOIN social_account_proxies sap
        ON sap.proxy_id = p.id AND sap.is_active = true
      LEFT JOIN social_accounts sa ON sa.id = sap.social_account_id
      WHERE p.is_active = true
         OR p.last_used_at > NOW() - INTERVAL '3 days'
         OR (p.cooldown_until IS NOT NULL AND p.cooldown_until > NOW())
      ORDER BY p.last_used_at DESC NULLS LAST, p.id
      LIMIT 180
    `).catch(() => ({ rows: [] }));

    const byCountry = {};
    const byProvider = {};
    const nodes = result.rows.map((p) => {
      const cooled = p.cooldown_until && new Date(p.cooldown_until) > new Date();
      let status = 'healthy';
      if (!p.is_active) status = 'offline';
      else if (cooled) status = 'cooldown';
      else if (p.consecutive_failures >= 2 || p.last_health_ok === false) status = 'degraded';

      const country = (p.country || p.meta_country || 'US').toUpperCase();
      const anchor = this.proxyGeoAnchor(p);
      byCountry[country] = (byCountry[country] || 0) + 1;
      byProvider[p.provider || 'unknown'] = (byProvider[p.provider || 'unknown'] || 0) + 1;

      return {
        id: p.id,
        name: p.name,
        provider: p.provider,
        country,
        zone: p.zone || null,
        session_type: p.session_type || null,
        status,
        consecutive_failures: p.consecutive_failures || 0,
        last_success_at: p.last_success_at,
        last_failure_at: p.last_failure_at,
        account_platform: p.account_platform || null,
        account_username: p.account_username || null,
        ...anchor,
      };
    });

    return {
      nodes,
      by_country: Object.entries(byCountry).map(([country, count]) => ({ country, count })),
      by_provider: Object.entries(byProvider).map(([provider, count]) => ({ provider, count })),
    };
  }

  async getLiveEvents() {
    const [posts, jobFails, proxyEvents, createEvents] = await Promise.all([
      pool.query(`
        SELECT
          'post' AS kind,
          oc.status,
          sa.platform,
          sa.username,
          oc.subreddit AS target,
          LEFT(oc.content, 80) AS detail,
          oc.error,
          oc.created_at AS at
        FROM organic_comments oc
        JOIN social_accounts sa ON sa.id = oc.social_account_id
        WHERE oc.created_at > NOW() - INTERVAL '12 hours'
        ORDER BY oc.created_at DESC
        LIMIT 40
      `).catch(() => ({ rows: [] })),
      pool.query(`
        SELECT
          'job' AS kind,
          CASE WHEN j.cooldown_until > NOW() THEN 'cooldown' ELSE 'error' END AS status,
          sa.platform,
          sa.username,
          j.failure_class AS target,
          LEFT(j.last_error, 100) AS detail,
          j.last_error AS error,
          j.updated_at AS at
        FROM organic_comment_jobs j
        JOIN social_accounts sa ON sa.id = j.social_account_id
        WHERE j.last_error IS NOT NULL
          AND j.updated_at > NOW() - INTERVAL '12 hours'
        ORDER BY j.updated_at DESC
        LIMIT 25
      `).catch(() => ({ rows: [] })),
      pool.query(`
        SELECT
          'proxy' AS kind,
          CASE
            WHEN NOT is_active THEN 'offline'
            WHEN cooldown_until > NOW() THEN 'cooldown'
            ELSE 'degraded'
          END AS status,
          COALESCE(metadata->>'zone', provider) AS platform,
          name AS username,
          COALESCE(metadata->>'country', country, 'US') AS target,
          LEFT(last_error, 100) AS detail,
          last_error AS error,
          COALESCE(last_failure_at, cooldown_until, updated_at) AS at
        FROM proxies
        WHERE (last_failure_at > NOW() - INTERVAL '12 hours')
           OR (cooldown_until IS NOT NULL AND cooldown_until > NOW())
           OR (NOT is_active AND COALESCE(updated_at, last_failure_at) > NOW() - INTERVAL '12 hours')
        ORDER BY COALESCE(last_failure_at, cooldown_until, updated_at) DESC NULLS LAST
        LIMIT 25
      `).catch(() => ({ rows: [] })),
      pool.query(`
        SELECT
          'create' AS kind,
          CASE
            WHEN status = 'created' THEN 'created'
            WHEN status = 'blocked' THEN 'blocked'
            WHEN status = 'skipped' THEN 'skipped'
            ELSE 'attempt_failed'
          END AS status,
          platform,
          COALESCE(username, email, '—') AS username,
          COALESCE(error_class, status) AS target,
          LEFT(COALESCE(error_message, source, status), 100) AS detail,
          error_message AS error,
          created_at AS at
        FROM account_creation_attempts
        WHERE created_at > NOW() - INTERVAL '24 hours'
        ORDER BY created_at DESC
        LIMIT 40
      `).catch(() => ({ rows: [] })),
    ]);

    const events = [...posts.rows, ...jobFails.rows, ...proxyEvents.rows, ...createEvents.rows]
      .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0))
      .slice(0, 80);

    return { items: events };
  }

  buildFlowGraph({ proxies, accounts, posting, postingByPlatform, queue, accountCreation }) {
    const ov = proxies?.overview || {};
    const platforms = postingByPlatform?.platforms || [];
    const organic = posting?.organic || {};
    const todayPosted = platforms.reduce((s, p) => s + (p.today_posted || 0), 0);
    const todayFailed = platforms.reduce((s, p) => s + (p.today_failed || 0), 0);
    const attempts = todayPosted + todayFailed;
    const successRate = attempts > 0 ? Math.round((todayPosted / attempts) * 1000) / 10 : 100;
    const healthPct = ov.active
      ? Math.round(((ov.healthy || 0) / Math.max(1, ov.active)) * 1000) / 10
      : 0;

    const createToday = accountCreation?.today || {};

    const hubs = [
      {
        id: 'proxies',
        label: 'Proxies',
        count: ov.active || 0,
        sub: `${ov.in_cooldown || 0} cool · ${ov.degraded || 0} deg`,
        status: (ov.in_cooldown || 0) > 5 || (ov.error_rate || 0) > 40 ? 'bad'
          : (ov.degraded || 0) > 0 ? 'warn' : 'good',
      },
      {
        id: 'accounts',
        label: 'Accounts',
        count: (accounts?.by_platform || []).reduce((s, r) => s + (r.active || 0), 0),
        sub: `${organic.jobs?.enabled || 0} jobs on`,
        status: organic.enabled ? 'good' : 'warn',
      },
      ...platforms.map((p) => ({
        id: `plat:${p.platform}`,
        label: p.platform,
        count: p.today_posted || 0,
        sub: `${p.jobs_enabled || 0} jobs · ${p.today_failed || 0} fail`,
        status: p.status === 'healthy' ? 'good'
          : p.status === 'failing' ? 'bad'
            : p.status === 'quiet' ? 'warn' : 'idle',
        platform: p.platform,
        pulse: (p.today_posted || 0) > 0 || (p.running || 0) > 0,
      })),
    ];

    const links = [
      {
        from: 'proxies',
        to: 'accounts',
        weight: ov.assigned || 0,
        label: 'bound',
      },
      ...platforms.map((p) => ({
        from: 'accounts',
        to: `plat:${p.platform}`,
        weight: Math.max(p.jobs_enabled || 0, p.today_posted || 0, 1),
        label: p.platform,
        active: (p.running || 0) > 0 || (p.today_posted || 0) > 0,
      })),
    ];

    let queueDepth = Number(organic.jobs?.due_now || 0);
    if (queue && typeof queue === 'object' && queue.queues) {
      let sum = 0;
      for (const counts of Object.values(queue.queues)) {
        if (!counts || typeof counts !== 'object') continue;
        sum += Number(counts.waiting || 0) + Number(counts.delayed || 0) + Number(counts.active || 0);
      }
      if (sum > 0) queueDepth = sum;
    }

    return {
      hubs,
      links,
      gauges: {
        proxy_health_pct: healthPct,
        post_success_pct: successRate,
        error_rate_pct: ov.error_rate || 0,
        queue_depth: queueDepth,
        posted_today: todayPosted,
        failed_today: todayFailed,
        proxies_active: ov.active || 0,
        jobs_enabled: organic.jobs?.enabled || 0,
        creates_today: createToday.created || 0,
        create_attempts_today: createToday.attempted || 0,
        create_success_pct: createToday.success_rate || 0,
      },
    };
  }
}

module.exports = new NocService();
