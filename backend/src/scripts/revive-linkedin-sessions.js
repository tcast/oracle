/**
 * Revive LinkedIn accounts that were wrongly marked session_dead when an expired
 * cookie hit the (too-aggressive) "refusing password login" rule.
 *
 * These are OWNED accounts with real passwords + TOTP. This script:
 *   1) Re-logs in each account (cookie-first → password fallback → TOTP), in
 *      parallel batches of 5, with a hard per-account timeout.
 *   2) Fully revives accounts that log in (or that only flake on tunnel/timeout —
 *      retry later, never marked dead).
 *   3) Marks + reports accounts that GENUINELY fail login (bad password /
 *      checkpoint / captcha / ban) — those are left inactive with a reason.
 *
 * Conservative by design: we never mark an account dead here. A soft/flaky
 * failure is revived-for-retry so the (now password-capable) brain picks it up.
 *
 * Usage:  node src/scripts/revive-linkedin-sessions.js [--dry] [--concurrency=5]
 */

const pool = require('../services/db');
const playwrightService = require('../services/playwrightService');

const DRY = process.argv.includes('--dry');
const CONCURRENCY = Number(
  (process.argv.find((a) => a.startsWith('--concurrency=')) || '').split('=')[1] || 5
);
const PER_ACCOUNT_TIMEOUT_MS = 150000; // hard timeout per login attempt

function parseCreds(account) {
  const c = account.credentials;
  if (!c) return {};
  return typeof c === 'string' ? JSON.parse(c) : c;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms (${label})`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const FLAKY_RE = /timeout|ERR_TUNNEL|ERR_TIMED_OUT|ERR_PROXY|ERR_CONNECTION|ERR_SOCKET|net::ERR_|Target closed|has been closed|browser.*closed|Navigation|ECONNRESET|socket hang up/i;
const BAN_RE = /suspend|restricted|account.?banned|\bbanned\b|doesn.?t exist|deactivat/i;

function classifyPageFailure(info) {
  const t = String(info?.text || '');
  if (/wrong email or password|password is incorrect|incorrect|doesn.?t match|couldn.?t find (a|your) linkedin account/i.test(t)) {
    return 'bad_credentials';
  }
  if (BAN_RE.test(t)) return 'banned';
  if (/quick security check|verify you.?re human|captcha|are you a robot/i.test(t)) return 'captcha_checkpoint';
  if (/verification code|authenticator|two.?step|two.?factor|enter the code|security code|check your linkedin app/i.test(t)) {
    return 'checkpoint_2fa';
  }
  return 'login_failed';
}

async function attemptLogin(accountId) {
  const account = await playwrightService.getAccount(accountId);
  const creds = parseCreds(account);
  const loginEmail = account.email || account.username;
  const password = creds.password || account.credentials?.password;
  const extras = {
    allowLogin: true, // cookie-first inside ensureLoggedIn, password fallback
    totpSecret: creds.totp_secret || creds.totp || creds.twofa,
    emailPassword: creds.email_password,
    profileUrl: creds.profile_url,
    email: creds.email || account.email,
  };

  let opened;
  try {
    opened = await playwrightService.createBrowserForAccount(accountId, 2, { skipProxy: true });
  } catch (_) {
    opened = await playwrightService.createBrowserForAccount(accountId);
  }
  const browser = opened.browser;
  const page = opened.page;

  try {
    const loggedIn = await withTimeout(
      playwrightService.ensureLoggedIn(page, 'linkedin', accountId, loginEmail, password, extras),
      PER_ACCOUNT_TIMEOUT_MS,
      loginEmail
    );
    if (loggedIn) {
      await playwrightService.persistSession(page, 'linkedin', accountId).catch(() => {});
      return { accountId, email: loginEmail, outcome: 'revived' };
    }
    // Login was attempted but no live session — inspect page to classify why.
    const info = await page
      .evaluate(() => ({ url: location.href, text: (document.body?.innerText || '').slice(0, 2000) }))
      .catch(() => ({ url: '', text: '' }));
    const reason = classifyPageFailure(info);
    return { accountId, email: loginEmail, outcome: 'failed', reason, url: info.url };
  } catch (e) {
    const msg = e?.message || String(e);
    if (FLAKY_RE.test(msg)) {
      return { accountId, email: loginEmail, outcome: 'flaky', reason: msg.slice(0, 200) };
    }
    if (BAN_RE.test(msg)) {
      return { accountId, email: loginEmail, outcome: 'failed', reason: `banned: ${msg.slice(0, 180)}` };
    }
    // Unknown error — treat conservatively as flaky (retry later), never dead.
    return { accountId, email: loginEmail, outcome: 'flaky', reason: msg.slice(0, 200) };
  } finally {
    if (browser) await browser.close().catch(() => {});
    playwrightService._untrackBrowser(accountId);
  }
}

// Fully re-activate an account + its jobs (revived or flaky-for-retry).
async function reviveAccount(accountId) {
  await pool.query(
    `UPDATE social_accounts
     SET status = 'active',
         warmup_status = CASE WHEN warmup_status = 'failed' THEN 'complete' ELSE warmup_status END,
         credentials = (COALESCE(credentials, '{}'::jsonb)
           - 'session_dead' - 'session_dead_at' - 'session_dead_reason'),
         updated_at = NOW()
     WHERE id = $1`,
    [accountId]
  );
  await pool.query(
    `UPDATE social_account_proxies SET is_active = true WHERE social_account_id = $1`,
    [accountId]
  );
  const soon = () => `NOW() + (${1 + Math.floor(Math.random() * 8)} * INTERVAL '1 minute')`;
  await pool.query(
    `UPDATE organic_comment_jobs
     SET enabled = true, status = 'idle', failure_class = NULL, last_error = NULL,
         consecutive_failures = 0, cooldown_until = NULL, next_due_at = ${soon()}, updated_at = NOW()
     WHERE social_account_id = $1`,
    [accountId]
  );
  await pool.query(
    `UPDATE linkedin_follow_jobs
     SET enabled = true, status = 'idle', failure_class = NULL, last_error = NULL,
         consecutive_failures = 0, cooldown_until = NULL, next_due_at = ${soon()}, updated_at = NOW()
     WHERE social_account_id = $1`,
    [accountId]
  );
}

// Genuine login failure — leave inactive, record reason, disable jobs, report.
async function markFailed(accountId, reason) {
  await pool.query(
    `UPDATE social_accounts
     SET status = 'inactive',
         credentials = (COALESCE(credentials, '{}'::jsonb)
           - 'session_dead' - 'session_dead_at' - 'session_dead_reason')
           || jsonb_build_object('login_failed_reason', $2::text, 'login_failed_at', NOW()::text),
         updated_at = NOW()
     WHERE id = $1`,
    [accountId, String(reason).slice(0, 300)]
  );
  const jobFailureClass = /bad_credentials|banned/.test(reason) ? reason.split(':')[0] : 'login_failed';
  await pool.query(
    `UPDATE organic_comment_jobs
     SET enabled = false, status = 'error', failure_class = $2, last_error = $3, updated_at = NOW()
     WHERE social_account_id = $1`,
    [accountId, jobFailureClass, String(reason).slice(0, 500)]
  );
  await pool.query(
    `UPDATE linkedin_follow_jobs
     SET enabled = false, status = 'error', failure_class = $2, last_error = $3, updated_at = NOW()
     WHERE social_account_id = $1`,
    [accountId, jobFailureClass, String(reason).slice(0, 500)]
  );
}

async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  const { rows } = await pool.query(
    `SELECT id, email, username
     FROM social_accounts
     WHERE platform = 'linkedin'
       AND status = 'inactive'
       AND (credentials->>'session_dead') = 'true'
       AND COALESCE(credentials->>'password', '') NOT IN ('', 'default_password')
     ORDER BY id`
  );
  console.log(`Found ${rows.length} session_dead LinkedIn accounts with passwords to revive`);
  if (!rows.length) return;
  if (DRY) {
    console.log('DRY RUN — would attempt login for:', rows.map((r) => r.email || r.username).join(', '));
    return;
  }

  const startedAt = Date.now();
  const results = await runPool(
    rows,
    async (acct, i) => {
      const label = acct.email || acct.username;
      const t0 = Date.now();
      try {
        const r = await attemptLogin(acct.id);
        const secs = Math.round((Date.now() - t0) / 1000);
        console.log(`[${i + 1}/${rows.length}] #${acct.id} ${label} → ${r.outcome}${r.reason ? ` (${r.reason})` : ''} [${secs}s]`);
        return r;
      } catch (e) {
        const secs = Math.round((Date.now() - t0) / 1000);
        console.log(`[${i + 1}/${rows.length}] #${acct.id} ${label} → flaky (${(e.message || e).toString().slice(0, 120)}) [${secs}s]`);
        return { accountId: acct.id, email: label, outcome: 'flaky', reason: (e.message || String(e)).slice(0, 200) };
      }
    },
    CONCURRENCY
  );

  // Apply DB outcomes.
  const revived = [];
  const retryLater = [];
  const failed = [];
  for (const r of results) {
    if (r.outcome === 'revived') {
      await reviveAccount(r.accountId);
      revived.push(r);
    } else if (r.outcome === 'flaky') {
      // Soft-skip: revive-for-retry (never marked dead). Brain now re-logins.
      await reviveAccount(r.accountId);
      retryLater.push(r);
    } else {
      await markFailed(r.accountId, r.reason || 'login_failed');
      failed.push(r);
    }
  }

  const mins = Math.round((Date.now() - startedAt) / 6000) / 10;
  console.log('\n================ REVIVE SUMMARY ================');
  console.log(`total=${results.length} elapsed=${mins}m concurrency=${CONCURRENCY}`);
  console.log(`revived (live login)      : ${revived.length}`);
  console.log(`revived-for-retry (flaky) : ${retryLater.length}`);
  console.log(`genuinely failed          : ${failed.length}`);
  if (retryLater.length) {
    console.log('\n-- flaky / retry-later --');
    for (const r of retryLater) console.log(`  #${r.accountId} ${r.email}: ${r.reason}`);
  }
  if (failed.length) {
    console.log('\n-- genuinely failed (left inactive) --');
    for (const r of failed) console.log(`  #${r.accountId} ${r.email}: ${r.reason}${r.url ? ` [${r.url}]` : ''}`);
  }
  console.log(JSON.stringify({
    total: results.length,
    revived: revived.length,
    retry_later: retryLater.length,
    failed: failed.length,
    failed_detail: failed.map((r) => ({ id: r.accountId, email: r.email, reason: r.reason })),
  }));
  console.log('===============================================');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('revive-linkedin-sessions fatal:', e);
    process.exit(1);
  });
