const pool = require('./db');
const playwrightService = require('./playwrightService');
const proxyService = require('./proxyService');
const { classifyFailure, cooldownUntil } = require('./failureClassifier');

class XFollowService {
  async getSettings() {
    const result = await pool.query('SELECT * FROM x_follow_settings WHERE id = 1');
    if (result.rows[0]) return result.rows[0];
    const inserted = await pool.query(
      `INSERT INTO x_follow_settings (id, enabled)
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
      `UPDATE x_follow_settings
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
       FROM x_follow_jobs WHERE enabled = true`
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
        `UPDATE x_follow_jobs
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
      'SELECT * FROM x_follow_jobs WHERE social_account_id = $1',
      [accountId]
    );
    if (existing.rows[0]) return existing.rows[0];

    const settings = await this.getSettings();
    const target = this.rollDailyTarget(settings);
    const next = this.computeNextDue(settings, 0);

    const inserted = await pool.query(
      `INSERT INTO x_follow_jobs
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
      `UPDATE x_follow_jobs
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

  /** Max age of a persisted X session before we refuse password re-login for follows. */
  static SESSION_MAX_AGE_HOURS = 72;

  async getLiveSession(accountId) {
    const result = await pool.query(
      `SELECT updated_at, created_at,
              CASE WHEN cookies IS NULL THEN 0 ELSE jsonb_array_length(cookies) END AS cookie_count
       FROM browser_sessions
       WHERE account_id = $1 AND platform = 'x'
       ORDER BY updated_at DESC
       LIMIT 1`,
      [accountId]
    );
    return result.rows[0] || null;
  }

  sessionIsFresh(session, maxAgeHours = XFollowService.SESSION_MAX_AGE_HOURS) {
    if (!session || !session.updated_at) return false;
    if ((session.cookie_count || 0) < 1) return false;
    const ageMs = Date.now() - new Date(session.updated_at).getTime();
    return ageMs <= maxAgeHours * 60 * 60 * 1000;
  }

  async listEligibleAccounts() {
    // Cookie-only path: live session + proxy required; password NOT required.
    const result = await pool.query(
      `SELECT sa.*
       FROM social_accounts sa
       LEFT JOIN x_follow_jobs j ON j.social_account_id = sa.id
       WHERE sa.platform = 'x'
         AND COALESCE(sa.is_simulated, false) = false
         AND sa.status = 'active'
         AND (j.cooldown_until IS NULL OR j.cooldown_until <= NOW())
         AND COALESCE(j.failure_class, '') NOT IN ('bad_credentials', 'banned')
         AND EXISTS (
           SELECT 1 FROM social_account_proxies sap
           JOIN proxies p ON p.id = sap.proxy_id
           WHERE sap.social_account_id = sa.id AND sap.is_active = true
             AND p.is_active = true
             AND (p.cooldown_until IS NULL OR p.cooldown_until <= NOW())
         )
         -- Require a recent persisted session; never enroll dead cookies into follow ticks
         AND EXISTS (
           SELECT 1 FROM browser_sessions bs
           WHERE bs.account_id = sa.id AND bs.platform = 'x'
             AND bs.cookies IS NOT NULL
             AND jsonb_array_length(bs.cookies) > 0
             AND bs.updated_at > NOW() - INTERVAL '${XFollowService.SESSION_MAX_AGE_HOURS} hours'
         )
       ORDER BY sa.id`
    );
    return result.rows;
  }

  /** Topic keywords for people-search discovery (persona + packs). */
  getDiscoveryKeywords(account) {
    const { X_TOPIC_PACKS } = require('./organicDiscoveryService');
    const packs = X_TOPIC_PACKS || {};
    const keywords = [];
    let traits = account.persona_traits;
    if (typeof traits === 'string') {
      try { traits = JSON.parse(traits); } catch { traits = {}; }
    }
    traits = traits || {};
    const creds = account.credentials && typeof account.credentials === 'object'
      ? account.credentials
      : {};
    const xp = creds.x_persona && typeof creds.x_persona === 'object' ? creds.x_persona : {};

    for (const exp of Array.isArray(traits.expertise) ? traits.expertise : []) {
      keywords.push(String(exp));
    }
    if (xp.interest) keywords.push(String(xp.interest));

    const blob = `${JSON.stringify(traits)} ${JSON.stringify(xp)}`.toLowerCase();
    if (/sport|nba|nfl|fantasy|dfs/.test(blob) || !keywords.length) {
      keywords.push(...(packs.sports || ['NBA', 'NFL']).slice(0, 3));
      keywords.push(...(packs.dfs || ['DraftKings']).slice(0, 2));
    }
    if (/tech|ai|code|startup/.test(blob) || Math.random() < 0.4) {
      keywords.push(...(packs.tech || ['AI tools', 'startups']).slice(0, 2));
    }

    return [...new Set(keywords.map((k) => String(k).trim()).filter((k) => k.length >= 2))].slice(0, 5);
  }

  async insertDiscoveredTargets(targets, { category = 'discovered', priority = 80 } = {}) {
    const junk = new Set([
      'home', 'explore', 'search', 'settings', 'messages', 'notifications', 'i',
      'compose', 'login', 'signup', 'tos', 'privacy', 'following', 'followers',
      'technology', 'business', 'sports', 'finance', 'science', 'gaming', 'education',
      'people', 'verified', 'premium', 'jobs', 'lists', 'communities', 'grok',
    ]);
    let inserted = 0;
    for (const t of targets || []) {
      const handle = String(t.handle || '').replace(/^@/, '').trim();
      if (!handle || handle.length < 2 || handle.length > 15) continue;
      if (junk.has(handle.toLowerCase())) continue;
      if (!/^[A-Za-z0-9_]+$/.test(handle)) continue;
      const cat = String(t.category || category).slice(0, 50);
      const notes = t.source ? `source=${t.source}` : null;
      const result = await pool.query(
        `INSERT INTO x_follow_targets (handle, category, enabled, priority, notes)
         VALUES ($1, $2, true, $3, $4)
         ON CONFLICT (handle) DO NOTHING
         RETURNING id`,
        [handle, cat, priority, notes]
      );
      if (result.rowCount) inserted += 1;
    }
    return inserted;
  }

  /**
   * Discover new follow targets via people search / who-to-follow / FoF.
   * Deduped insert into x_follow_targets.
   */
  async discoverTargetsForAccount(account, { limit = 12 } = {}) {
    const keywords = this.getDiscoveryKeywords(account);
    const seeds = await pool.query(
      `SELECT handle FROM x_follow_targets
       WHERE enabled = true AND category IN ('sports','dfs','tech','discovered')
       ORDER BY priority ASC, random()
       LIMIT 3`
    );
    const result = await playwrightService.discoverXFollowTargets(account.id, {
      keywords,
      seedHandles: seeds.rows.map((r) => r.handle),
      limit,
      requireProxy: true,
    });
    const inserted = await this.insertDiscoveredTargets(result.targets || [], {
      category: 'discovered',
      priority: 75,
    });
    await pool.query(
      `UPDATE x_follow_jobs
       SET last_discover_at = NOW(), updated_at = NOW()
       WHERE social_account_id = $1`,
      [account.id]
    ).catch(() => {});
    return {
      success: true,
      accountId: account.id,
      keywords,
      found: (result.targets || []).length,
      inserted,
      sample: (result.targets || []).slice(0, 5).map((t) => t.handle),
    };
  }

  /**
   * Accept pending inbound follow requests (daily cap).
   */
  async acceptFollowsForAccount(account, { maxAccept = 5, dailyCap = 10 } = {}) {
    let job = await this.ensureJob(account.id);
    const today = new Date().toISOString().slice(0, 10);
    const dayKey = job.accepts_day_key
      ? new Date(job.accepts_day_key).toISOString().slice(0, 10)
      : null;
    let acceptsToday = job.accepts_today || 0;
    if (dayKey !== today) {
      acceptsToday = 0;
      await pool.query(
        `UPDATE x_follow_jobs
         SET accepts_today = 0, accepts_day_key = CURRENT_DATE, updated_at = NOW()
         WHERE id = $1`,
        [job.id]
      ).catch(() => {});
    }
    if (acceptsToday >= dailyCap) {
      return { skipped: true, reason: 'accept_daily_cap', acceptsToday };
    }

    const room = Math.min(maxAccept, dailyCap - acceptsToday);
    const result = await playwrightService.acceptXFollowRequests(account.id, {
      maxAccept: room,
      requireProxy: true,
    });

    const n = result.accepted || 0;
    if (n > 0) {
      await pool.query(
        `UPDATE x_follow_jobs
         SET accepts_today = COALESCE(accepts_today, 0) + $2,
             accepts_day_key = CURRENT_DATE,
             last_accept_at = NOW(),
             updated_at = NOW()
         WHERE social_account_id = $1`,
        [account.id, n]
      ).catch(() => {});
    } else {
      await pool.query(
        `UPDATE x_follow_jobs
         SET last_accept_at = NOW(), updated_at = NOW()
         WHERE social_account_id = $1`,
        [account.id]
      ).catch(() => {});
    }

    return {
      success: true,
      accountId: account.id,
      accepted: n,
      empty: !!result.empty,
      screenshots: result.screenshots || [],
      acceptsToday: acceptsToday + n,
    };
  }

  /**
   * If many accounts are failing login/rate-limit, kill the campaign so the
   * durable queue cannot keep walking the army into password submits.
   */
  async pauseCampaignIfLoginCascade(threshold = 3) {
    const result = await pool.query(
      `SELECT COUNT(DISTINCT social_account_id)::int AS n
       FROM x_follow_jobs
       WHERE failure_class IN ('login_failed', 'challenge')
         AND updated_at > NOW() - INTERVAL '24 hours'
         AND consecutive_failures >= 1`
    );
    const n = result.rows[0]?.n || 0;
    if (n < threshold) return { paused: false, n };

    await pool.query(
      `UPDATE x_follow_settings
       SET enabled = false, updated_at = NOW()
       WHERE id = 1 AND enabled = true`
    );
    console.error(
      `X follow campaign auto-paused: ${n} account(s) hit login/challenge failures in 24h`
    );
    return { paused: true, n };
  }

  /**
   * Pick a target this account hasn't followed yet.
   * Prefers less-saturated handles so accounts diversify.
   */
  async pickTarget(accountId) {
    const result = await pool.query(
      `SELECT t.*
       FROM x_follow_targets t
       WHERE t.enabled = true
         AND NOT EXISTS (
           SELECT 1 FROM x_follows f
           WHERE f.social_account_id = $1
             AND lower(f.handle) = lower(t.handle)
         )
       ORDER BY
         t.priority ASC,
         (SELECT COUNT(*) FROM x_follows f2 WHERE lower(f2.handle) = lower(t.handle)) ASC,
         random()
       LIMIT 1`,
      [accountId]
    );
    return result.rows[0] || null;
  }

  async applyFailureQuarantine(job, errorMessage) {
    const failureClass = classifyFailure(errorMessage);
    const consecutive = (job.consecutive_failures || 0) + 1;
    const until = cooldownUntil(failureClass, consecutive);
    const disable =
      failureClass === 'bad_credentials' ||
      failureClass === 'session_dead' ||
      failureClass === 'banned';

    if (failureClass === 'session_dead') {
      try {
        const organicCommentService = require('./organicCommentService');
        await organicCommentService.markDeadSessionAccount(job.social_account_id, errorMessage);
      } catch (e) {
        console.warn('Follow markDeadSession failed:', e.message);
      }
    }

    await pool.query(
      `UPDATE x_follow_jobs
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
      `X follow job ${job.social_account_id} quarantined as ${failureClass} until ${until.toISOString()}` +
        (disable ? ' — disabled' : '')
    );
    return { failureClass, consecutive, until, disable };
  }

  async clearFailureState(jobId) {
    await pool.query(
      `UPDATE x_follow_jobs
       SET consecutive_failures = 0,
           failure_class = NULL,
           cooldown_until = NULL,
           last_error = NULL,
           status = 'idle',
           updated_at = NOW()
       WHERE id = $1`,
      [jobId]
    );
  }

  async getDashboard() {
    const settings = await this.getSettings();
    const jobs = await pool.query(
      `SELECT j.*, sa.username, sa.status AS account_status
       FROM x_follow_jobs j
       JOIN social_accounts sa ON sa.id = j.social_account_id
       ORDER BY j.next_due_at NULLS LAST`
    );
    const recent = await pool.query(
      `SELECT xf.*, sa.username
       FROM x_follows xf
       JOIN social_accounts sa ON sa.id = xf.social_account_id
       ORDER BY xf.created_at DESC
       LIMIT 200`
    );
    const todayStats = await pool.query(
      `SELECT COUNT(*)::int AS followed_today
       FROM x_follows
       WHERE status IN ('followed', 'already') AND created_at::date = CURRENT_DATE`
    );
    const targets = await pool.query(
      `SELECT category, COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE enabled)::int AS enabled
       FROM x_follow_targets
       GROUP BY category
       ORDER BY category`
    );
    const remaining = await pool.query(
      `SELECT COUNT(*)::int AS n FROM x_follow_targets WHERE enabled = true`
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
      `UPDATE x_follow_jobs
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
    if (job.failure_class === 'bad_credentials') {
      return { skipped: true, reason: 'bad_credentials' };
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
        `UPDATE x_follow_jobs SET next_due_at = $2, status = 'idle', updated_at = NOW() WHERE id = $1`,
        [job.id, next]
      );
      return { skipped: true, reason: 'quiet_hours' };
    }

    const target = await this.pickTarget(account.id);
    if (!target) {
      await pool.query(
        `UPDATE x_follow_jobs
         SET status = 'idle', last_error = 'no_targets', next_due_at = NOW() + INTERVAL '6 hours', updated_at = NOW()
         WHERE id = $1`,
        [job.id]
      );
      return { skipped: true, reason: 'no_targets' };
    }

    await pool.query(
      `UPDATE x_follow_jobs SET status = 'running', last_error = NULL, updated_at = NOW() WHERE id = $1`,
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

    // Session gate: follows must reuse a live cookie jar. Dead sessions must
    // NOT fall through to ensureLoggedIn → password submit (that is what
    // rate-limited the whole army when Jul-9 sessions were expired).
    const session = await this.getLiveSession(account.id);
    if (!this.sessionIsFresh(session)) {
      const age = session?.updated_at
        ? `${Math.round((Date.now() - new Date(session.updated_at).getTime()) / 3600000)}h old`
        : 'missing';
      const msg = `no_live_session (${age}) — refusing password login for follow`;
      await this.applyFailureQuarantine(job, msg);
      await this.pauseCampaignIfLoginCascade(3);
      return { skipped: true, reason: 'no_live_session', error: msg };
    }

    try {
      let followResult = { followed: false, alreadyFollowing: false, profileUrl: `https://x.com/${target.handle}` };

      if (!dryRun) {
        followResult = await playwrightService.followXUser(account.id, target.handle, {
          requireProxy: true,
          allowLogin: false,
        });
      } else {
        followResult = { followed: true, alreadyFollowing: false, profileUrl: `https://x.com/${target.handle}`, dryRun: true };
      }

      const status = followResult.alreadyFollowing ? 'already' : 'followed';

      await pool.query(
        `INSERT INTO x_follows
           (social_account_id, proxy_id, handle, category, status, profile_url)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (social_account_id, handle) DO UPDATE
           SET status = EXCLUDED.status,
               proxy_id = EXCLUDED.proxy_id,
               error = NULL`,
        [
          account.id,
          proxies[0].id,
          target.handle,
          target.category,
          status,
          followResult.profileUrl || `https://x.com/${target.handle}`,
        ]
      );

      const followsToday = job.follows_today + 1;
      const next = this.computeNextDue(settings, followsToday);
      await pool.query(
        `UPDATE x_follow_jobs
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

      return {
        success: true,
        accountId: account.id,
        handle: target.handle,
        category: target.category,
        status,
        followsToday,
        nextDue: next,
      };
    } catch (error) {
      const msg = error.message || String(error);
      // Don't treat transient X rate-limits as bad_credentials
      const quarantineMsg = /temporarily limited/i.test(msg)
        ? `X temporarily limited login: ${msg}`
        : msg;
      await this.applyFailureQuarantine(job, quarantineMsg);
      if (/temporarily limited|try again later|rate.?limit|login failed|no_live_session/i.test(msg)) {
        await this.pauseCampaignIfLoginCascade(3);
      }
      await pool.query(
        `INSERT INTO x_follows
           (social_account_id, proxy_id, handle, category, status, profile_url, error)
         VALUES ($1,$2,$3,$4,'error',$5,$6)
         ON CONFLICT (social_account_id, handle) DO UPDATE
           SET status = 'error', error = EXCLUDED.error`,
        [
          account.id,
          proxies[0]?.id || null,
          target.handle,
          target.category,
          `https://x.com/${target.handle}`,
          msg,
        ]
      ).catch(() => {});
      return { success: false, accountId: account.id, handle: target.handle, error: msg };
    }
  }
}

module.exports = new XFollowService();
