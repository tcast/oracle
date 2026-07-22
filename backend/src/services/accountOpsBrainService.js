/**
 * Always-on Account Ops Brain — enroll, prioritize, action, surface shortages.
 * Gated by ACCOUNT_OPS_BRAIN=1. Delegates heavy work to organic / follow / persona.
 */
const pool = require('./db');
const organicCommentService = require('./organicCommentService');
const xFollowService = require('./xFollowService');
const proxyService = require('./proxyService');
const { isJunkUsername, looksFakeUsername, needsHumanHandle } = require('./xPersonas');

const PLATFORMS = ['x', 'reddit'];
const WORKER_HARD_MS = Number(process.env.ACCOUNT_OPS_WORKER_TIMEOUT_MS || 10 * 60 * 1000);
const MAX_PARALLEL = Math.min(8, Math.max(1, Number(process.env.ACCOUNT_OPS_PARALLEL || 5)));
const FREE_PROXY_FLOOR = Math.max(1, Number(process.env.ACCOUNT_OPS_FREE_PROXY_FLOOR || 5));
const MIN_ACTIVE_ACCOUNTS = Math.max(1, Number(process.env.ACCOUNT_OPS_MIN_ACTIVE || 10));
const ENROLL_BATCH = Math.min(80, Math.max(5, Number(process.env.ACCOUNT_OPS_ENROLL_BATCH || 40)));
const PROFILE_PER_TICK = Math.min(2, Math.max(0, Number(process.env.ACCOUNT_OPS_PROFILE_PER_TICK || 1)));

let lastCapacity = { alerts: [], computed_at: null, stats: {} };
const lockedAccounts = new Set();

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class AccountOpsBrainService {
  getLastCapacity() {
    return lastCapacity;
  }

  isEnabled() {
    const v = String(process.env.ACCOUNT_OPS_BRAIN || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
  }

  /**
   * Compute actionable capacity shortages for UI + brain.
   * Thresholds: free provider proxies < FREE_PROXY_FLOOR while unbound accounts wait;
   * active accounts / organic-enabled below MIN_ACTIVE_ACCOUNTS.
   */
  async computeCapacity() {
    const [proxyByProvider, accountStats, organicStats] = await Promise.all([
      pool.query(`
        SELECT
          COALESCE(NULLIF(TRIM(provider), ''), 'unknown') AS provider,
          COUNT(*) FILTER (WHERE is_active)::int AS active,
          COUNT(*) FILTER (
            WHERE is_active
              AND (cooldown_until IS NULL OR cooldown_until <= NOW())
              AND consecutive_failures = 0
              AND NOT EXISTS (
                SELECT 1 FROM social_account_proxies sap
                WHERE sap.proxy_id = proxies.id AND sap.is_active = true
              )
          )::int AS free_healthy
        FROM proxies
        GROUP BY 1
      `),
      pool.query(`
        SELECT
          CASE WHEN lower(platform) IN ('twitter','x') THEN 'x' ELSE lower(platform) END AS platform,
          COUNT(*) FILTER (
            WHERE status = 'active' AND COALESCE(is_simulated, false) = false
              AND lower(status) NOT IN ('banned','disabled')
          )::int AS active,
          COUNT(*) FILTER (
            WHERE status = 'active' AND COALESCE(is_simulated, false) = false
              AND NOT EXISTS (
                SELECT 1 FROM social_account_proxies sap
                WHERE sap.social_account_id = social_accounts.id AND sap.is_active = true
              )
          )::int AS unbound,
          COUNT(*) FILTER (
            WHERE status = 'active' AND COALESCE(is_simulated, false) = false
              AND COALESCE(warmup_status, '') IN ('pending','new','')
          )::int AS pending_warmup,
          COUNT(*) FILTER (WHERE lower(status) = 'banned')::int AS banned
        FROM social_accounts
        WHERE COALESCE(is_simulated, false) = false
          AND lower(platform) IN ('x','twitter','reddit')
        GROUP BY 1
      `),
      pool.query(`
        SELECT
          CASE WHEN lower(sa.platform) IN ('twitter','x') THEN 'x' ELSE lower(sa.platform) END AS platform,
          COUNT(*) FILTER (WHERE j.enabled = true)::int AS organic_enabled,
          COUNT(*) FILTER (
            WHERE sa.status = 'active'
              AND (j.id IS NULL OR j.enabled = false)
              AND COALESCE(j.failure_class, '') NOT IN ('banned','session_dead','bad_credentials')
          )::int AS organic_starved
        FROM social_accounts sa
        LEFT JOIN organic_comment_jobs j ON j.social_account_id = sa.id
        WHERE COALESCE(sa.is_simulated, false) = false
          AND lower(sa.platform) IN ('x','twitter','reddit')
          AND sa.status = 'active'
        GROUP BY 1
      `),
    ]);

    const proxies = Object.fromEntries(
      proxyByProvider.rows.map((r) => [r.provider, r])
    );
    const accounts = Object.fromEntries(accountStats.rows.map((r) => [r.platform, r]));
    const organic = Object.fromEntries(organicStats.rows.map((r) => [r.platform, r]));

    const oxylabsFree = proxies.Oxylabs?.free_healthy || 0;
    const proxybaseFree = proxies.ProxyBase?.free_healthy || 0;
    const xUnbound = accounts.x?.unbound || 0;
    const redditUnbound = accounts.reddit?.unbound || 0;
    const xActive = accounts.x?.active || 0;
    const redditActive = accounts.reddit?.active || 0;
    const xOrganic = organic.x?.organic_enabled || 0;
    const redditOrganic = organic.reddit?.organic_enabled || 0;
    const xStarved = organic.x?.organic_starved || 0;
    const redditStarved = organic.reddit?.organic_starved || 0;

    const alerts = [];

    if (xUnbound > 0 && (oxylabsFree < Math.max(FREE_PROXY_FLOOR, xUnbound) || oxylabsFree < xUnbound)) {
      const need = Math.max(0, xUnbound - oxylabsFree);
      alerts.push({
        id: 'x_oxylabs_proxies',
        severity: oxylabsFree === 0 || need >= 20 ? 'critical' : 'warn',
        kind: 'proxies',
        platform: 'x',
        provider: 'Oxylabs',
        message: `Need more Oxylabs proxies for X (${xUnbound} accounts unbound, ${oxylabsFree} free sticky${need ? `, short ${need}` : ''})`,
        action: 'Buy/import more Oxylabs sticky sessions and assign to unbound X accounts.',
        metrics: { unbound: xUnbound, free: oxylabsFree, short: need, floor: FREE_PROXY_FLOOR },
      });
    }

    if (redditUnbound > 0 && (proxybaseFree < Math.max(FREE_PROXY_FLOOR, redditUnbound) || proxybaseFree < redditUnbound)) {
      const need = Math.max(0, redditUnbound - proxybaseFree);
      alerts.push({
        id: 'reddit_proxybase_proxies',
        severity: proxybaseFree === 0 || need >= 20 ? 'critical' : 'warn',
        kind: 'proxies',
        platform: 'reddit',
        provider: 'ProxyBase',
        message: `Need more ProxyBase proxies for Reddit (${redditUnbound} unbound, ${proxybaseFree} free${need ? `, short ${need}` : ''})`,
        action: 'Buy/import more ProxyBase mobile/residential and assign to unbound Reddit accounts.',
        metrics: { unbound: redditUnbound, free: proxybaseFree, short: need, floor: FREE_PROXY_FLOOR },
      });
    }

    if (xActive < MIN_ACTIVE_ACCOUNTS) {
      alerts.push({
        id: 'x_accounts_low',
        severity: xActive < 5 ? 'critical' : 'warn',
        kind: 'accounts',
        platform: 'x',
        message: `Need more X accounts (active=${xActive}, organic_enabled=${xOrganic}, starved=${xStarved})`,
        action: 'Import more warmed X cookie accounts.',
        metrics: { active: xActive, organic_enabled: xOrganic, starved: xStarved, min: MIN_ACTIVE_ACCOUNTS },
      });
    }

    if (redditActive < MIN_ACTIVE_ACCOUNTS) {
      alerts.push({
        id: 'reddit_accounts_low',
        severity: redditActive < 5 ? 'critical' : 'warn',
        kind: 'accounts',
        platform: 'reddit',
        message: `Need more Reddit accounts (active=${redditActive}, organic_enabled=${redditOrganic})`,
        action: 'Import or create more Reddit accounts (ProxyBase-bound).',
        metrics: {
          active: redditActive,
          organic_enabled: redditOrganic,
          starved: redditStarved,
          min: MIN_ACTIVE_ACCOUNTS,
        },
      });
    }

    if (xStarved > 0 && oxylabsFree >= FREE_PROXY_FLOOR && xUnbound === 0) {
      // organic not enrolled — brain will fix; soft info only if large
      if (xStarved >= 10) {
        alerts.push({
          id: 'x_organic_enroll',
          severity: 'info',
          kind: 'enrollment',
          platform: 'x',
          message: `${xStarved} active X accounts waiting for organic enrollment`,
          action: 'Account Ops Brain will enable organic jobs automatically.',
          metrics: { starved: xStarved },
        });
      }
    }

    // X handles that still look marketplace-fake and lack password for rename
    const renameGap = await pool.query(`
      SELECT
        COUNT(*) FILTER (
          WHERE credentials->'x_persona'->>'rename_needs_password' = 'true'
             OR (
               NULLIF(credentials->>'password', '') IS NULL
               AND (
                 credentials->'x_persona'->>'desired_username' IS NOT NULL
                 OR credentials->'x_persona'->>'username' IS NOT NULL
               )
               AND COALESCE(credentials->'x_persona'->>'username_applied', 'false') <> 'true'
             )
        )::int AS need_password,
        COUNT(*) FILTER (
          WHERE COALESCE(warmup_status, 'new') = 'warmed'
            AND COALESCE(credentials->'x_persona'->>'username_applied', 'false') <> 'true'
        )::int AS rename_pending
      FROM social_accounts
      WHERE lower(platform) IN ('x', 'twitter')
        AND status = 'active'
        AND COALESCE(is_simulated, false) = false
    `);
    const needPw = renameGap.rows[0]?.need_password || 0;
    const renamePending = renameGap.rows[0]?.rename_pending || 0;
    if (needPw > 0) {
      alerts.push({
        id: 'x_rename_need_password',
        severity: needPw >= 5 ? 'critical' : 'warn',
        kind: 'accounts',
        platform: 'x',
        message: `${needPw} X account(s) need password (or pre-good-handle accounts) to rename marketplace usernames`,
        action:
          'Add credentials.password for username change, or import accounts that already have human handles. Cookie-only sessions cannot rename.',
        metrics: { need_password: needPw, rename_pending: renamePending },
      });
    }

    const stats = {
      thresholds: { free_proxy_floor: FREE_PROXY_FLOOR, min_active_accounts: MIN_ACTIVE_ACCOUNTS },
      proxies: {
        Oxylabs: { free_healthy: oxylabsFree, active: proxies.Oxylabs?.active || 0 },
        ProxyBase: { free_healthy: proxybaseFree, active: proxies.ProxyBase?.active || 0 },
      },
      accounts: {
        x: { ...(accounts.x || {}), organic_enabled: xOrganic, organic_starved: xStarved },
        reddit: {
          ...(accounts.reddit || {}),
          organic_enabled: redditOrganic,
          organic_starved: redditStarved,
        },
      },
      parallel: MAX_PARALLEL,
      brain_enabled: this.isEnabled(),
    };

    lastCapacity = {
      alerts,
      computed_at: new Date().toISOString(),
      stats,
    };
    return lastCapacity;
  }

  /** Enable organic for active non-banned X/Reddit with a live proxy. */
  async enrollOrganicGap(limit = ENROLL_BATCH) {
    const { rows } = await pool.query(
      `SELECT sa.id, sa.platform, sa.username
       FROM social_accounts sa
       LEFT JOIN organic_comment_jobs j ON j.social_account_id = sa.id
       WHERE sa.status = 'active'
         AND COALESCE(sa.is_simulated, false) = false
         AND lower(sa.platform) = ANY($1::text[])
         AND COALESCE(j.enabled, false) = false
         AND COALESCE(j.failure_class, '') NOT IN ('banned', 'session_dead', 'bad_credentials')
         AND EXISTS (
           SELECT 1 FROM social_account_proxies sap
           JOIN proxies p ON p.id = sap.proxy_id
           WHERE sap.social_account_id = sa.id AND sap.is_active = true
             AND p.is_active = true
         )
       ORDER BY sa.id
       LIMIT $2`,
      [['x', 'twitter', 'reddit'], limit]
    );

    let enrolled = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      await organicCommentService.setAccountEnabled(row.id, true);
      const offsetMin = 3 + i * 4 + Math.floor(Math.random() * 5);
      await pool.query(
        `UPDATE organic_comment_jobs
         SET enabled = true,
             status = 'idle',
             failure_class = NULL,
             cooldown_until = NULL,
             last_error = NULL,
             consecutive_failures = 0,
             next_due_at = NOW() + ($2 * INTERVAL '1 minute'),
             updated_at = NOW()
         WHERE social_account_id = $1`,
        [row.id, offsetMin]
      );
      enrolled += 1;
    }
    return { enrolled, sample: rows.slice(0, 5).map((r) => r.id) };
  }

  /** Enable X follow jobs for active proxied X accounts with fresh cookies. */
  async enrollFollowGap(limit = ENROLL_BATCH) {
    const accounts = await xFollowService.listEligibleAccounts();
    let enrolled = 0;
    for (const account of accounts.slice(0, limit)) {
      const job = await xFollowService.ensureJob(account.id);
      if (!job.enabled) {
        await xFollowService.setAccountEnabled(account.id, true);
        enrolled += 1;
      }
    }
    return { enrolled, eligible: accounts.length };
  }

  /** Bind free provider proxies to unbound active accounts (1:1). */
  async bindFreeProxies(limit = 20) {
    const results = { x: 0, reddit: 0 };

    const assignBatch = async (platform, provider, key) => {
      const unbound = await pool.query(
        `SELECT sa.id
         FROM social_accounts sa
         WHERE sa.status = 'active'
           AND COALESCE(sa.is_simulated, false) = false
           AND lower(sa.platform) = ANY($1::text[])
           AND NOT EXISTS (
             SELECT 1 FROM social_account_proxies sap
             WHERE sap.social_account_id = sa.id AND sap.is_active = true
           )
         ORDER BY sa.id
         LIMIT $2`,
        [platform === 'x' ? ['x', 'twitter'] : ['reddit'], limit]
      );
      const free = await pool.query(
        `SELECT p.id
         FROM proxies p
         WHERE p.is_active = true
           AND p.provider = $1
           AND (p.cooldown_until IS NULL OR p.cooldown_until <= NOW())
           AND COALESCE(p.consecutive_failures, 0) = 0
           AND NOT EXISTS (
             SELECT 1 FROM social_account_proxies sap
             WHERE sap.proxy_id = p.id AND sap.is_active = true
           )
         ORDER BY p.id
         LIMIT $2`,
        [provider, unbound.rows.length]
      );
      const n = Math.min(unbound.rows.length, free.rows.length);
      for (let i = 0; i < n; i++) {
        try {
          await proxyService.assignProxiesToAccount(unbound.rows[i].id, [free.rows[i].id]);
          results[key] += 1;
        } catch (err) {
          console.warn(`Brain proxy bind failed account=${unbound.rows[i].id}:`, err.message);
        }
      }
    };

    await assignBatch('x', 'Oxylabs', 'x');
    await assignBatch('reddit', 'ProxyBase', 'reddit');
    return results;
  }

  async listActionCandidates(limit = MAX_PARALLEL * 3) {
    const { rows } = await pool.query(
      `SELECT sa.id, sa.platform, sa.username, sa.status, sa.warmup_status,
              sa.credentials,
              j.enabled AS organic_enabled,
              j.status AS organic_status,
              j.next_due_at AS organic_due,
              j.comments_today,
              j.daily_target,
              j.cooldown_until AS organic_cooldown,
              j.failure_class AS organic_failure,
              fj.enabled AS follow_enabled,
              fj.next_due_at AS follow_due,
              fj.follows_today,
              fj.daily_target AS follow_target,
              fj.cooldown_until AS follow_cooldown,
              fj.status AS follow_status
       FROM social_accounts sa
       LEFT JOIN organic_comment_jobs j ON j.social_account_id = sa.id
       LEFT JOIN x_follow_jobs fj ON fj.social_account_id = sa.id
       WHERE sa.status = 'active'
         AND COALESCE(sa.is_simulated, false) = false
         AND lower(sa.platform) = ANY($1::text[])
         AND EXISTS (
           SELECT 1 FROM social_account_proxies sap
           JOIN proxies p ON p.id = sap.proxy_id
           WHERE sap.social_account_id = sa.id AND sap.is_active = true
             AND p.is_active = true
         )
       ORDER BY random()
       LIMIT $2`,
      [['x', 'twitter', 'reddit'], limit]
    );
    return rows;
  }

  decideAction(account, { quietOrganic, quietFollow, profileBudget }) {
    const platform = String(account.platform || '').toLowerCase() === 'twitter'
      ? 'x'
      : String(account.platform || '').toLowerCase();
    const creds = account.credentials && typeof account.credentials === 'object'
      ? account.credentials
      : {};
    const xp = creds.x_persona && typeof creds.x_persona === 'object' ? creds.x_persona : null;
    const enrichment = creds.profile_enrichment && typeof creds.profile_enrichment === 'object'
      ? creds.profile_enrichment
      : {};

    if (lockedAccounts.has(account.id)) return null;
    if (account.organic_failure === 'banned' || account.organic_failure === 'session_dead') {
      return null;
    }

    const junkUser =
      looksFakeUsername(account.username) ||
      isJunkUsername(account.username) ||
      (xp && needsHumanHandle(account.username, xp));
    const personaLiveOn = ['1', 'true', 'yes', 'on'].includes(
      String(process.env.X_PERSONA_LIVE || '').trim().toLowerCase()
    );
    const needsPersona =
      platform === 'x' &&
      personaLiveOn &&
      profileBudget > 0 &&
      (!xp ||
        !xp.applied_live ||
        junkUser ||
        !enrichment.photo ||
        !enrichment.banner ||
        !xp.display_name ||
        (xp.desired_username && !xp.username_applied));

    if (needsPersona) {
      return { type: 'profile_gap', priority: 1 };
    }

    const now = Date.now();
    const followDue =
      platform === 'x' &&
      !quietFollow &&
      account.follow_enabled !== false &&
      (!account.follow_cooldown || new Date(account.follow_cooldown).getTime() <= now) &&
      (!account.follow_due || new Date(account.follow_due).getTime() <= now) &&
      (account.follows_today || 0) < (account.follow_target || 5);

    if (followDue && Math.random() < 0.45) {
      return { type: 'network', priority: 2 };
    }

    const organicDue =
      !quietOrganic &&
      account.organic_enabled &&
      account.organic_status !== 'running' &&
      (!account.organic_cooldown || new Date(account.organic_cooldown).getTime() <= now) &&
      (!account.organic_due || new Date(account.organic_due).getTime() <= now) &&
      (account.comments_today || 0) < (account.daily_target || 3);

    if (organicDue) {
      return { type: 'organic_comment', priority: 3 };
    }

    if (followDue) {
      return { type: 'network', priority: 2 };
    }

    // Light engage: browse/warm via organic path when under daily cap but due soon
    if (
      !quietOrganic &&
      account.organic_enabled &&
      (account.comments_today || 0) < (account.daily_target || 3) &&
      Math.random() < 0.2
    ) {
      return { type: 'organic_comment', priority: 4 };
    }

    return null;
  }

  async runAction(account, action) {
    lockedAccounts.add(account.id);
    const started = Date.now();
    try {
      if (action.type === 'profile_gap') {
        const playwrightService = require('./playwrightService');
        const result = await withTimeout(
          playwrightService.applyXPersonaLive(account.id, { requireProxy: true }),
          WORKER_HARD_MS,
          'persona'
        );
        return { type: action.type, accountId: account.id, platform: account.platform, ...result, ms: Date.now() - started };
      }
      if (action.type === 'network') {
        const result = await withTimeout(
          xFollowService.runOneForAccount(account, { dryRun: false }),
          WORKER_HARD_MS,
          'follow'
        );
        return { type: action.type, accountId: account.id, platform: account.platform, ...result, ms: Date.now() - started };
      }
      if (action.type === 'organic_comment') {
        const result = await withTimeout(
          organicCommentService.runOneForAccount(account, { dryRun: false }),
          WORKER_HARD_MS,
          'organic'
        );
        return { type: action.type, accountId: account.id, platform: account.platform, ...result, ms: Date.now() - started };
      }
      return { type: action.type, accountId: account.id, skipped: true, reason: 'unknown_action' };
    } catch (err) {
      const msg = err?.message || String(err);
      if (/banned|suspended|locked|challenge/i.test(msg)) {
        try {
          await organicCommentService.markBannedAccount(account.id, `ops_brain: ${msg}`);
        } catch (e) {
          console.warn('Brain markBanned failed:', e.message);
        }
      }
      return {
        type: action.type,
        accountId: account.id,
        platform: account.platform,
        success: false,
        error: msg.slice(0, 300),
        ms: Date.now() - started,
      };
    } finally {
      lockedAccounts.delete(account.id);
    }
  }

  async tick() {
    if (!this.isEnabled()) {
      const capacity = await this.computeCapacity();
      return { skipped: true, reason: 'disabled', capacity };
    }

    const capacity = await this.computeCapacity();
    const [bound, enrolledOrganic, enrolledFollow] = await Promise.all([
      this.bindFreeProxies(15),
      this.enrollOrganicGap(ENROLL_BATCH),
      this.enrollFollowGap(ENROLL_BATCH),
    ]);

    const organicSettings = await organicCommentService.getSettings();
    const followSettings = await xFollowService.getSettings();
    const quietOrganic = organicCommentService.inQuietHours(organicSettings);
    const quietFollow = xFollowService.inQuietHours(followSettings);

    const candidates = await this.listActionCandidates(MAX_PARALLEL * 4);
    let profileBudget = PROFILE_PER_TICK;
    const planned = [];

    for (const account of candidates) {
      if (planned.length >= MAX_PARALLEL) break;
      const action = this.decideAction(account, { quietOrganic, quietFollow, profileBudget });
      if (!action) continue;
      if (action.type === 'profile_gap') profileBudget -= 1;
      planned.push({ account, action });
    }

    const results = await Promise.all(
      planned.map(({ account, action }) => this.runAction(account, action))
    );

    if (results.length || enrolledOrganic.enrolled || capacity.alerts.length) {
      console.log(
        `AccountOpsBrain tick: workers=${results.length} enrolled_organic=${enrolledOrganic.enrolled} ` +
          `bound_proxies=${JSON.stringify(bound)} alerts=${capacity.alerts.length}`,
        results.map((r) => ({
          id: r.accountId,
          type: r.type,
          ok: r.success !== false && !r.error,
          skip: r.skipped,
          reason: r.reason || r.error,
        }))
      );
    }

    return {
      ran: results.length,
      results,
      enrolledOrganic,
      enrolledFollow,
      bound,
      capacity,
      parallel: MAX_PARALLEL,
      quiet: { organic: quietOrganic, follow: quietFollow },
    };
  }
}

module.exports = new AccountOpsBrainService();
