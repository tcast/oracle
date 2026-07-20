const pool = require('./db');
const playwrightService = require('./playwrightService');
const proxyService = require('./proxyService');
const { classifyFailure, cooldownUntil } = require('./failureClassifier');

const PLATFORMS = ['instagram', 'tiktok'];

class SocialWarmService {
  async getSettings(platform) {
    if (!PLATFORMS.includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
    const result = await pool.query(
      'SELECT * FROM social_warm_settings WHERE platform = $1',
      [platform]
    );
    if (result.rows[0]) return result.rows[0];
    const inserted = await pool.query(
      `INSERT INTO social_warm_settings (platform, enabled)
       VALUES ($1, false)
       ON CONFLICT (platform) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [platform]
    );
    return inserted.rows[0];
  }

  async updateSettings(platform, patch) {
    const current = await this.getSettings(platform);
    const enabled = patch.enabled !== undefined ? !!patch.enabled : current.enabled;
    const min_per_day = patch.min_per_day ?? current.min_per_day;
    const max_per_day = patch.max_per_day ?? current.max_per_day;
    const quiet_hours_start = patch.quiet_hours_start ?? current.quiet_hours_start;
    const quiet_hours_end = patch.quiet_hours_end ?? current.quiet_hours_end;
    const max_concurrent = patch.max_concurrent ?? current.max_concurrent;
    const do_follow = patch.do_follow !== undefined ? !!patch.do_follow : current.do_follow;
    const do_like = patch.do_like !== undefined ? !!patch.do_like : current.do_like;

    if (min_per_day < 1 || max_per_day < min_per_day || max_per_day > 12) {
      throw new Error('min_per_day/max_per_day must satisfy 1 <= min <= max <= 12');
    }

    const result = await pool.query(
      `UPDATE social_warm_settings
       SET enabled = $2,
           min_per_day = $3,
           max_per_day = $4,
           quiet_hours_start = $5,
           quiet_hours_end = $6,
           max_concurrent = $7,
           do_follow = $8,
           do_like = $9,
           updated_at = NOW()
       WHERE platform = $1
       RETURNING *`,
      [
        platform,
        enabled,
        min_per_day,
        max_per_day,
        quiet_hours_start,
        quiet_hours_end,
        max_concurrent,
        do_follow,
        do_like,
      ]
    );
    const settings = result.rows[0];
    if (patch.warm === true || enabled) {
      await this.applyThroughputBoost(platform, settings, { warm: true });
    }
    return settings;
  }

  async applyThroughputBoost(platform, settings, { warm = true } = {}) {
    const jobs = await pool.query(
      `SELECT j.id, j.actions_today, j.daily_target, j.next_due_at
       FROM social_warm_jobs j
       JOIN social_accounts sa ON sa.id = j.social_account_id
       WHERE j.enabled = true AND sa.platform = $1`,
      [platform]
    );
    const min = settings.min_per_day || 2;
    const max = settings.max_per_day || 4;
    for (const job of jobs.rows) {
      let target = this.rollDailyTarget(settings);
      if (warm && job.actions_today < max) {
        const floor = Math.max(min, job.actions_today + 1);
        const lo = Math.min(floor, max);
        target = lo + Math.floor(Math.random() * (max - lo + 1));
      }
      let nextDue = job.next_due_at;
      if (warm && job.actions_today < target) {
        nextDue = new Date(Date.now() + Math.floor(Math.random() * 25 * 60 * 1000));
      }
      await pool.query(
        `UPDATE social_warm_jobs
         SET daily_target = $2, next_due_at = $3,
             status = CASE WHEN status = 'error' THEN 'idle' ELSE status END,
             updated_at = NOW()
         WHERE id = $1`,
        [job.id, target, nextDue]
      );
    }
  }

  rollDailyTarget(settings) {
    const min = settings.min_per_day || 2;
    const max = settings.max_per_day || 4;
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  inQuietHours(settings, date = new Date()) {
    const hour = date.getHours();
    const start = settings.quiet_hours_start ?? 1;
    const end = settings.quiet_hours_end ?? 8;
    if (start === end) return false;
    if (start < end) return hour >= start && hour < end;
    return hour >= start || hour < end;
  }

  computeNextDue(settings, actionsToday = 0) {
    const now = new Date();
    const maxPerDay = settings.max_per_day || 4;
    const baseGapH = Math.max(1, (14 / Math.max(maxPerDay, 1)) * 0.9);
    let gapMs = (baseGapH * 0.4 + Math.random() * baseGapH) * 60 * 60 * 1000;
    if (actionsToday === 0) gapMs = Math.random() * Math.min(1.5, baseGapH) * 60 * 60 * 1000;
    let due = new Date(now.getTime() + gapMs);
    let guard = 0;
    while (this.inQuietHours(settings, due) && guard < 24) {
      due = new Date(due.getTime() + 60 * 60 * 1000);
      guard += 1;
    }
    return due;
  }

  async ensureJob(accountId) {
    const existing = await pool.query(
      'SELECT * FROM social_warm_jobs WHERE social_account_id = $1',
      [accountId]
    );
    if (existing.rows[0]) return existing.rows[0];

    const acc = await pool.query('SELECT platform FROM social_accounts WHERE id = $1', [accountId]);
    const platform = acc.rows[0]?.platform;
    const settings = await this.getSettings(platform);
    const target = this.rollDailyTarget(settings);
    const next = this.computeNextDue(settings, 0);
    const inserted = await pool.query(
      `INSERT INTO social_warm_jobs
         (social_account_id, enabled, next_due_at, actions_today, day_key, daily_target, status)
       VALUES ($1, true, $2, 0, CURRENT_DATE, $3, 'idle')
       ON CONFLICT (social_account_id) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [accountId, next, target]
    );
    return inserted.rows[0];
  }

  async refreshDayState(job, settings) {
    const today = new Date().toISOString().slice(0, 10);
    const dayKey = job.day_key ? new Date(job.day_key).toISOString().slice(0, 10) : null;
    if (dayKey === today && job.daily_target) return job;
    const target = this.rollDailyTarget(settings);
    const next = this.computeNextDue(settings, 0);
    const result = await pool.query(
      `UPDATE social_warm_jobs
       SET day_key = CURRENT_DATE, actions_today = 0, daily_target = $2,
           next_due_at = $3, status = 'idle', updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [job.id, target, next]
    );
    return result.rows[0];
  }

  async listEligibleAccounts(platform) {
    const result = await pool.query(
      `SELECT sa.*
       FROM social_accounts sa
       LEFT JOIN social_warm_jobs j ON j.social_account_id = sa.id
       WHERE sa.platform = $1
         AND COALESCE(sa.is_simulated, false) = false
         AND sa.status = 'active'
         AND lower(sa.status) NOT IN ('banned', 'disabled')
         AND COALESCE(sa.credentials->>'password', '') NOT IN ('', 'default_password')
         AND (j.cooldown_until IS NULL OR j.cooldown_until <= NOW())
         AND COALESCE(j.failure_class, '') NOT IN ('bad_credentials')
         AND (
           sa.platform = 'tiktok'
           OR EXISTS (
             SELECT 1 FROM social_account_proxies sap
             JOIN proxies p ON p.id = sap.proxy_id
             WHERE sap.social_account_id = sa.id AND sap.is_active = true
               AND p.is_active = true
               AND (p.cooldown_until IS NULL OR p.cooldown_until <= NOW())
           )
         )
       ORDER BY sa.id`,
      [platform]
    );
    return result.rows;
  }

  async pickTarget(accountId, platform) {
    const result = await pool.query(
      `SELECT t.*
       FROM social_warm_targets t
       WHERE t.platform = $2 AND t.enabled = true
         AND NOT EXISTS (
           SELECT 1 FROM social_warm_actions a
           WHERE a.social_account_id = $1
             AND a.action_type = 'follow'
             AND a.status IN ('followed', 'already')
             AND lower(a.handle) = lower(t.handle)
         )
       ORDER BY t.priority ASC, random()
       LIMIT 1`,
      [accountId, platform]
    );
    return result.rows[0] || null;
  }

  async applyFailureQuarantine(job, errorMessage) {
    const failureClass = classifyFailure(errorMessage);
    const consecutive = (job.consecutive_failures || 0) + 1;
    const until = cooldownUntil(failureClass, consecutive);
    const disable = failureClass === 'bad_credentials';
    await pool.query(
      `UPDATE social_warm_jobs
       SET status = 'error', last_error = $2, failure_class = $3,
           consecutive_failures = $4, cooldown_until = $5, next_due_at = $5,
           enabled = CASE WHEN $6 THEN false ELSE enabled END,
           updated_at = NOW()
       WHERE id = $1`,
      [job.id, errorMessage, failureClass, consecutive, until, disable]
    );
    return { failureClass, until };
  }

  async ensureJobsForPlatform(platform) {
    const accounts = await this.listEligibleAccounts(platform);
    for (const a of accounts) await this.ensureJob(a.id);
    return accounts.length;
  }

  async getDashboard(platform = null) {
    const platforms = platform ? [platform] : PLATFORMS;
    const settings = {};
    for (const p of platforms) settings[p] = await this.getSettings(p);

    const jobs = await pool.query(
      `SELECT j.*, sa.username, sa.platform, sa.status AS account_status, sa.warmup_status
       FROM social_warm_jobs j
       JOIN social_accounts sa ON sa.id = j.social_account_id
       WHERE sa.platform = ANY($1::text[])
       ORDER BY sa.platform, j.next_due_at NULLS LAST`,
      [platforms]
    );
    const recent = await pool.query(
      `SELECT a.*, sa.username
       FROM social_warm_actions a
       JOIN social_accounts sa ON sa.id = a.social_account_id
       WHERE a.platform = ANY($1::text[])
       ORDER BY a.created_at DESC
       LIMIT 200`,
      [platforms]
    );
    const today = await pool.query(
      `SELECT platform, COUNT(*)::int AS n
       FROM social_warm_actions
       WHERE created_at::date = CURRENT_DATE AND status NOT IN ('error')
       GROUP BY platform`
    );
    const targets = await pool.query(
      `SELECT platform, category, COUNT(*)::int AS n
       FROM social_warm_targets WHERE enabled
       GROUP BY 1, 2 ORDER BY 1, 2`
    );

    return {
      settings,
      jobs: jobs.rows,
      recent: recent.rows,
      today_by_platform: today.rows,
      targets_by_category: targets.rows,
    };
  }

  async runOneForAccount(account, { dryRun = false } = {}) {
    const platform = account.platform;
    const settings = await this.getSettings(platform);
    let job = await this.ensureJob(account.id);
    job = await this.refreshDayState(job, settings);

    if (!job.enabled) return { skipped: true, reason: 'account_disabled' };
    if (job.cooldown_until && new Date(job.cooldown_until) > new Date()) {
      return { skipped: true, reason: 'cooldown' };
    }
    if (job.actions_today >= (job.daily_target || settings.max_per_day)) {
      return { skipped: true, reason: 'daily_cap' };
    }
    if (job.next_due_at && new Date(job.next_due_at) > new Date()) {
      return { skipped: true, reason: 'not_due' };
    }
    if (this.inQuietHours(settings)) {
      const next = this.computeNextDue(settings, job.actions_today);
      await pool.query(
        `UPDATE social_warm_jobs SET next_due_at = $2, status = 'idle', updated_at = NOW() WHERE id = $1`,
        [job.id, next]
      );
      return { skipped: true, reason: 'quiet_hours' };
    }

    const target = settings.do_follow ? await this.pickTarget(account.id, platform) : null;
    if (settings.do_follow && !target) {
      await pool.query(
        `UPDATE social_warm_jobs
         SET status = 'idle', last_error = 'no_targets',
             next_due_at = NOW() + INTERVAL '6 hours', updated_at = NOW()
         WHERE id = $1`,
        [job.id]
      );
      return { skipped: true, reason: 'no_targets' };
    }

    await pool.query(
      `UPDATE social_warm_jobs SET status = 'running', last_error = NULL, updated_at = NOW() WHERE id = $1`,
      [job.id]
    );

    let proxyId = null;
    if (platform !== 'tiktok') {
      const proxies = await proxyService.getAccountProxies(account.id, true);
      if (proxies.length !== 1) {
        const msg = proxies.length === 0 ? 'No dedicated proxy' : 'Multiple proxies';
        await this.applyFailureQuarantine(job, msg);
        return { skipped: true, reason: 'proxy', error: msg };
      }
      proxyId = proxies[0].id;
    }

    try {
      let result = { browsed: true, follow: null, like: null };
      if (!dryRun) {
        result = await playwrightService.runSocialWarmAction(account.id, {
          handle: target?.handle || null,
          doFollow: !!settings.do_follow && !!target,
          doLike: !!settings.do_like,
        });
      }

      const followStatus = result.follow?.alreadyFollowing
        ? 'already'
        : result.follow?.followed
          ? 'followed'
          : null;

      if (followStatus) {
        await pool.query(
          `INSERT INTO social_warm_actions
             (social_account_id, platform, proxy_id, handle, category, action_type, status, detail)
           VALUES ($1,$2,$3,$4,$5,'follow',$6,$7::jsonb)`,
          [
            account.id,
            platform,
            proxyId,
            target.handle,
            target.category,
            followStatus,
            JSON.stringify(result.follow || {}),
          ]
        ).catch(() => {});
      }

      await pool.query(
        `INSERT INTO social_warm_actions
           (social_account_id, platform, proxy_id, handle, category, action_type, status, detail)
         VALUES ($1,$2,$3,$4,$5,'warm','ok',$6::jsonb)`,
        [
          account.id,
          platform,
          proxyId,
          target?.handle || null,
          target?.category || null,
          JSON.stringify({
            browsed: result.browsed,
            like: result.like,
            follow: followStatus,
          }),
        ]
      );

      const actionsToday = job.actions_today + 1;
      const next = this.computeNextDue(settings, actionsToday);
      await pool.query(
        `UPDATE social_warm_jobs
         SET actions_today = $2, next_due_at = $3, status = 'idle',
             consecutive_failures = 0, failure_class = NULL, cooldown_until = NULL,
             last_error = NULL, updated_at = NOW()
         WHERE id = $1`,
        [job.id, actionsToday, next]
      );

      return {
        success: true,
        accountId: account.id,
        platform,
        handle: target?.handle || null,
        followStatus,
        like: result.like,
        actionsToday,
        nextDue: next,
      };
    } catch (error) {
      const msg = error.message || String(error);
      await this.applyFailureQuarantine(job, msg);
      await pool.query(
        `INSERT INTO social_warm_actions
           (social_account_id, platform, proxy_id, handle, category, action_type, status, error)
         VALUES ($1,$2,$3,$4,$5,'warm','error',$6)`,
        [account.id, platform, proxyId, target?.handle || null, target?.category || null, msg]
      ).catch(() => {});
      return { success: false, accountId: account.id, platform, error: msg };
    }
  }
}

module.exports = new SocialWarmService();
