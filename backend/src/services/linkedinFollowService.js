const pool = require('./db');
const playwrightService = require('./playwrightService');
const proxyService = require('./proxyService');
const { classifyFailure, cooldownUntil } = require('./failureClassifier');

class LinkedInFollowService {
  async getSettings() {
    const result = await pool.query('SELECT * FROM linkedin_follow_settings WHERE id = 1');
    if (result.rows[0]) return result.rows[0];
    const inserted = await pool.query(
      `INSERT INTO linkedin_follow_settings (id, enabled)
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
      `UPDATE linkedin_follow_settings
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
    return result.rows[0];
  }

  async ensureJob(accountId) {
    const existing = await pool.query(
      'SELECT * FROM linkedin_follow_jobs WHERE social_account_id = $1',
      [accountId]
    );
    if (existing.rows[0]) return existing.rows[0];

    const settings = await this.getSettings();
    const target = this.rollDailyTarget(settings);
    const next = this.computeNextDue(settings, 0);

    const inserted = await pool.query(
      `INSERT INTO linkedin_follow_jobs
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
      `UPDATE linkedin_follow_jobs
       SET day_key = CURRENT_DATE,
           follows_today = 0,
           accepts_today = 0,
           daily_target = $2,
           next_due_at = COALESCE($3, next_due_at),
           status = 'idle',
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [job.id, target, next]
    );
    return result.rows[0];
  }

  static SESSION_MAX_AGE_HOURS = 168; // LinkedIn cookies last longer than X

  async getLiveSession(accountId) {
    const result = await pool.query(
      `SELECT updated_at, created_at,
              CASE WHEN cookies IS NULL THEN 0 ELSE jsonb_array_length(cookies) END AS cookie_count
       FROM browser_sessions
       WHERE account_id = $1 AND platform = 'linkedin'
       ORDER BY updated_at DESC
       LIMIT 1`,
      [accountId]
    );
    return result.rows[0] || null;
  }

  sessionIsFresh(session, maxAgeHours = LinkedInFollowService.SESSION_MAX_AGE_HOURS) {
    if (!session || !session.updated_at) return false;
    if ((session.cookie_count || 0) < 1) return false;
    const ageMs = Date.now() - new Date(session.updated_at).getTime();
    return ageMs <= maxAgeHours * 60 * 60 * 1000;
  }

  async listEligibleAccounts() {
    const result = await pool.query(
      `SELECT sa.*
       FROM social_accounts sa
       LEFT JOIN linkedin_follow_jobs j ON j.social_account_id = sa.id
       WHERE sa.platform = 'linkedin'
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
         AND EXISTS (
           SELECT 1 FROM browser_sessions bs
           WHERE bs.account_id = sa.id AND bs.platform = 'linkedin'
             AND bs.cookies IS NOT NULL
             AND jsonb_array_length(bs.cookies) > 0
             AND bs.updated_at > NOW() - INTERVAL '${LinkedInFollowService.SESSION_MAX_AGE_HOURS} hours'
         )
       ORDER BY sa.id`
    );
    return result.rows;
  }

  getDiscoveryKeywords(account) {
    const creds =
      account.credentials && typeof account.credentials === 'object' ? account.credentials : {};
    const lane = String(creds.persona_lane || creds.lane || '').toLowerCase();
    const tech = /tech|developer|engineer|founder|entrepreneur/.test(lane);
    const keywords = tech
      ? ['software engineer', 'developer', 'founder', 'CTO', 'product engineer', 'startup']
      : ['recruiter', 'talent acquisition', 'HR', 'hiring manager'];
    let traits = account.persona_traits;
    if (typeof traits === 'string') {
      try {
        traits = JSON.parse(traits);
      } catch {
        traits = {};
      }
    }
    traits = traits || {};
    for (const exp of Array.isArray(traits.expertise) ? traits.expertise : []) {
      keywords.push(String(exp));
    }
    const hp = creds.hiring_persona && typeof creds.hiring_persona === 'object' ? creds.hiring_persona : {};
    if (hp.headline) keywords.push(String(hp.headline).split('|')[0].trim());
    if (hp.title) keywords.push(String(hp.title));
    return [...new Set(keywords.map((k) => String(k).trim()).filter((k) => k.length >= 2))].slice(
      0,
      5
    );
  }

  async insertDiscoveredTargets(targets, { category = 'discovered', priority = 80 } = {}) {
    let inserted = 0;
    for (const t of targets || []) {
      const handle = String(t.handle || t.slug || '')
        .replace(/^@/, '')
        .replace(/\/$/, '')
        .trim();
      if (!handle || handle.length < 2 || handle.length > 140) continue;
      if (/^(feed|mynetwork|messaging|jobs|login|signup|in|company)$/i.test(handle)) continue;
      const targetType = t.target_type === 'company' ? 'company' : 'person';
      const result = await pool.query(
        `INSERT INTO linkedin_follow_targets (handle, category, target_type, enabled, priority, notes)
         VALUES ($1, $2, $3, true, $4, $5)
         ON CONFLICT (handle) DO NOTHING
         RETURNING id`,
        [handle, category, targetType, priority, t.notes || 'discovered']
      );
      if (result.rows[0]) inserted += 1;
    }
    return inserted;
  }

  async discoverTargetsForAccount(account, { limit = 12 } = {}) {
    const keywords = this.getDiscoveryKeywords(account);
    const result = await playwrightService.discoverLinkedInFollowTargets(account.id, {
      keywords,
      limit,
    });
    const inserted = await this.insertDiscoveredTargets(result.targets || [], {
      category: 'discovered',
      priority: 75,
    });
    await pool
      .query(
        `UPDATE linkedin_follow_jobs
         SET last_discover_at = NOW(), updated_at = NOW()
         WHERE social_account_id = $1`,
        [account.id]
      )
      .catch(() => {});
    return {
      success: true,
      accountId: account.id,
      keywords,
      found: (result.targets || []).length,
      inserted,
      sample: (result.targets || []).slice(0, 5).map((t) => t.handle),
    };
  }

  async acceptFollowsForAccount(account, { maxAccept = 5, dailyCap = 10 } = {}) {
    let job = await this.ensureJob(account.id);
    const today = new Date().toISOString().slice(0, 10);
    const dayKey = job.accepts_day_key
      ? new Date(job.accepts_day_key).toISOString().slice(0, 10)
      : null;
    let acceptsToday = job.accepts_today || 0;
    if (dayKey !== today) {
      acceptsToday = 0;
      await pool
        .query(
          `UPDATE linkedin_follow_jobs
           SET accepts_today = 0, accepts_day_key = CURRENT_DATE, updated_at = NOW()
           WHERE id = $1`,
          [job.id]
        )
        .catch(() => {});
    }
    if (acceptsToday >= dailyCap) {
      return { skipped: true, reason: 'accept_daily_cap', acceptsToday };
    }

    const room = Math.min(maxAccept, dailyCap - acceptsToday);
    const result = await playwrightService.acceptLinkedInInvitations(account.id, {
      maxAccept: room,
    });

    const n = result.accepted || 0;
    if (n > 0) {
      await pool
        .query(
          `UPDATE linkedin_follow_jobs
           SET accepts_today = COALESCE(accepts_today, 0) + $2,
               accepts_day_key = CURRENT_DATE,
               last_accept_at = NOW(),
               updated_at = NOW()
           WHERE social_account_id = $1`,
          [account.id, n]
        )
        .catch(() => {});
    } else {
      await pool
        .query(
          `UPDATE linkedin_follow_jobs
           SET last_accept_at = NOW(), updated_at = NOW()
           WHERE social_account_id = $1`,
          [account.id]
        )
        .catch(() => {});
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

  async pickTarget(accountId) {
    const result = await pool.query(
      `SELECT t.*
       FROM linkedin_follow_targets t
       WHERE t.enabled = true
         AND NOT EXISTS (
           SELECT 1 FROM linkedin_follows f
           WHERE f.social_account_id = $1
             AND lower(f.handle) = lower(t.handle)
         )
       ORDER BY
         t.priority ASC,
         (SELECT COUNT(*) FROM linkedin_follows f2 WHERE lower(f2.handle) = lower(t.handle)) ASC,
         random()
       LIMIT 1`,
      [accountId]
    );
    return result.rows[0] || null;
  }

  async applyFailureQuarantine(job, errorMessage) {
    const organicCommentService = require('./organicCommentService');
    let failureClass = classifyFailure(errorMessage);
    // Owned LinkedIn accounts have passwords — a lost/expired cookie is recoverable
    // via re-login, not a dead account. Downgrade so we retry instead of killing.
    if (
      failureClass === 'session_dead' &&
      (await organicCommentService.isRevivableLinkedInSessionLoss(job.social_account_id, errorMessage))
    ) {
      failureClass = 'login_failed';
    }
    const consecutive = (job.consecutive_failures || 0) + 1;
    const until = cooldownUntil(failureClass, consecutive);
    const disable =
      failureClass === 'bad_credentials' ||
      failureClass === 'session_dead' ||
      failureClass === 'banned' ||
      failureClass === 'id_verification';

    if (failureClass === 'session_dead') {
      try {
        await organicCommentService.markDeadSessionAccount(job.social_account_id, errorMessage);
      } catch (e) {
        console.warn('LI follow markDeadSession failed:', e.message);
      }
    }

    if (failureClass === 'id_verification') {
      try {
        await pool.query(
          `UPDATE social_accounts
           SET status = 'inactive',
               warmup_status = 'id_verification_required',
               credentials = COALESCE(credentials, '{}'::jsonb) || jsonb_build_object(
                 'login_block', jsonb_build_object(
                   'at', NOW()::text,
                   'message', $2::text,
                   'classification', 'id_verification_required'
                 ),
                 'session_dead', 'true',
                 'session_dead_reason', 'id_verification_on_follow'
               ),
               updated_at = NOW()
           WHERE id = $1`,
          [job.social_account_id, String(errorMessage || 'id_verification_restricted').slice(0, 300)]
        );
      } catch (e) {
        console.warn('LI follow mark ID-wall failed:', e.message);
      }
    }

    await pool.query(
      `UPDATE linkedin_follow_jobs
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
    return { failureClass, consecutive, until, disable };
  }

  async getDashboard() {
    const settings = await this.getSettings();
    const jobs = await pool.query(
      `SELECT j.*, sa.username, sa.status AS account_status
       FROM linkedin_follow_jobs j
       JOIN social_accounts sa ON sa.id = j.social_account_id
       ORDER BY j.next_due_at NULLS LAST`
    );
    const recent = await pool.query(
      `SELECT lf.*, sa.username
       FROM linkedin_follows lf
       JOIN social_accounts sa ON sa.id = lf.social_account_id
       ORDER BY lf.created_at DESC
       LIMIT 200`
    );
    const todayStats = await pool.query(
      `SELECT COUNT(*)::int AS followed_today
       FROM linkedin_follows
       WHERE status IN ('followed', 'already', 'pending') AND created_at::date = CURRENT_DATE`
    );
    const targets = await pool.query(
      `SELECT category, COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE enabled)::int AS enabled
       FROM linkedin_follow_targets
       GROUP BY category
       ORDER BY category`
    );
    return {
      settings,
      jobs: jobs.rows,
      recent: recent.rows,
      followed_today: todayStats.rows[0]?.followed_today || 0,
      targets_by_category: targets.rows,
    };
  }

  async setAccountEnabled(accountId, enabled) {
    await this.ensureJob(accountId);
    const result = await pool.query(
      `UPDATE linkedin_follow_jobs
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

  profileUrlForTarget(target) {
    const handle = target.handle;
    if (target.target_type === 'company') {
      return `https://www.linkedin.com/company/${handle}/`;
    }
    return `https://www.linkedin.com/in/${handle}/`;
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
        `UPDATE linkedin_follow_jobs SET next_due_at = $2, status = 'idle', updated_at = NOW() WHERE id = $1`,
        [job.id, next]
      );
      return { skipped: true, reason: 'quiet_hours' };
    }

    const target = await this.pickTarget(account.id);
    if (!target) {
      await pool.query(
        `UPDATE linkedin_follow_jobs
         SET status = 'idle', last_error = 'no_targets', next_due_at = NOW() + INTERVAL '6 hours', updated_at = NOW()
         WHERE id = $1`,
        [job.id]
      );
      return { skipped: true, reason: 'no_targets' };
    }

    await pool.query(
      `UPDATE linkedin_follow_jobs SET status = 'running', last_error = NULL, updated_at = NOW() WHERE id = $1`,
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

    const session = await this.getLiveSession(account.id);
    if (!this.sessionIsFresh(session)) {
      const age = session?.updated_at
        ? `${Math.round((Date.now() - new Date(session.updated_at).getTime()) / 3600000)}h old`
        : 'missing';
      // Owned LinkedIn accounts carry real passwords/TOTP — a stale/missing cookie
      // is recoverable. Attempt re-login (cookie-first, password fallback) below
      // instead of quarantining. Only a real login failure marks the account.
      console.log(`LI follow #${account.id}: session ${age}, attempting cookie-first re-login`);
    }

    const profileUrl = this.profileUrlForTarget(target);
    try {
      let followResult = { followed: false, alreadyFollowing: false, pending: false, profileUrl };

      if (!dryRun) {
        followResult = await playwrightService.followLinkedInTarget(account.id, target.handle, {
          targetType: target.target_type || 'person',
          requireProxy: false,
          allowLogin: true,
        });
      } else {
        followResult = {
          followed: true,
          alreadyFollowing: false,
          pending: false,
          profileUrl,
          dryRun: true,
        };
      }

      const status = followResult.alreadyFollowing
        ? 'already'
        : followResult.pending
          ? 'pending'
          : 'followed';

      const insertedFollow = await pool.query(
        `INSERT INTO linkedin_follows
           (social_account_id, proxy_id, handle, category, status, profile_url)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (social_account_id, handle) DO UPDATE
           SET status = EXCLUDED.status,
               proxy_id = EXCLUDED.proxy_id,
               error = NULL
         RETURNING *`,
        [account.id, proxies[0].id, target.handle, target.category, status, followResult.profileUrl || profileUrl]
      );

      const followsToday = job.follows_today + 1;
      const next = this.computeNextDue(settings, followsToday);
      await pool.query(
        `UPDATE linkedin_follow_jobs
         SET follows_today = $2,
             next_due_at = $3,
             status = 'idle',
             consecutive_failures = 0,
             failure_class = NULL,
             cooldown_until = NULL,
             last_error = NULL,
             last_discover_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [job.id, followsToday, next]
      );
      // Keep Social Accounts "last used" honest — connects are real account use.
      await pool
        .query(`UPDATE social_accounts SET last_used_at = NOW(), updated_at = NOW() WHERE id = $1`, [
          account.id,
        ])
        .catch(() => {});

      const followRow = insertedFollow.rows[0];
      const followLink = followResult.profileUrl || profileUrl;
      try {
        const activityEventService = require('./activityEventService');
        activityEventService
          .logFollow({
            account,
            platform: 'linkedin',
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
      await this.applyFailureQuarantine(job, msg);
      await pool
        .query(
          `INSERT INTO linkedin_follows
             (social_account_id, proxy_id, handle, category, status, profile_url, error)
           VALUES ($1,$2,$3,$4,'error',$5,$6)
           ON CONFLICT (social_account_id, handle) DO UPDATE
             SET status = 'error', error = EXCLUDED.error`,
          [account.id, proxies[0]?.id || null, target.handle, target.category, profileUrl, msg]
        )
        .catch(() => {});
      return { success: false, accountId: account.id, handle: target.handle, error: msg };
    }
  }
}

module.exports = new LinkedInFollowService();
