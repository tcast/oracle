#!/usr/bin/env node
/**
 * Password + TOTP X login smoke test.
 *
 * Uses the account's assigned proxy (requireProxy: true). Does NOT fall back
 * to skipProxy / direct IP. Stops the batch on rate-limit.
 *
 * Usage (inside whisper-backend):
 *   node src/scripts/smoke-x-password-login.js [accountId ...]
 *   node src/scripts/smoke-x-password-login.js 488
 *   node src/scripts/smoke-x-password-login.js 488 500 520 550 587
 *
 * Screenshots land in /tmp inside the container (copy out after).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../services/db');
const playwrightService = require('../services/playwrightService');
const proxyService = require('../services/proxyService');

const SCREENSHOT_DIR = process.env.X_LOGIN_SCREENSHOT_DIR || '/tmp';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function smokePasswordLogin(accountId) {
  let browser;
  let proxyId = null;
  const safeName = String(accountId);
  const shotPath = path.join(SCREENSHOT_DIR, `x-pw-login-${safeName}.png`);

  try {
    const account = await playwrightService.getAccount(accountId);
    if (account.platform !== 'x') {
      throw new Error(`Account ${accountId} is ${account.platform}, expected x`);
    }
    const password = account.credentials?.password;
    if (!password || password === 'default_password') {
      throw new Error('Account has no real password');
    }
    const creds = account.credentials || {};
    const totpSecret = creds.totp_secret || creds.totp || creds.twofa;
    if (!totpSecret) {
      throw new Error('Account has no totp_secret');
    }

    await playwrightService.requireProxyForLive(accountId);
    const result = await playwrightService.createBrowserForAccount(accountId, 2, {
      requireProxy: true,
      // Explicit: never skipProxy in this smoke path
      skipProxy: false,
    });
    browser = result.browser;
    proxyId = result.proxyConfig?._proxyId || null;
    const page = result.page;
    const proxyServer = result.proxyConfig?.server || null;

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
    const rateLimited = /temporarily limited your login|try again later/i.test(bodyText);
    const homeOk = await page
      .evaluate(() => {
        return !!(
          document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]') ||
          document.querySelector('[data-testid="AppTabBar_Home_Link"], [data-testid="BottomBar_Home_Link"]') ||
          document.querySelector('[aria-label="Home timeline"], [data-testid="primaryColumn"]')
        );
      })
      .catch(() => false);

    await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});

    if (rateLimited) {
      if (proxyId) {
        await proxyService.updateProxyStats(proxyId, false, { reason: 'rate_limit' }).catch(() => {});
      }
      return {
        success: false,
        accountId,
        username: account.username,
        stopBatch: true,
        error: 'temporarily_limited',
        url,
        proxyServer,
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
    } else {
      await pool.query(
        `UPDATE social_accounts SET warmup_status = 'failed', updated_at = NOW() WHERE id = $1`,
        [accountId]
      ).catch(() => {});
      if (proxyId) {
        await proxyService.updateProxyStats(proxyId, false, { reason: 'password_login_failed' }).catch(() => {});
      }
    }

    return {
      success,
      accountId,
      username: account.username,
      loggedIn: !!loggedIn,
      homeOk: !!homeOk,
      url,
      stopBatch: false,
      proxyServer,
      screenshot: fs.existsSync(shotPath) ? shotPath : null,
      warmup_status: success ? 'warmed' : 'failed',
      error: success ? null : 'login_failed',
    };
  } catch (error) {
    if (proxyId) {
      await proxyService.updateProxyStats(proxyId, false, { reason: error.message }).catch(() => {});
    }
    const msg = error.message || String(error);
    const stopBatch = /temporarily limited|try again later|rate.?limit/i.test(msg);
    await pool.query(
      `UPDATE social_accounts SET warmup_status = 'failed', updated_at = NOW() WHERE id = $1`,
      [accountId]
    ).catch(() => {});
    return {
      success: false,
      accountId,
      error: msg,
      stopBatch,
      screenshot: fs.existsSync(shotPath) ? shotPath : null,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
    playwrightService._untrackBrowser(accountId);
  }
}

async function main() {
  const ids = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
  const accountIds = ids.length ? ids : [488];

  console.log(`X password+TOTP smoke (proxy-only, no skipProxy) for: ${accountIds.join(', ')}`);
  const results = [];

  for (let i = 0; i < accountIds.length; i++) {
    const accountId = accountIds[i];
    console.log(`\n=== Account ${accountId} ===`);
    const result = await smokePasswordLogin(accountId);
    results.push(result);
    console.log(JSON.stringify(result, null, 2));

    if (result.stopBatch) {
      console.error(`\nSTOPPING BATCH: account ${accountId} hit ${result.error}`);
      break;
    }

    if (i < accountIds.length - 1) {
      const waitMs = 30000 + Math.floor(Math.random() * 30000);
      console.log(`Waiting ${Math.round(waitMs / 1000)}s before next account…`);
      await sleep(waitMs);
    }
  }

  const ok = results.filter((r) => r.success).length;
  console.log(`\nDone: ${ok}/${results.length} succeeded`);
  console.log('RESULTS_JSON=' + JSON.stringify(results));
  await pool.end().catch(() => {});
  process.exit(ok > 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
