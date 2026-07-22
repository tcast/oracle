#!/usr/bin/env node
/**
 * Fast cookie-only X handle rename via settings/screen_name typedScreenName.
 * No password login. Password/TOTP only if X prompts mid-rename.
 *
 *   X_PERSONA_LIVE=1 node src/scripts/rename-x-handles-live.js --pending --concurrency 4
 *   X_PERSONA_LIVE=1 node src/scripts/rename-x-handles-live.js --accounts 610,620
 */
require('dotenv').config();
const pool = require('../services/db');
const playwrightService = require('../services/playwrightService');
const {
  allocateDesiredUsername,
  needsHumanHandle,
  looksFakeUsername,
  isJunkUsername,
} = require('../services/xPersonas');

const HARD_MS = Math.max(60000, Number(process.env.X_RENAME_TIMEOUT_MS || 240000));

function arg(name, def = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return def;
  const v = process.argv[idx + 1];
  return v && !v.startsWith('--') ? v : true;
}

function parseJson(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms (${label})`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function classify(msg) {
  const m = String(msg || '');
  if (/account_suspended|is suspended|has been suspended|account_locked|account_does_not_exist/i.test(m)) {
    return 'banned';
  }
  if (/no_live_session|session_not_logged_in|login_wall/i.test(m)) return 'session_dead';
  if (/proxy|oxylabs|ERR_TUNNEL|ERR_PROXY|ECONNREFUSED|ETIMEDOUT|tunnel/i.test(m)) {
    return 'proxy_error';
  }
  if (/rate.?limit|try again later/i.test(m)) return 'rate_limit';
  if (/timeout after/i.test(m)) return 'timeout';
  if (/x_username_needs_password/i.test(m)) return 'needs_password';
  return 'other';
}

async function resolveIds() {
  if (process.argv.includes('--pending')) {
    const { rows } = await pool.query(
      `SELECT id, username, credentials, status, warmup_status
       FROM social_accounts
       WHERE platform = 'x'
         AND status = 'active'
         AND COALESCE(warmup_status, 'new') = 'warmed'
       ORDER BY id ASC`
    );
    return rows
      .filter((r) => {
        const xp = parseJson(r.credentials, {}).x_persona || {};
        return needsHumanHandle(r.username, xp) || looksFakeUsername(r.username) || isJunkUsername(r.username);
      })
      .map((r) => r.id);
  }
  const accounts = arg('--accounts');
  if (typeof accounts === 'string') {
    return accounts
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  }
  throw new Error('Provide --pending or --accounts');
}

async function renameOne(accountId) {
  const { rows } = await pool.query(
    `SELECT id, username, credentials, status FROM social_accounts WHERE id = $1`,
    [accountId]
  );
  if (!rows.length) return { accountId, success: false, error: 'not found' };
  const row = rows[0];
  if (row.status !== 'active') {
    return { accountId, success: false, soft: true, error: `status=${row.status}`, class: 'skip' };
  }
  const creds = parseJson(row.credentials, {});
  let xp = creds.x_persona && typeof creds.x_persona === 'object' ? { ...creds.x_persona } : {};
  let desired = xp.desired_username || xp.username || null;
  if (!desired || looksFakeUsername(desired)) {
    desired = await allocateDesiredUsername(pool, accountId);
    xp = {
      ...xp,
      username: desired,
      desired_username: desired,
      rename_handle: true,
      username_applied: false,
      updated_at: new Date().toISOString(),
    };
    await pool.query(
      `UPDATE social_accounts
       SET credentials = jsonb_set(COALESCE(credentials, '{}'::jsonb), '{x_persona}', $2::jsonb),
           updated_at = NOW()
       WHERE id = $1`,
      [accountId, JSON.stringify(xp)]
    );
  }

  const liveBefore = row.username;
  if (liveBefore && liveBefore.toLowerCase() === desired.toLowerCase()) {
    return {
      accountId,
      success: true,
      already: true,
      username: liveBefore,
      desired,
    };
  }

  let browser;
  try {
    await playwrightService.requireProxyForLive(accountId);
    const created = await playwrightService.createBrowserForAccount(accountId, 2, {
      requireProxy: true,
    });
    browser = created.browser;
    const page = created.page;
    const password =
      (creds.password && String(creds.password).trim()) ||
      (creds.pass && String(creds.pass).trim()) ||
      null;

    const loggedIn = await playwrightService.ensureLoggedIn(
      page,
      'x',
      accountId,
      liveBefore,
      password,
      { allowLogin: false, totpSecret: creds.totp_secret }
    );
    if (!loggedIn) throw new Error(`no_live_session for x/${liveBefore}`);

    const renameResult = await playwrightService.updateXUsername(page, desired, {
      accountId,
      currentUsername: liveBefore,
      password,
      totpSecret: creds.totp_secret || creds.totp || null,
    });
    if (!renameResult?.usernameAttempted) {
      return {
        accountId,
        success: false,
        soft: true,
        error: 'typedScreenName unavailable',
        class: 'other',
        desired,
      };
    }
    const finalHandle = renameResult.requestedUsername || desired;

    // Verify on profile
    let liveHandle = null;
    try {
      await page.goto(`https://x.com/${finalHandle}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await playwrightService.humanLikeDelay(1500, 2500);
      liveHandle = await page.evaluate(() => {
        const userPath = (location.pathname || '').replace(/^\//, '').split('/')[0] || '';
        const handleEl =
          document.querySelector('[data-testid="UserName"]') ||
          document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
        const text = (handleEl && handleEl.innerText) || '';
        const m = text.match(/@([A-Za-z0-9_]+)/);
        return (m && m[1]) || userPath || null;
      });
    } catch (e) {
      console.warn(`#${accountId} profile verify soft-fail: ${e.message}`);
    }

    const applied =
      liveHandle &&
      String(liveHandle).replace(/^@/, '').toLowerCase() === finalHandle.toLowerCase();

    if (applied || renameResult.inputVerified) {
      const nextXp = {
        ...xp,
        username: finalHandle,
        desired_username: finalHandle,
        rename_handle: true,
        username_applied: true,
        username_applied_at: new Date().toISOString(),
        rename_needs_password: false,
        updated_at: new Date().toISOString(),
      };
      delete nextXp.rename_skipped_at;
      await pool.query(
        `UPDATE social_accounts
         SET username = $2,
             credentials = jsonb_set(COALESCE(credentials, '{}'::jsonb), '{x_persona}', $3::jsonb),
             updated_at = NOW()
         WHERE id = $1`,
        [accountId, finalHandle, JSON.stringify(nextXp)]
      );
      await playwrightService.persistSession(page, 'x', accountId).catch(() => {});
      return {
        accountId,
        success: true,
        username: finalHandle,
        from: liveBefore,
        desired: finalHandle,
        verified: !!applied,
        inputVerified: !!renameResult.inputVerified,
      };
    }

    return {
      accountId,
      success: false,
      error: `rename not verified (wanted=@${finalHandle} live=@${liveHandle || '?'})`,
      class: 'verify_failed',
      desired: finalHandle,
      from: liveBefore,
    };
  } catch (err) {
    const msg = err.message || String(err);
    const cls = classify(msg);
    if (cls === 'banned') {
      const organicCommentService = require('../services/organicCommentService');
      await organicCommentService
        .markBannedAccount(accountId, `x_rename: ${msg}`)
        .catch(() => {});
      return { accountId, success: false, error: msg, class: cls, accountMarkedBanned: true };
    }
    if (cls === 'session_dead') {
      const organicCommentService = require('../services/organicCommentService');
      await organicCommentService
        .markDeadSessionAccount(accountId, `x_rename: ${msg}`)
        .catch(() => {});
      return { accountId, success: false, error: msg, class: cls, accountMarkedDead: true };
    }
    return {
      accountId,
      success: false,
      error: msg,
      class: cls,
      soft: ['proxy_error', 'rate_limit', 'timeout', 'needs_password'].includes(cls),
      desired,
      from: liveBefore,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
    playwrightService._untrackBrowser?.(accountId);
  }
}

async function runPool(ids, concurrency) {
  const results = new Array(ids.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor;
      cursor += 1;
      if (i >= ids.length) return;
      const id = ids[i];
      console.log(`\n----- #${id} (${i + 1}/${ids.length}) -----`);
      try {
        results[i] = await withTimeout(renameOne(id), HARD_MS, `rename #${id}`);
      } catch (err) {
        results[i] = {
          accountId: id,
          success: false,
          soft: true,
          class: 'timeout',
          error: err.message || String(err),
        };
      }
      const r = results[i];
      if (r.success) {
        console.log(
          `#${id} OK ${r.from || '?'} → @${r.username}` +
            (r.verified ? ' verified' : r.inputVerified ? ' input-ok' : '') +
            (r.already ? ' (already)' : '')
        );
      } else {
        console.log(
          `#${id} FAIL [${r.class || '?'}]${r.soft ? ' soft' : ''}` +
            `${r.accountMarkedBanned ? ' banned' : ''}` +
            `${r.accountMarkedDead ? ' dead' : ''}: ${(r.error || '').slice(0, 120)}`
        );
      }
    }
  }
  const n = Math.max(1, Math.min(concurrency, ids.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

async function main() {
  if (process.env.X_PERSONA_LIVE !== '1') {
    console.error('Set X_PERSONA_LIVE=1');
    process.exit(2);
  }
  const concurrency = Math.max(1, Math.min(5, Number(arg('--concurrency', '4')) || 4));
  const ids = await resolveIds();
  console.log(`Cookie-only rename ${ids.length} account(s), concurrency=${concurrency}, timeout=${HARD_MS}ms`);
  const results = await runPool(ids, concurrency);
  const ok = results.filter((r) => r.success && !r.already);
  const already = results.filter((r) => r.already);
  const soft = results.filter((r) => !r.success && r.soft);
  const hard = results.filter((r) => !r.success && !r.soft);
  console.log('\n===== SUMMARY =====');
  console.table(
    results.map((r) => ({
      id: r.accountId,
      ok: !!r.success,
      from: (r.from || '').slice(0, 16),
      to: (r.username || r.desired || '').slice(0, 16),
      err: (r.error || r.class || '').slice(0, 36),
    }))
  );
  console.log(
    `Renamed: ${ok.length} | already: ${already.length} | soft-skip: ${soft.length} | hard-fail: ${hard.length}`
  );
  console.log('Samples:', ok.slice(0, 10).map((r) => r.username).join(', '));
  await pool.end().catch(() => {});
  process.exit(hard.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
