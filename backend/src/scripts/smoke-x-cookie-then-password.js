#!/usr/bin/env node
/**
 * Safe X login smoke for freshly imported accounts.
 *
 * Per account:
 *   1) Restore auth_token (+ ct0 if present) → check home
 *   2) If dead → password + TOTP once (never storm)
 *
 * Staggers 60–120s between accounts. Stops batch on rate-limit / challenge.
 *
 * Usage (inside whisper-backend):
 *   node src/scripts/smoke-x-cookie-then-password.js [accountId ...]
 *   node src/scripts/smoke-x-cookie-then-password.js --usernames=erin21gz1,kerri02zj6
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../services/db');
const playwrightService = require('../services/playwrightService');
const proxyService = require('../services/proxyService');
const organicCommentService = require('../services/organicCommentService');

const SCREENSHOT_DIR = process.env.X_LOGIN_SCREENSHOT_DIR || '/tmp';
const ENABLE_ORGANIC = process.env.X_SMOKE_ENABLE_ORGANIC !== '0';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function detectChallenge(url, bodyText) {
  const u = String(url || '');
  const t = String(bodyText || '').slice(0, 5000);
  if (/temporarily limited your login|rate.?limit|try again later/i.test(t)) {
    return 'rate_limit';
  }
  if (/\/i\/flow\/login|\/login|\/i\/flow\/signup/i.test(u)) {
    return 'login_wall';
  }
  if (
    /Verify you.?re (a )?human|Confirm you.?re (a )?human|unusual activity|Are you a robot|challenge/i.test(
      t
    )
  ) {
    return 'challenge';
  }
  if (/Enter (your )?phone|Verify (your )?phone|Confirm your identity/i.test(t)) {
    return 'challenge';
  }
  return null;
}

async function resolveAccountIds(argv) {
  const ids = argv.filter((a) => /^\d+$/.test(a)).map(Number);
  if (ids.length) return ids;
  const unArg = argv.find((a) => a.startsWith('--usernames='));
  if (!unArg) return [];
  const names = unArg
    .slice('--usernames='.length)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!names.length) return [];
  const r = await pool.query(
    `SELECT id, username FROM social_accounts
     WHERE platform = 'x' AND lower(username) = ANY($1::text[])
     ORDER BY array_position($1::text[], lower(username))`,
    [names.map((n) => n.toLowerCase())]
  );
  return r.rows.map((row) => row.id);
}

async function proxyLabel(accountId) {
  const r = await pool.query(
    `SELECT p.id, COALESCE(p.metadata->>'zone','') AS zone
     FROM social_account_proxies sap
     JOIN proxies p ON p.id = sap.proxy_id
     WHERE sap.social_account_id = $1 AND sap.is_active = true
     ORDER BY sap.priority ASC NULLS LAST
     LIMIT 1`,
    [accountId]
  );
  const row = r.rows[0];
  if (!row) return null;
  return `${row.id}:${row.zone || 'unknown'}`;
}

async function smokeOne(accountId) {
  let browser;
  let proxyId = null;
  const shotPath = path.join(SCREENSHOT_DIR, `x-smoke-${accountId}.png`);
  const proxy = await proxyLabel(accountId);

  try {
    const account = await playwrightService.getAccount(accountId);
    if (account.platform !== 'x') {
      throw new Error(`Account ${accountId} is ${account.platform}, expected x`);
    }

    await playwrightService.requireProxyForLive(accountId);
    const created = await playwrightService.createBrowserForAccount(accountId, 2, {
      requireProxy: true,
      skipProxy: false,
    });
    browser = created.browser;
    proxyId = created.proxyConfig?._proxyId || null;
    const page = created.page;

    // --- Mode 1: cookie session ---
    const restored = await playwrightService.restoreSession(page, 'x', accountId);
    let cookieAlive = false;
    if (restored) {
      cookieAlive = await playwrightService.verifySessionAlive(page, 'x');
      const url = page.url();
      const bodyText = await page
        .evaluate(() => (document.body?.innerText || '').slice(0, 5000))
        .catch(() => '');
      const challenge = detectChallenge(url, bodyText);
      if (challenge === 'rate_limit' || challenge === 'challenge') {
        await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
        if (proxyId) {
          await proxyService.updateProxyStats(proxyId, false, { reason: challenge }).catch(() => {});
        }
        return {
          success: false,
          accountId,
          username: account.username,
          loginMode: 'cookie',
          result: challenge,
          error: challenge,
          stopBatch: true,
          proxy,
          screenshot: shotPath,
        };
      }
    }

    if (cookieAlive) {
      await playwrightService.persistSession(page, 'x', accountId);
      await pool.query(
        `UPDATE social_accounts
         SET warmup_status = 'warmed', warmed_up_at = NOW(), last_used_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [accountId]
      );
      if (proxyId) await proxyService.updateProxyStats(proxyId, true).catch(() => {});
      if (ENABLE_ORGANIC) {
        await organicCommentService.setAccountEnabled(accountId, true).catch(() => {});
      }
      await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
      return {
        success: true,
        accountId,
        username: account.username,
        loginMode: 'cookie',
        result: 'live',
        error: null,
        stopBatch: false,
        proxy,
        screenshot: shotPath,
      };
    }

    // Dead cookies poison password login — clear before password attempt
    await page.context().clearCookies().catch(() => {});

    const password = account.credentials?.password;
    const totpSecret =
      account.credentials?.totp_secret ||
      account.credentials?.totp ||
      account.credentials?.twofa;
    if (!password || password === 'default_password') {
      return {
        success: false,
        accountId,
        username: account.username,
        loginMode: 'cookie_failed_no_password',
        result: 'no_password',
        error: 'cookie dead and no password',
        stopBatch: false,
        proxy,
      };
    }
    if (!totpSecret) {
      return {
        success: false,
        accountId,
        username: account.username,
        loginMode: 'cookie_failed_no_totp',
        result: 'no_totp',
        error: 'cookie dead and no totp',
        stopBatch: false,
        proxy,
      };
    }

    // --- Mode 2: password + TOTP once ---
    const loggedIn = await playwrightService.ensureLoggedIn(
      page,
      'x',
      accountId,
      account.username,
      password,
      { totpSecret, allowLogin: true }
    );

    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await playwrightService.humanLikeDelay(1500, 2500);
    await playwrightService.dismissXConsent(page).catch(() => {});

    const url = page.url();
    const bodyText = await page
      .evaluate(() => (document.body?.innerText || '').slice(0, 4000))
      .catch(() => '');
    const challenge = detectChallenge(url, bodyText);
    const homeOk = await page
      .evaluate(() => {
        return !!(
          document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]') ||
          document.querySelector(
            '[data-testid="AppTabBar_Home_Link"], [data-testid="BottomBar_Home_Link"]'
          ) ||
          document.querySelector('[aria-label="Home timeline"], [data-testid="primaryColumn"]')
        );
      })
      .catch(() => false);

    await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});

    if (challenge === 'rate_limit' || challenge === 'challenge') {
      if (proxyId) {
        await proxyService.updateProxyStats(proxyId, false, { reason: challenge }).catch(() => {});
      }
      await pool.query(
        `UPDATE social_accounts SET warmup_status = 'failed', updated_at = NOW() WHERE id = $1`,
        [accountId]
      ).catch(() => {});
      return {
        success: false,
        accountId,
        username: account.username,
        loginMode: 'password_totp',
        result: challenge,
        error: challenge,
        stopBatch: true,
        proxy,
        url,
        screenshot: shotPath,
      };
    }

    const success = !!(loggedIn && homeOk);
    if (success) {
      await playwrightService.persistSession(page, 'x', accountId);
      await pool.query(
        `UPDATE social_accounts
         SET warmup_status = 'warmed', warmed_up_at = NOW(), last_used_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [accountId]
      );
      if (proxyId) await proxyService.updateProxyStats(proxyId, true).catch(() => {});
      if (ENABLE_ORGANIC) {
        await organicCommentService.setAccountEnabled(accountId, true).catch(() => {});
      }
    } else {
      await pool.query(
        `UPDATE social_accounts SET warmup_status = 'failed', updated_at = NOW() WHERE id = $1`,
        [accountId]
      ).catch(() => {});
      if (proxyId) {
        await proxyService
          .updateProxyStats(proxyId, false, { reason: 'password_login_failed' })
          .catch(() => {});
      }
    }

    return {
      success,
      accountId,
      username: account.username,
      loginMode: 'password_totp',
      result: success ? 'live' : 'login_failed',
      error: success ? null : 'login_failed',
      stopBatch: false,
      proxy,
      url,
      screenshot: fs.existsSync(shotPath) ? shotPath : null,
    };
  } catch (error) {
    if (proxyId) {
      await proxyService.updateProxyStats(proxyId, false, { reason: error.message }).catch(() => {});
    }
    const msg = error.message || String(error);
    const stopBatch = /temporarily limited|try again later|rate.?limit|challenge/i.test(msg);
    await pool.query(
      `UPDATE social_accounts SET warmup_status = 'failed', updated_at = NOW() WHERE id = $1`,
      [accountId]
    ).catch(() => {});
    return {
      success: false,
      accountId,
      loginMode: 'error',
      result: 'error',
      error: msg,
      stopBatch,
      proxy,
      screenshot: fs.existsSync(shotPath) ? shotPath : null,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
    playwrightService._untrackBrowser(accountId);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const accountIds = await resolveAccountIds(argv);
  if (!accountIds.length) {
    console.error(
      'Usage: node src/scripts/smoke-x-cookie-then-password.js <id...> | --usernames=a,b,c'
    );
    process.exit(1);
  }

  console.log(
    `X cookie→password smoke for ${accountIds.length} account(s): ${accountIds.join(', ')}`
  );
  console.log('Stagger 60–120s; stop on rate_limit/challenge');

  const results = [];
  for (let i = 0; i < accountIds.length; i++) {
    const accountId = accountIds[i];
    console.log(`\n=== Account ${accountId} (${i + 1}/${accountIds.length}) ===`);
    const result = await smokeOne(accountId);
    results.push(result);
    console.log(JSON.stringify(result, null, 2));

    if (result.stopBatch) {
      console.error(`\nSTOPPING BATCH: account ${accountId} hit ${result.error}`);
      break;
    }

    if (i < accountIds.length - 1) {
      const waitMs = 60000 + Math.floor(Math.random() * 60000);
      console.log(`Waiting ${Math.round(waitMs / 1000)}s before next account…`);
      await sleep(waitMs);
    }
  }

  const ok = results.filter((r) => r.success).length;
  console.log(`\nDone: ${ok}/${results.length} live`);
  console.log('RESULTS_JSON=' + JSON.stringify(results));
  await pool.end().catch(() => {});
  process.exit(ok > 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
