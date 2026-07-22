/**
 * Always-on Account Ops Brain — enroll, prioritize, action, surface shortages.
 * Gated by ACCOUNT_OPS_BRAIN=1. Delegates heavy work to organic / follow / persona.
 */
const pool = require('./db');
const organicCommentService = require('./organicCommentService');
const xFollowService = require('./xFollowService');
const linkedinFollowService = require('./linkedinFollowService');
const redditFollowService = require('./redditFollowService');
const proxyService = require('./proxyService');
const oxylabsStickyService = require('./oxylabsStickyService');
const brainLiveState = require('./brainLiveState');
const { isJunkUsername, looksFakeUsername, needsHumanHandle } = require('./xPersonas');

const PLATFORMS = ['x', 'reddit', 'linkedin'];
const WORKER_HARD_MS = Number(process.env.ACCOUNT_OPS_WORKER_TIMEOUT_MS || 10 * 60 * 1000);
const MAX_PARALLEL = Math.min(10, Math.max(1, Number(process.env.ACCOUNT_OPS_PARALLEL || 10)));
const FREE_PROXY_FLOOR = Math.max(1, Number(process.env.ACCOUNT_OPS_FREE_PROXY_FLOOR || 5));
const MIN_ACTIVE_ACCOUNTS = Math.max(1, Number(process.env.ACCOUNT_OPS_MIN_ACTIVE || 10));
const ENROLL_BATCH = Math.min(80, Math.max(5, Number(process.env.ACCOUNT_OPS_ENROLL_BATCH || 40)));
// Profile edits are flaky and must never block comment/follow scale. Default off.
const PROFILE_PER_TICK = Math.min(1, Math.max(0, Number(process.env.ACCOUNT_OPS_PROFILE_PER_TICK || 0)));
const PROFILE_SKIP_MS = 24 * 60 * 60 * 1000;
const profileSkipUntil = new Map(); // accountId -> epoch ms

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

  getParallel() {
    return MAX_PARALLEL;
  }

  isEnabled() {
    const v = String(process.env.ACCOUNT_OPS_BRAIN || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
  }

  /** Map internal action types to brain UI labels. */
  _publicActionType(type) {
    if (type === 'network') return 'follow';
    if (type === 'organic_comment') return 'search_comment';
    return type;
  }

  _classifyResult(result) {
    if (result?.skipped || result?.reason === 'profile_soft_skip_24h') {
      return {
        status: 'soft_skip',
        reason: String(result.reason || result.error || 'skipped').slice(0, 160),
      };
    }
    if (result?.success === false || result?.error) {
      return {
        status: 'fail',
        reason: String(result.error || result.reason || 'failed').slice(0, 160),
      };
    }
    return {
      status: 'success',
      reason: result?.reason ? String(result.reason).slice(0, 160) : null,
    };
  }

  /**
   * Lightweight pool + 15m activity counts for /brain. Non-blocking for workers
   * when called from SSE enrich (fire after tick is fine).
   */
  async refreshLivePools() {
    brainLiveState.setMeta({ enabled: this.isEnabled(), parallel: MAX_PARALLEL });
    const [xCookies, redditDue, organicEn, followEn, liFollowEn, redditFollowEn, comments15, follows15, liFollows15, redditFollows15, byPlat15] =
      await Promise.all([
        pool.query(`
          SELECT COUNT(DISTINCT sa.id)::int AS n
          FROM social_accounts sa
          JOIN browser_sessions bs ON bs.account_id = sa.id
          WHERE sa.status = 'active'
            AND COALESCE(sa.is_simulated, false) = false
            AND lower(sa.platform) IN ('x', 'twitter')
            AND bs.platform = 'x'
            AND bs.cookies IS NOT NULL
            AND jsonb_array_length(bs.cookies) > 0
            AND bs.updated_at > NOW() - INTERVAL '72 hours'
        `),
        pool.query(`
          SELECT COUNT(*)::int AS n
          FROM organic_comment_jobs j
          JOIN social_accounts sa ON sa.id = j.social_account_id
          WHERE j.enabled = true
            AND lower(sa.platform) = 'reddit'
            AND sa.status = 'active'
            AND (j.next_due_at IS NULL OR j.next_due_at <= NOW())
            AND (j.cooldown_until IS NULL OR j.cooldown_until <= NOW())
        `),
        pool.query(`
          SELECT COUNT(*)::int AS n
          FROM organic_comment_jobs j
          JOIN social_accounts sa ON sa.id = j.social_account_id
          WHERE j.enabled = true AND sa.status = 'active'
            AND COALESCE(sa.is_simulated, false) = false
            AND lower(sa.platform) IN ('x', 'twitter', 'reddit', 'linkedin')
        `),
        pool.query(`
          SELECT COUNT(*)::int AS n
          FROM x_follow_jobs j
          JOIN social_accounts sa ON sa.id = j.social_account_id
          WHERE j.enabled = true AND sa.status = 'active'
            AND COALESCE(sa.is_simulated, false) = false
        `),
        pool.query(`
          SELECT COUNT(*)::int AS n
          FROM linkedin_follow_jobs j
          JOIN social_accounts sa ON sa.id = j.social_account_id
          WHERE j.enabled = true AND sa.status = 'active'
            AND COALESCE(sa.is_simulated, false) = false
        `).catch(() => ({ rows: [{ n: 0 }] })),
        pool.query(`
          SELECT COUNT(*)::int AS n
          FROM reddit_follow_jobs j
          JOIN social_accounts sa ON sa.id = j.social_account_id
          WHERE j.enabled = true AND sa.status = 'active'
            AND COALESCE(sa.is_simulated, false) = false
        `).catch(() => ({ rows: [{ n: 0 }] })),
        pool.query(`
          SELECT COUNT(*)::int AS n
          FROM organic_comments
          WHERE status = 'posted'
            AND created_at >= NOW() - INTERVAL '15 minutes'
        `),
        pool.query(`
          SELECT COUNT(*)::int AS n
          FROM x_follows
          WHERE created_at >= NOW() - INTERVAL '15 minutes'
        `).catch(() => ({ rows: [{ n: 0 }] })),
        pool.query(`
          SELECT COUNT(*)::int AS n
          FROM linkedin_follows
          WHERE created_at >= NOW() - INTERVAL '15 minutes'
        `).catch(() => ({ rows: [{ n: 0 }] })),
        pool.query(`
          SELECT COUNT(*)::int AS n
          FROM reddit_follows
          WHERE created_at >= NOW() - INTERVAL '15 minutes'
        `).catch(() => ({ rows: [{ n: 0 }] })),
        pool.query(`
          SELECT
            CASE WHEN lower(sa.platform) IN ('twitter','x') THEN 'x' ELSE lower(sa.platform) END AS platform,
            COUNT(*)::int AS n
          FROM organic_comments oc
          JOIN social_accounts sa ON sa.id = oc.social_account_id
          WHERE oc.status = 'posted'
            AND oc.created_at >= NOW() - INTERVAL '15 minutes'
          GROUP BY 1
        `),
      ]);

    brainLiveState.setPools({
      live_x_cookies: xCookies.rows[0]?.n || 0,
      reddit_due: redditDue.rows[0]?.n || 0,
      organic_enabled: organicEn.rows[0]?.n || 0,
      follows_enabled: (followEn.rows[0]?.n || 0) + (liFollowEn.rows[0]?.n || 0) + (redditFollowEn.rows[0]?.n || 0),
      linkedin_follows_enabled: liFollowEn.rows[0]?.n || 0,
      reddit_follows_enabled: redditFollowEn.rows[0]?.n || 0,
    });

    const byPlat = { x: 0, reddit: 0, linkedin: 0 };
    for (const row of byPlat15.rows || []) {
      if (row.platform === 'x' || row.platform === 'reddit' || row.platform === 'linkedin') {
        byPlat[row.platform] = row.n;
      }
    }
    brainLiveState.setStats15m({
      comments: comments15.rows[0]?.n || 0,
      follows: (follows15.rows[0]?.n || 0) + (liFollows15.rows[0]?.n || 0) + (redditFollows15.rows[0]?.n || 0),
      by_platform: byPlat,
    });

    return brainLiveState.getSnapshot();
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
          AND lower(platform) IN ('x','twitter','reddit','linkedin')
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
          AND lower(sa.platform) IN ('x','twitter','reddit','linkedin')
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
    const linkedinUnbound = accounts.linkedin?.unbound || 0;
    const xActive = accounts.x?.active || 0;
    const redditActive = accounts.reddit?.active || 0;
    const linkedinActive = accounts.linkedin?.active || 0;
    const xOrganic = organic.x?.organic_enabled || 0;
    const redditOrganic = organic.reddit?.organic_enabled || 0;
    const linkedinOrganic = organic.linkedin?.organic_enabled || 0;
    const xStarved = organic.x?.organic_starved || 0;
    const redditStarved = organic.reddit?.organic_starved || 0;
    const linkedinStarved = organic.linkedin?.organic_starved || 0;

    const alerts = [];

    // Oxylabs concurrent stickies are unlimited — empty free pool is NOT a buy-more alert.
    // Alert only when we cannot mint (missing creds) or the last provision attempt failed.
    if (xUnbound > 0) {
      const canMint = await oxylabsStickyService.hasCredentials();
      const provisionErr = oxylabsStickyService.getLastProvisionError();
      if (!canMint) {
        alerts.push({
          id: 'x_oxylabs_creds',
          severity: 'critical',
          kind: 'proxies',
          platform: 'x',
          provider: 'Oxylabs',
          message: `Oxylabs credentials missing — cannot mint stickies for ${xUnbound} unbound X account(s)`,
          action: 'Set OXYLABS_USERNAME / OXYLABS_PASSWORD (and optional HOST/PORT/COUNTRY/SESSTIME) then re-run bind.',
          metrics: { unbound: xUnbound, free: oxylabsFree, can_mint: false },
        });
      } else if (provisionErr) {
        alerts.push({
          id: 'x_oxylabs_provision_failed',
          severity: 'critical',
          kind: 'proxies',
          platform: 'x',
          provider: 'Oxylabs',
          message: `Oxylabs sticky provision failed (${xUnbound} unbound X): ${String(provisionErr).slice(0, 160)}`,
          action: 'Check OXYLABS_* creds / gateway, then let Account Ops Brain re-mint stickies.',
          metrics: { unbound: xUnbound, free: oxylabsFree, can_mint: true, error: String(provisionErr).slice(0, 300) },
        });
      }
      // else: free pool empty is fine — bindFreeProxies will mint on demand
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

    // LinkedIn: all accounts already ProxyBase-bound — never false-alert empty free pool.
    // Surface only when we need more LinkedIn accounts (or rare unbound).
    if (linkedinActive < MIN_ACTIVE_ACCOUNTS) {
      alerts.push({
        id: 'linkedin_accounts_low',
        severity: linkedinActive < 5 ? 'critical' : 'warn',
        kind: 'accounts',
        platform: 'linkedin',
        message: `Need more LinkedIn accounts (active=${linkedinActive}, organic_enabled=${linkedinOrganic})`,
        action: 'Import more LinkedIn accounts with proxies.',
        metrics: {
          active: linkedinActive,
          organic_enabled: linkedinOrganic,
          starved: linkedinStarved,
          unbound: linkedinUnbound,
          min: MIN_ACTIVE_ACCOUNTS,
        },
      });
    } else if (linkedinUnbound > 0) {
      alerts.push({
        id: 'linkedin_unbound',
        severity: 'warn',
        kind: 'proxies',
        platform: 'linkedin',
        provider: 'ProxyBase',
        message: `${linkedinUnbound} LinkedIn account(s) missing proxy binding`,
        action: 'Assign ProxyBase proxies to unbound LinkedIn accounts.',
        metrics: { unbound: linkedinUnbound, free: proxybaseFree },
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

    const oxylabsCanMint = await oxylabsStickyService.hasCredentials();
    const stats = {
      thresholds: { free_proxy_floor: FREE_PROXY_FLOOR, min_active_accounts: MIN_ACTIVE_ACCOUNTS },
      proxies: {
        Oxylabs: {
          free_healthy: oxylabsFree,
          active: proxies.Oxylabs?.active || 0,
          unlimited_stickies: true,
          can_mint: oxylabsCanMint,
          last_provision_error: oxylabsStickyService.getLastProvisionError(),
        },
        ProxyBase: { free_healthy: proxybaseFree, active: proxies.ProxyBase?.active || 0 },
      },
      accounts: {
        x: { ...(accounts.x || {}), organic_enabled: xOrganic, organic_starved: xStarved },
        reddit: {
          ...(accounts.reddit || {}),
          organic_enabled: redditOrganic,
          organic_starved: redditStarved,
        },
        linkedin: {
          ...(accounts.linkedin || {}),
          organic_enabled: linkedinOrganic,
          organic_starved: linkedinStarved,
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
      [['x', 'twitter', 'reddit', 'linkedin'], limit]
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

  /** Enable X + LinkedIn + Reddit follow jobs for eligible proxied accounts. */
  async enrollFollowGap(limit = ENROLL_BATCH) {
    const third = Math.max(1, Math.floor(limit / 3));
    const xAccounts = await xFollowService.listEligibleAccounts();
    let enrolled = 0;
    for (const account of xAccounts.slice(0, third)) {
      const job = await xFollowService.ensureJob(account.id);
      if (!job.enabled) {
        await xFollowService.setAccountEnabled(account.id, true);
        enrolled += 1;
      }
    }

    let liEnrolled = 0;
    let liEligible = 0;
    try {
      const liAccounts = await linkedinFollowService.listEligibleAccounts();
      liEligible = liAccounts.length;
      for (const account of liAccounts.slice(0, third)) {
        const job = await linkedinFollowService.ensureJob(account.id);
        if (!job.enabled) {
          await linkedinFollowService.setAccountEnabled(account.id, true);
          liEnrolled += 1;
        }
      }
    } catch (err) {
      console.warn('Brain LinkedIn follow enroll skipped:', err.message);
    }

    let redditEnrolled = 0;
    let redditEligible = 0;
    try {
      const redditAccounts = await redditFollowService.listEligibleAccounts();
      redditEligible = redditAccounts.length;
      for (const account of redditAccounts.slice(0, Math.max(third, limit - third * 2))) {
        const job = await redditFollowService.ensureJob(account.id);
        if (!job.enabled) {
          await redditFollowService.setAccountEnabled(account.id, true);
          redditEnrolled += 1;
        }
      }
    } catch (err) {
      console.warn('Brain Reddit follow enroll skipped:', err.message);
    }

    return {
      enrolled: enrolled + liEnrolled + redditEnrolled,
      eligible: xAccounts.length + liEligible + redditEligible,
      x: enrolled,
      linkedin: liEnrolled,
      reddit: redditEnrolled,
    };
  }

  /**
   * Bind proxies to unbound active accounts (1:1).
   * X/Oxylabs: mint sticky sessids on demand (unlimited concurrent sessions).
   * Reddit/ProxyBase: finite purchased pool only.
   */
  async bindFreeProxies(limit = 20) {
    const results = { x: 0, reddit: 0, oxylabs_minted: null };

    // Prefer free Oxylabs rows if any, then mint stickies for the rest.
    const xUnbound = await pool.query(
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
      [['x', 'twitter'], limit]
    );
    const freeOx = await pool.query(
      `SELECT p.id
       FROM proxies p
       WHERE p.is_active = true
         AND p.provider = 'Oxylabs'
         AND (p.cooldown_until IS NULL OR p.cooldown_until <= NOW())
         AND COALESCE(p.consecutive_failures, 0) = 0
         AND NOT EXISTS (
           SELECT 1 FROM social_account_proxies sap
           WHERE sap.proxy_id = p.id AND sap.is_active = true
         )
       ORDER BY p.id
       LIMIT $1`,
      [xUnbound.rows.length]
    );
    const reuseN = Math.min(xUnbound.rows.length, freeOx.rows.length);
    for (let i = 0; i < reuseN; i++) {
      try {
        await proxyService.assignProxiesToAccount(xUnbound.rows[i].id, [freeOx.rows[i].id]);
        results.x += 1;
      } catch (err) {
        console.warn(`Brain Oxylabs reuse bind failed account=${xUnbound.rows[i].id}:`, err.message);
      }
    }
    const stillNeed = xUnbound.rows.length - reuseN;
    if (stillNeed > 0) {
      const minted = await oxylabsStickyService.bindUnboundXAccounts(stillNeed, { concurrency: 8 });
      results.oxylabs_minted = minted;
      results.x += minted.bound || 0;
    }

    // ProxyBase remains a finite pool.
    const redditUnbound = await pool.query(
      `SELECT sa.id
       FROM social_accounts sa
       WHERE sa.status = 'active'
         AND COALESCE(sa.is_simulated, false) = false
         AND lower(sa.platform) = 'reddit'
         AND NOT EXISTS (
           SELECT 1 FROM social_account_proxies sap
           WHERE sap.social_account_id = sa.id AND sap.is_active = true
         )
       ORDER BY sa.id
       LIMIT $1`,
      [limit]
    );
    const freePb = await pool.query(
      `SELECT p.id
       FROM proxies p
       WHERE p.is_active = true
         AND p.provider = 'ProxyBase'
         AND (p.cooldown_until IS NULL OR p.cooldown_until <= NOW())
         AND COALESCE(p.consecutive_failures, 0) = 0
         AND NOT EXISTS (
           SELECT 1 FROM social_account_proxies sap
           WHERE sap.proxy_id = p.id AND sap.is_active = true
         )
       ORDER BY p.id
       LIMIT $1`,
      [redditUnbound.rows.length]
    );
    const pbN = Math.min(redditUnbound.rows.length, freePb.rows.length);
    for (let i = 0; i < pbN; i++) {
      try {
        await proxyService.assignProxiesToAccount(redditUnbound.rows[i].id, [freePb.rows[i].id]);
        results.reddit += 1;
      } catch (err) {
        console.warn(`Brain ProxyBase bind failed account=${redditUnbound.rows[i].id}:`, err.message);
      }
    }

    return results;
  }

  _platformKey(account) {
    const p = String(account.platform || 'reddit').toLowerCase();
    return p === 'twitter' ? 'x' : p;
  }

  _shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  async listActionCandidates(limit = MAX_PARALLEL * 3, { platforms = null } = {}) {
    const plats = platforms && platforms.length
      ? platforms
      : ['x', 'twitter', 'reddit', 'linkedin'];
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
              COALESCE(xfj.enabled, lfj.enabled, rfj.enabled) AS follow_enabled,
              COALESCE(xfj.next_due_at, lfj.next_due_at, rfj.next_due_at) AS follow_due,
              COALESCE(xfj.follows_today, lfj.follows_today, rfj.follows_today) AS follows_today,
              COALESCE(xfj.daily_target, lfj.daily_target, rfj.daily_target) AS follow_target,
              COALESCE(xfj.cooldown_until, lfj.cooldown_until, rfj.cooldown_until) AS follow_cooldown,
              COALESCE(xfj.status, lfj.status, rfj.status) AS follow_status,
              COALESCE(xfj.accepts_today, lfj.accepts_today) AS accepts_today,
              COALESCE(xfj.last_accept_at, lfj.last_accept_at) AS last_accept_at,
              COALESCE(xfj.last_discover_at, lfj.last_discover_at, rfj.last_discover_at) AS last_discover_at
       FROM social_accounts sa
       LEFT JOIN organic_comment_jobs j ON j.social_account_id = sa.id
       LEFT JOIN x_follow_jobs xfj ON xfj.social_account_id = sa.id
         AND lower(sa.platform) IN ('x', 'twitter')
       LEFT JOIN linkedin_follow_jobs lfj ON lfj.social_account_id = sa.id
         AND lower(sa.platform) = 'linkedin'
       LEFT JOIN reddit_follow_jobs rfj ON rfj.social_account_id = sa.id
         AND lower(sa.platform) = 'reddit'
       WHERE sa.status = 'active'
         AND COALESCE(sa.is_simulated, false) = false
         AND lower(sa.platform) = ANY($1::text[])
         AND EXISTS (
           SELECT 1 FROM social_account_proxies sap
           JOIN proxies p ON p.id = sap.proxy_id
           WHERE sap.social_account_id = sa.id AND sap.is_active = true
             AND p.is_active = true
         )
         AND EXISTS (
           SELECT 1 FROM browser_sessions bs
           WHERE bs.account_id = sa.id
             AND (
               lower(sa.platform) NOT IN ('x', 'twitter')
               OR (
                 bs.platform = 'x'
                 AND bs.cookies IS NOT NULL
                 AND jsonb_array_length(bs.cookies) > 0
                 AND bs.updated_at > NOW() - INTERVAL '72 hours'
               )
             )
         )
         AND COALESCE(j.failure_class, '') NOT IN ('banned', 'session_dead', 'bad_credentials')
       ORDER BY random()
       LIMIT $2`,
      [plats, limit]
    );
    return rows;
  }

  /**
   * Plan up to `limit` workers with platform fair-share.
   * Reserve slots for X and LinkedIn so a large Reddit pool cannot starve them.
   */
  _selectPlannedFairShare(candidates, ctx, limit) {
    const byPlatform = new Map();
    for (const account of candidates) {
      const key = this._platformKey(account);
      if (!byPlatform.has(key)) byPlatform.set(key, []);
      byPlatform.get(key).push(account);
    }
    for (const list of byPlatform.values()) this._shuffleInPlace(list);

    let profileBudget = ctx.profileBudget;
    const actionable = new Map();
    for (const [platform, list] of byPlatform) {
      const ready = [];
      for (const account of list) {
        const action = this.decideAction(account, { ...ctx, profileBudget });
        if (!action) continue;
        if (action.type === 'profile_gap') profileBudget -= 1;
        ready.push({ account, action });
      }
      actionable.set(platform, ready);
    }

    const planned = [];
    const reserveShare = Math.max(1, Math.floor(limit / 3));
    for (const key of ['x', 'linkedin', 'reddit']) {
      const list = actionable.get(key) || [];
      const n = Math.min(reserveShare, list.length);
      for (let i = 0; i < n; i++) planned.push(list.shift());
    }

    const platforms = this._shuffleInPlace([...actionable.keys()]);
    while (planned.length < limit) {
      let progressed = false;
      for (const platform of platforms) {
        if (planned.length >= limit) break;
        const list = actionable.get(platform);
        if (!list || !list.length) continue;
        planned.push(list.shift());
        progressed = true;
      }
      if (!progressed) break;
    }
    return planned;
  }

  decideAction(account, { quietOrganic, quietFollow, profileBudget }) {
    // Order: accept_follows → discover_targets → follow → search/home comment
    // profile_gap is soft-optional only (never blocks queue; max 1 try then 24h skip).
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

    const now = Date.now();
    const sixHours = 6 * 60 * 60 * 1000;
    const lastAccept = account.last_accept_at ? new Date(account.last_accept_at).getTime() : 0;
    const lastDiscover = account.last_discover_at ? new Date(account.last_discover_at).getTime() : 0;
    const acceptsToday = account.accepts_today || 0;
    // Reddit has no follow-request inbox — accept only for X / LinkedIn.
    const acceptPlatform = platform === 'x' || platform === 'linkedin';
    const followPlatform = platform === 'x' || platform === 'linkedin' || platform === 'reddit';

    if (
      acceptPlatform &&
      !quietFollow &&
      acceptsToday < 10 &&
      (!lastAccept || now - lastAccept > sixHours) &&
      Math.random() < 0.35
    ) {
      return { type: 'accept_follows', priority: 1 };
    }

    if (
      followPlatform &&
      !quietFollow &&
      (!lastDiscover || now - lastDiscover > 12 * 60 * 60 * 1000) &&
      Math.random() < 0.3
    ) {
      return { type: 'discover_targets', priority: 2 };
    }

    const followDue =
      followPlatform &&
      !quietFollow &&
      account.follow_enabled !== false &&
      (!account.follow_cooldown || new Date(account.follow_cooldown).getTime() <= now) &&
      (!account.follow_due || new Date(account.follow_due).getTime() <= now) &&
      (account.follows_today || 0) < (account.follow_target || 5);

    if (followDue && Math.random() < 0.55) {
      return { type: 'network', priority: 3 };
    }

    const organicDue =
      !quietOrganic &&
      account.organic_enabled &&
      account.organic_status !== 'running' &&
      (!account.organic_cooldown || new Date(account.organic_cooldown).getTime() <= now) &&
      (!account.organic_due || new Date(account.organic_due).getTime() <= now) &&
      (account.comments_today || 0) < (account.daily_target || 3);

    if (organicDue) {
      return { type: 'search_comment', priority: 4 };
    }

    if (followDue) {
      return { type: 'network', priority: 3 };
    }

    if (
      !quietOrganic &&
      account.organic_enabled &&
      (account.comments_today || 0) < (account.daily_target || 3) &&
      Math.random() < 0.25
    ) {
      return { type: 'home_comment', priority: 5 };
    }

    // Soft profile only after comment/follow paths decline — never blocks queue.
    const junkUser =
      looksFakeUsername(account.username) ||
      isJunkUsername(account.username) ||
      (xp && needsHumanHandle(account.username, xp));
    const personaLiveOn = ['1', 'true', 'yes', 'on'].includes(
      String(process.env.X_PERSONA_LIVE || '').trim().toLowerCase()
    );
    const profileSkipped = (profileSkipUntil.get(account.id) || 0) > now;
    const needsPersona =
      platform === 'x' &&
      personaLiveOn &&
      profileBudget > 0 &&
      !profileSkipped &&
      (!xp ||
        !xp.applied_live ||
        junkUser ||
        !enrichment.photo ||
        !enrichment.banner ||
        !xp.display_name ||
        (xp.desired_username && !xp.username_applied));

    if (needsPersona) {
      return { type: 'profile_gap', priority: 9 };
    }

    return null;
  }

  async runAction(account, action, slot = 0) {
    lockedAccounts.add(account.id);
    const started = Date.now();
    const platform = this._platformKey(account);
    const actionType = this._publicActionType(action.type);
    brainLiveState.actionStart({
      slot,
      account_id: account.id,
      username: account.username,
      platform,
      action_type: actionType,
      started_at: new Date().toISOString(),
    });
    try {
      if (action.type === 'profile_gap') {
        // One attempt then 24h skip so flaky profile never monopolizes workers.
        profileSkipUntil.set(account.id, Date.now() + PROFILE_SKIP_MS);
        const playwrightService = require('./playwrightService');
        const result = await withTimeout(
          playwrightService.applyXPersonaLive(account.id, { requireProxy: true }),
          Math.min(WORKER_HARD_MS, 90 * 1000),
          'persona'
        );
        const ok = result && result.success !== false && !result.error;
        if (!ok) {
          const out = {
            type: action.type,
            accountId: account.id,
            username: account.username,
            platform: account.platform,
            skipped: true,
            reason: 'profile_soft_skip_24h',
            error: result?.error || result?.reason,
            ms: Date.now() - started,
          };
          const cls = this._classifyResult(out);
          brainLiveState.actionEnd({
            slot,
            account_id: account.id,
            username: account.username,
            platform,
            action_type: actionType,
            status: cls.status,
            reason: cls.reason,
            ms: out.ms,
          });
          return out;
        }
        const out = {
          type: action.type,
          accountId: account.id,
          username: account.username,
          platform: account.platform,
          ...result,
          ms: Date.now() - started,
        };
        const cls = this._classifyResult(out);
        brainLiveState.actionEnd({
          slot,
          account_id: account.id,
          username: account.username,
          platform,
          action_type: actionType,
          status: cls.status,
          reason: cls.reason,
          ms: out.ms,
        });
        return out;
      }
      const followSvcFor = (plat) => {
        if (plat === 'linkedin') return linkedinFollowService;
        if (plat === 'reddit') return redditFollowService;
        return xFollowService;
      };
      let result;
      if (action.type === 'accept_follows') {
        const full = await pool.query('SELECT * FROM social_accounts WHERE id = $1', [account.id]);
        const acc = full.rows[0] || account;
        const svc = followSvcFor(this._platformKey(acc));
        result = await withTimeout(
          svc.acceptFollowsForAccount(acc, { maxAccept: 5, dailyCap: 10 }),
          WORKER_HARD_MS,
          'accept_follows'
        );
      } else if (action.type === 'discover_targets') {
        const full = await pool.query('SELECT * FROM social_accounts WHERE id = $1', [account.id]);
        const acc = full.rows[0] || account;
        const svc = followSvcFor(this._platformKey(acc));
        result = await withTimeout(
          svc.discoverTargetsForAccount(acc, { limit: 12 }),
          WORKER_HARD_MS,
          'discover_targets'
        );
      } else if (action.type === 'network') {
        const svc = followSvcFor(this._platformKey(account));
        result = await withTimeout(
          svc.runOneForAccount(account, { dryRun: false }),
          WORKER_HARD_MS,
          'follow'
        );
      } else if (action.type === 'search_comment' || action.type === 'home_comment' || action.type === 'organic_comment') {
        result = await withTimeout(
          organicCommentService.runOneForAccount(account, { dryRun: false }),
          WORKER_HARD_MS,
          'organic'
        );
      } else {
        result = { skipped: true, reason: 'unknown_action' };
      }
      const out = {
        type: action.type,
        accountId: account.id,
        username: account.username,
        platform: account.platform,
        ...result,
        ms: Date.now() - started,
      };
      const cls = this._classifyResult(out);
      brainLiveState.actionEnd({
        slot,
        account_id: account.id,
        username: account.username,
        platform,
        action_type: actionType,
        status: cls.status,
        reason: cls.reason,
        ms: out.ms,
      });
      return out;
    } catch (err) {
      const msg = err?.message || String(err);
      if (/no_live_session|session_not_logged_in|cookie_session_dead/i.test(msg)) {
        try {
          await organicCommentService.markDeadSessionAccount(account.id, `ops_brain: ${msg}`);
        } catch (e) {
          console.warn('Brain markDeadSession failed:', e.message);
        }
      } else if (/banned|suspended|locked|challenge/i.test(msg)) {
        try {
          await organicCommentService.markBannedAccount(account.id, `ops_brain: ${msg}`);
        } catch (e) {
          console.warn('Brain markBanned failed:', e.message);
        }
      }
      const out = {
        type: action.type,
        accountId: account.id,
        username: account.username,
        platform: account.platform,
        success: false,
        error: msg.slice(0, 300),
        ms: Date.now() - started,
      };
      brainLiveState.actionEnd({
        slot,
        account_id: account.id,
        username: account.username,
        platform,
        action_type: actionType,
        status: 'fail',
        reason: out.error,
        ms: out.ms,
      });
      return out;
    } finally {
      lockedAccounts.delete(account.id);
    }
  }

  async tick() {
    brainLiveState.setMeta({ enabled: this.isEnabled(), parallel: MAX_PARALLEL });

    if (!this.isEnabled()) {
      const capacity = await this.computeCapacity();
      brainLiveState.setCapacity(capacity);
      return { skipped: true, reason: 'disabled', capacity };
    }

    const capacity = await this.computeCapacity();
    brainLiveState.setCapacity(capacity);
    // Oxylabs mint is cheap (DB rows) — clear unbound backlog quickly; ProxyBase still capped by free pool.
    const [bound, enrolledOrganic, enrolledFollow] = await Promise.all([
      this.bindFreeProxies(80),
      this.enrollOrganicGap(ENROLL_BATCH),
      this.enrollFollowGap(ENROLL_BATCH),
    ]);

    const organicSettings = await organicCommentService.getSettings();
    const followSettings = await xFollowService.getSettings();
    let liFollowSettings = { quiet_hours_start: 1, quiet_hours_end: 8 };
    try {
      liFollowSettings = await linkedinFollowService.getSettings();
    } catch {
      /* migration may not be applied yet */
    }
    let redditFollowSettings = { quiet_hours_start: 1, quiet_hours_end: 8 };
    try {
      redditFollowSettings = await redditFollowService.getSettings();
    } catch {
      /* migration may not be applied yet */
    }
    const quietOrganic = organicCommentService.inQuietHours(organicSettings);
    const quietFollow =
      xFollowService.inQuietHours(followSettings) &&
      linkedinFollowService.inQuietHours(liFollowSettings) &&
      redditFollowService.inQuietHours(redditFollowSettings);

    // Per-platform fetch so Reddit cannot drown X / LinkedIn in one random LIMIT.
    const perPlat = Math.max(MAX_PARALLEL, Math.ceil(MAX_PARALLEL / 2) * 3);
    const [xCands, redditCands, liCands] = await Promise.all([
      this.listActionCandidates(perPlat, { platforms: ['x', 'twitter'] }),
      this.listActionCandidates(perPlat, { platforms: ['reddit'] }),
      this.listActionCandidates(perPlat, { platforms: ['linkedin'] }),
    ]);
    const candidates = [...xCands, ...redditCands, ...liCands];
    const planned = this._selectPlannedFairShare(
      candidates,
      { quietOrganic, quietFollow, profileBudget: PROFILE_PER_TICK },
      MAX_PARALLEL
    );

    const plannedPublic = planned.map(({ account, action }, i) => ({
      slot: i,
      account_id: account.id,
      username: account.username,
      platform: this._platformKey(account),
      action_type: this._publicActionType(action.type),
    }));
    const byPlatPlanned = {};
    for (const p of plannedPublic) {
      byPlatPlanned[p.platform] = (byPlatPlanned[p.platform] || 0) + 1;
    }
    brainLiveState.tickStart({
      workers: planned.length,
      by_platform: byPlatPlanned,
      planned: plannedPublic,
    });

    // Refresh pools in background — do not await before workers.
    this.refreshLivePools().catch((e) => console.warn('Brain pool refresh:', e.message));

    const results = await Promise.all(
      planned.map(({ account, action }, i) => this.runAction(account, action, i))
    );

    const byPlat = {};
    for (const r of results) {
      const k = this._platformKey(r);
      byPlat[k] = (byPlat[k] || 0) + 1;
    }

    const results_summary = results.map((r) => {
      const cls = this._classifyResult(r);
      return {
        account_id: r.accountId,
        username: r.username,
        platform: this._platformKey(r),
        action_type: this._publicActionType(r.type),
        status: cls.status,
        reason: cls.reason,
        ms: r.ms,
      };
    });

    brainLiveState.tickEnd({
      workers: results.length,
      by_platform: byPlat,
      results_summary,
      quiet: { organic: quietOrganic, follow: quietFollow },
      enrolled: { organic: enrolledOrganic.enrolled, follow: enrolledFollow.enrolled },
      bound,
    });

    if (results.length || enrolledOrganic.enrolled || capacity.alerts.length) {
      console.log(
        `AccountOpsBrain tick: workers=${results.length} by_platform=${JSON.stringify(byPlat)} ` +
          `enrolled_organic=${enrolledOrganic.enrolled} ` +
          `bound_proxies=${JSON.stringify(bound)} alerts=${capacity.alerts.length}`,
        results.map((r) => ({
          id: r.accountId,
          platform: this._platformKey(r),
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
