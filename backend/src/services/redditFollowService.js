const pool = require('./db');
const playwrightService = require('./playwrightService');
const proxyService = require('./proxyService');
const { classifyFailure, cooldownUntil } = require('./failureClassifier');

/**
 * Reddit outbound follow campaign.
 * Note: Reddit has no standard follow-request inbox — accept_follows is unsupported.
 */
class RedditFollowService {
  async getSettings() {
    const result = await pool.query('SELECT * FROM reddit_follow_settings WHERE id = 1');
    if (result.rows[0]) return result.rows[0];
    const inserted = await pool.query(
      `INSERT INTO reddit_follow_settings (id, enabled)
       VALUES (1, false)
       ON CONFLICT (id) DO UPDATE SET updated_at = NOW()
       RETURNING *`
    );
    return inserted.rows[0];
  }

  async updateSettings(patch) {
    const current = await this.getSettings();
    const enabled = patch.enabled !== undefined ? !!patch.enabled : current.enabled;
    const min_per_day = patch.min_per_day ?? current.min_per_day;
    const max_per_day = patch.max_per_day ?? current.max_per_day;
    const quiet_hours_start = patch.quiet_hours_start ?? current.quiet_hours_start;
    const quiet_hours_end = patch.quiet_hours_end ?? current.quiet_hours_end;
    const max_concurrent = patch.max_concurrent ?? current.max_concurrent;

    if (min_per_day < 1 || max_per_day < min_per_day || max_per_day > 15) {
      throw new Error('min_per_day/max_per_day must satisfy 1 <= min <= max <= 15');
    }
    if (max_concurrent < 1 || max_concurrent > 5) {
      throw new Error('max_concurrent must be between 1 and 5');
    }

    const result = await pool.query(
      `UPDATE reddit_follow_settings
       SET enabled = $1,
           min_per_day = $2,
           max_per_day = $3,
           quiet_hours_start = $4,
           quiet_hours_end = $5,
           max_concurrent = $6,
           updated_at = NOW()
       WHERE id = 1
       RETURNING *`,
      [enabled, min_per_day, max_per_day, quiet_hours_start, quiet_hours_end, max_concurrent]
    );
    const settings = result.rows[0];

    if (
      patch.warm === true ||
      min_per_day > current.min_per_day ||
      max_per_day > current.max_per_day
    ) {
      await this.applyThroughputBoost(settings, { warm: true });
    }
    return settings;
  }

  async applyThroughputBoost(settings, { warm = true } = {}) {
    const min = settings.min_per_day || 2;
    const max = settings.max_per_day || 5;
    const jobs = await pool.query(
      `SELECT id, follows_today, daily_target, next_due_at
       FROM reddit_follow_jobs WHERE enabled = true`
    );
    for (const job of jobs.rows) {
      let target = this.rollDailyTarget(settings);
      if (warm && job.follows_today < max) {
        const floor = Math.max(min, job.follows_today + 1);
        const lo = Math.min(floor, max);
        target = lo + Math.floor(Math.random() * (max - lo + 1));
      }
      let nextDue = job.next_due_at;
      if (warm && job.follows_today < target) {
        nextDue = new Date(Date.now() + Math.floor(Math.random() * 20 * 60 * 1000));
      }
      await pool.query(
        `UPDATE reddit_follow_jobs
         SET daily_target = $2,
             next_due_at = $3,
             status = CASE WHEN status = 'error' THEN 'idle' ELSE status END,
             updated_at = NOW()
         WHERE id = $1`,
        [job.id, target, nextDue]
      );
    }
  }

  async ensureJob(accountId) {
    const existing = await pool.query(
      'SELECT * FROM reddit_follow_jobs WHERE social_account_id = $1',
      [accountId]
    );
    if (existing.rows[0]) return existing.rows[0];

    const settings = await this.getSettings();
    const target = this.rollDailyTarget(settings);
    const next = this.computeNextDue(settings, 0);

    const inserted = await pool.query(
      `INSERT INTO reddit_follow_jobs
         (social_account_id, enabled, next_due_at, follows_today, day_key, daily_target, status)
       VALUES ($1, true, $2, 0, CURRENT_DATE, $3, 'idle')
       ON CONFLICT (social_account_id) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [accountId, next, target]
    );
    return inserted.rows[0];
  }

  rollDailyTarget(settings) {
    const min = settings.min_per_day || 2;
    const max = settings.max_per_day || 5;
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

  computeNextDue(settings, followsToday = 0) {
    const now = new Date();
    const maxPerDay = settings.max_per_day || 5;
    const wakingHours = 14;
    const baseGapH = Math.max(0.75, (wakingHours / Math.max(maxPerDay, 1)) * 0.85);

    let gapMs = (baseGapH * 0.4 + Math.random() * baseGapH) * 60 * 60 * 1000;
    if (followsToday === 0) {
      gapMs = Math.random() * Math.min(1.2, baseGapH) * 60 * 60 * 1000;
    }

    let due = new Date(now.getTime() + gapMs);
    let guard = 0;
    while (this.inQuietHours(settings, due) && guard < 24) {
      due = new Date(due.getTime() + 60 * 60 * 1000);
      guard += 1;
    }
    return due;
  }

  async refreshDayState(job, settings) {
    const today = new Date().toISOString().slice(0, 10);
    const dayKey = job.day_key ? new Date(job.day_key).toISOString().slice(0, 10) : null;
    if (dayKey === today && job.daily_target) return job;

    const target = this.rollDailyTarget(settings);
    const next = this.computeNextDue(settings, 0);
    const result = await pool.query(
      `UPDATE reddit_follow_jobs
       SET day_key = CURRENT_DATE,
           follows_today = 0,
           daily_target = $2,
           next_due_at = $3,
           status = 'idle',
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [job.id, target, next]
    );
    return result.rows[0];
  }

  async listEligibleAccounts() {
    const result = await pool.query(
      `SELECT sa.*
       FROM social_accounts sa
       LEFT JOIN reddit_follow_jobs j ON j.social_account_id = sa.id
       WHERE lower(sa.platform) = 'reddit'
         AND COALESCE(sa.is_simulated, false) = false
         AND sa.status = 'active'
         AND lower(sa.status) NOT IN ('banned', 'disabled')
         AND (j.cooldown_until IS NULL OR j.cooldown_until <= NOW())
         AND COALESCE(j.failure_class, '') NOT IN ('bad_credentials', 'banned', 'session_dead')
         AND EXISTS (
           SELECT 1 FROM social_account_proxies sap
           JOIN proxies p ON p.id = sap.proxy_id
           WHERE sap.social_account_id = sa.id AND sap.is_active = true
             AND p.is_active = true
             AND p.provider = 'ProxyBase'
             AND (p.cooldown_until IS NULL OR p.cooldown_until <= NOW())
         )
       ORDER BY sa.id`
    );
    return result.rows;
  }

  async insertDiscoveredTargets(targets, { category = 'discovered', priority = 80 } = {}) {
    const junk = new Set([
      'home', 'popular', 'all', 'login', 'register', 'submit', 'settings',
      'message', 'messages', 'chat', 'notification', 'notifications', 'premium',
      'coins', 'wiki', 'mod', 'moderators', 'about', 'rules', 'search',
    ]);
    let inserted = 0;
    for (const t of targets || []) {
      const handle = String(t.handle || t.username || '').replace(/^u\//i, '').trim();
      if (!handle || handle.length < 2 || handle.length > 30) continue;
      if (junk.has(handle.toLowerCase())) continue;
      if (!/^[A-Za-z0-9_-]+$/.test(handle)) continue;
      const cat = String(t.category || category).slice(0, 50);
      const notes = t.source ? `source=${t.source}` : null;
      const result = await pool.query(
        `INSERT INTO reddit_follow_targets (handle, category, enabled, priority, notes)
         VALUES ($1, $2, true, $3, $4)
         ON CONFLICT (handle) DO NOTHING
         RETURNING id`,
        [handle, cat, priority, notes]
      );
      if (result.rowCount) inserted += 1;
    }
    return inserted;
  }

  async discoverTargetsForAccount(account, { limit = 12 } = {}) {
    const organicDiscoveryService = require('./organicDiscoveryService');
    const subs = await organicDiscoveryService.getSubsForAccount(account);
    const pick = (subs || []).slice(0, 3);
    const result = await playwrightService.discoverRedditFollowTargets(account.id, {
      subreddits: pick,
      limit,
      requireProxy: true,
    });
    const inserted = await this.insertDiscoveredTargets(result.targets || [], {
      category: 'discovered',
      priority: 75,
    });
    await pool.query(
      `UPDATE reddit_follow_jobs
       SET last_discover_at = NOW(), updated_at = NOW()
       WHERE social_account_id = $1`,
      [account.id]
    ).catch(() => {});
    return {
      success: true,
      accountId: account.id,
      subreddits: pick,
      found: (result.targets || []).length,
      inserted,
      sample: (result.targets || []).slice(0, 5).map((t) => t.handle),
    };
  }

  /**
   * Reddit has no standard follow-request inbox for normal accounts.
   * Kept as a no-op so AccountOpsBrain action names stay symmetric with X.
   */
  async acceptFollowsForAccount(account) {
    return {
      success: true,
      accountId: account.id,
      accepted: 0,
      empty: true,
      supported: false,
      note: 'Reddit has no follow-request acceptance UX for standard accounts — outbound only',
    };
  }

  async pickTarget(accountId) {
    const result = await pool.query(
      `SELECT t.*
       FROM reddit_follow_targets t
       WHERE t.enabled = true
         AND NOT EXISTS (
           SELECT 1 FROM reddit_follows f
           WHERE f.social_account_id = $1
             AND lower(f.handle) = lower(t.handle)
         )
       ORDER BY
         t.priority ASC,
         (SELECT COUNT(*) FROM reddit_follows f2 WHERE lower(f2.handle) = lower(t.handle)) ASC,
         random()
       LIMIT 1`,
      [accountId]
    );
    return result.rows[0] || null;
  }

  async softSkipJob(job, reason, mins = null) {
    const softMins = mins != null ? mins : 15 + Math.floor(Math.random() * 16);
    const next = new Date(Date.now() + softMins * 60 * 1000);
    await pool.query(
      `UPDATE reddit_follow_jobs
       SET status = 'idle', last_error = $2, next_due_at = $3, updated_at = NOW()
       WHERE id = $1`,
      [job.id, String(reason).slice(0, 1000), next]
    );
    return { skipped: true, reason: 'soft_skip', error: reason, next_due_at: next };
  }

  async applyFailureQuarantine(job, errorMessage) {
    const failureClass = classifyFailure(errorMessage);
    const consecutive = (job.consecutive_failures || 0) + 1;
    const until = cooldownUntil(failureClass, consecutive);
    const disable =
      failureClass === 'bad_credentials' ||
      failureClass === 'session_dead' ||
      failureClass === 'banned';

    // Tunnel / proxy flakes: soft-skip, do not long-quarantine.
    if (failureClass === 'proxy_error') {
      return this.softSkipJob(job, errorMessage);
    }

    if (failureClass === 'banned') {
      try {
        const organicCommentService = require('./organicCommentService');
        await organicCommentService.markBannedAccount(job.social_account_id, errorMessage);
      } catch (e) {
        console.warn('Reddit follow markBanned failed:', e.message);
      }
    }
    if (failureClass === 'session_dead') {
      try {
        const organicCommentService = require('./organicCommentService');
        await organicCommentService.markDeadSessionAccount(job.social_account_id, errorMessage);
      } catch (e) {
        console.warn('Reddit follow markDeadSession failed:', e.message);
      }
    }

    await pool.query(
      `UPDATE reddit_follow_jobs
       SET status = 'error',
           last_error = $2,
           failure_class = $3,
           consecutive_failures = $4,
           cooldown_until = $5,
           next_due_at = $5,
           enabled = CASE WHEN $6 THEN false ELSE enabled END,
           updated_at = NOW()
       WHERE id = $1`,
      [job.id, errorMessage, failureClass, consecutive, until, disable]
    );

    console.warn(
      `Reddit follow job ${job.social_account_id} quarantined as ${failureClass} until ${until.toISOString()}` +
        (disable ? ' — disabled' : '')
    );
    return { failureClass, consecutive, until, disable };
  }

  async getDashboard() {
    const settings = await this.getSettings();
    const jobs = await pool.query(
      `SELECT j.*, sa.username, sa.status AS account_status
       FROM reddit_follow_jobs j
       JOIN social_accounts sa ON sa.id = j.social_account_id
       ORDER BY j.next_due_at NULLS LAST`
    );
    const recent = await pool.query(
      `SELECT rf.*, sa.username
       FROM reddit_follows rf
       JOIN social_accounts sa ON sa.id = rf.social_account_id
       ORDER BY rf.created_at DESC
       LIMIT 200`
    );
    const todayStats = await pool.query(
      `SELECT COUNT(*)::int AS followed_today
       FROM reddit_follows
       WHERE status IN ('followed', 'already') AND created_at::date = CURRENT_DATE`
    );
    const targets = await pool.query(
      `SELECT category, COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE enabled)::int AS enabled
       FROM reddit_follow_targets
       GROUP BY category
       ORDER BY category`
    );
    const remaining = await pool.query(
      `SELECT COUNT(*)::int AS n FROM reddit_follow_targets WHERE enabled = true`
    );

    return {
      settings,
      jobs: jobs.rows,
      recent: recent.rows,
      followed_today: todayStats.rows[0]?.followed_today || 0,
      targets_by_category: targets.rows,
      targets_enabled: remaining.rows[0]?.n || 0,
    };
  }

  async setAccountEnabled(accountId, enabled) {
    await this.ensureJob(accountId);
    const result = await pool.query(
      `UPDATE reddit_follow_jobs
       SET enabled = $2, updated_at = NOW()
       WHERE social_account_id = $1
       RETURNING *`,
      [accountId, !!enabled]
    );
    return result.rows[0];
  }

  async ensureJobsForEligible() {
    const accounts = await this.listEligibleAccounts();
    for (const account of accounts) {
      await this.ensureJob(account.id);
    }
    return accounts.length;
  }

  async runOneForAccount(account, { dryRun = false } = {}) {
    const settings = await this.getSettings();
    let job = await this.ensureJob(account.id);
    job = await this.refreshDayState(job, settings);

    if (!job.enabled) return { skipped: true, reason: 'account_disabled' };
    if (job.cooldown_until && new Date(job.cooldown_until) > new Date()) {
      return { skipped: true, reason: 'cooldown', until: job.cooldown_until, class: job.failure_class };
    }
    if (job.failure_class === 'bad_credentials' || job.failure_class === 'banned') {
      return { skipped: true, reason: job.failure_class };
    }
    if (job.follows_today >= (job.daily_target || settings.max_per_day)) {
      return { skipped: true, reason: 'daily_cap' };
    }
    if (job.next_due_at && new Date(job.next_due_at) > new Date()) {
      return { skipped: true, reason: 'not_due' };
    }
    if (this.inQuietHours(settings)) {
      const next = this.computeNextDue(settings, job.follows_today);
      await pool.query(
        `UPDATE reddit_follow_jobs SET next_due_at = $2, status = 'idle', updated_at = NOW() WHERE id = $1`,
        [job.id, next]
      );
      return { skipped: true, reason: 'quiet_hours' };
    }

    const target = await this.pickTarget(account.id);
    if (!target) {
      await pool.query(
        `UPDATE reddit_follow_jobs
         SET status = 'idle', last_error = 'no_targets', next_due_at = NOW() + INTERVAL '2 hours', updated_at = NOW()
         WHERE id = $1`,
        [job.id]
      );
      return { skipped: true, reason: 'no_targets' };
    }

    await pool.query(
      `UPDATE reddit_follow_jobs SET status = 'running', last_error = NULL, updated_at = NOW() WHERE id = $1`,
      [job.id]
    );

    const proxies = await proxyService.getAccountProxies(account.id, true);
    if (proxies.length !== 1) {
      const msg =
        proxies.length === 0
          ? 'No dedicated proxy assigned (or proxy in cooldown)'
          : 'Account has multiple active proxies; enforce 1:1';
      await this.applyFailureQuarantine(job, msg);
      return { skipped: true, reason: 'proxy', error: msg };
    }

    try {
      let followResult = {
        followed: false,
        alreadyFollowing: false,
        profileUrl: `https://www.reddit.com/user/${target.handle}/`,
      };

      if (!dryRun) {
        followResult = await playwrightService.followRedditUser(account.id, target.handle, {
          requireProxy: true,
          allowLogin: true,
        });
      } else {
        followResult = {
          followed: true,
          alreadyFollowing: false,
          profileUrl: `https://www.reddit.com/user/${target.handle}/`,
          dryRun: true,
        };
      }

      const status = followResult.alreadyFollowing ? 'already' : 'followed';

      const insertedFollow = await pool.query(
        `INSERT INTO reddit_follows
           (social_account_id, proxy_id, handle, category, status, profile_url)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (social_account_id, handle) DO UPDATE
           SET status = EXCLUDED.status,
               proxy_id = EXCLUDED.proxy_id,
               error = NULL
         RETURNING *`,
        [
          account.id,
          proxies[0].id,
          target.handle,
          target.category,
          status,
          followResult.profileUrl || `https://www.reddit.com/user/${target.handle}/`,
        ]
      );

      const followsToday = job.follows_today + 1;
      const next = this.computeNextDue(settings, followsToday);
      await pool.query(
        `UPDATE reddit_follow_jobs
         SET follows_today = $2,
             next_due_at = $3,
             status = 'idle',
             consecutive_failures = 0,
             failure_class = NULL,
             cooldown_until = NULL,
             last_error = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [job.id, followsToday, next]
      );

      const followRow = insertedFollow.rows[0];
      const followLink =
        followResult.profileUrl || `https://www.reddit.com/user/${target.handle}/`;
      try {
        const activityEventService = require('./activityEventService');
        activityEventService
          .logFollow({
            account,
            platform: 'reddit',
            row: followRow,
            handle: target.handle,
            profileUrl: followLink,
          })
          .catch(() => {});
      } catch (_) {
        /* ignore */
      }

      return {
        success: true,
        accountId: account.id,
        handle: target.handle,
        category: target.category,
        status,
        followsToday,
        nextDue: next,
        link: followLink,
      };
    } catch (error) {
      const msg = error.message || String(error);
      if (
        /err_tunnel|err_timed_out|err_proxy|tunnel_connection|net::err_|proxy|has been closed|Target closed|browser.*closed|Follow button not found/i.test(
          msg
        ) &&
        !/banned|suspended|locked|session_dead|bad_credentials/i.test(msg)
      ) {
        if (/Follow button not found/i.test(msg)) {
          await pool.query(
            `UPDATE reddit_follow_targets SET enabled = false, notes = COALESCE(notes,'') || ' | no_follow_button'
             WHERE lower(handle) = lower($1)`,
            [target.handle]
          ).catch(() => {});
        }
        const soft = await this.softSkipJob(job, msg);
        return { ...soft, accountId: account.id, handle: target.handle };
      }

      await this.applyFailureQuarantine(job, msg);
      await pool.query(
        `INSERT INTO reddit_follows
           (social_account_id, proxy_id, handle, category, status, profile_url, error)
         VALUES ($1,$2,$3,$4,'error',$5,$6)
         ON CONFLICT (social_account_id, handle) DO UPDATE
           SET status = 'error', error = EXCLUDED.error`,
        [
          account.id,
          proxies[0]?.id || null,
          target.handle,
          target.category,
          `https://www.reddit.com/user/${target.handle}/`,
          msg,
        ]
      ).catch(() => {});
      return { success: false, accountId: account.id, handle: target.handle, error: msg };
    }
  }
}

module.exports = new RedditFollowService();
