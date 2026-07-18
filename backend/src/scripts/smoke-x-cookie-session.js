#!/usr/bin/env node
/**
 * Cookie-only X session smoke test.
 *
 * Restores auth_token + ct0 from browser_sessions, opens x.com/home via the
 * account's assigned proxy, and checks logged-in selectors.
 * NEVER falls through to password login.
 *
 * Usage (inside whisper-backend):
 *   node src/scripts/smoke-x-cookie-session.js [accountId ...]
 *
 * Stops the batch on rate-limit / challenge failure.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../services/db');
const playwrightService = require('../services/playwrightService');
const proxyService = require('../services/proxyService');

const SCREENSHOT_DIR = '/tmp';

function detectChallenge(url, bodyText) {
  const u = String(url || '');
  const t = String(bodyText || '').slice(0, 5000);
  if (/rate.?limit|try again later|something went wrong/i.test(t)) {
    return 'rate_limit';
  }
  if (/\/i\/flow\/login|\/login|\/i\/flow\/signup/i.test(u)) {
    return 'login_wall';
  }
  if (/Verify you.?re (a )?human|Confirm you.?re (a )?human|unusual activity|Are you a robot|challenge/i.test(t)) {
    return 'challenge';
  }
  if (/Enter (your )?phone|Verify (your )?phone|Confirm your identity/i.test(t)) {
    return 'challenge';
  }
  return null;
}

async function smokeTestXCookieSession(accountId) {
  let browser;
  let proxyId = null;
  const shotPath = path.join(SCREENSHOT_DIR, `x-cookie-${accountId}.png`);

  try {
    const account = await playwrightService.getAccount(accountId);
    if (account.platform !== 'x') {
      throw new Error(`Account ${accountId} is ${account.platform}, expected x`);
    }

    await playwrightService.requireProxyForLive(accountId);
    const result = await playwrightService.createBrowserForAccount(accountId, 2, {
      requireProxy: true,
    });
    browser = result.browser;
    proxyId = result.proxyConfig?._proxyId || null;
    const page = result.page;
    const proxyServer = result.proxyConfig?.server || null;

    const restored = await playwrightService.restoreSession(page, 'x', accountId);
    if (!restored) {
      return {
        success: false,
        accountId,
        username: account.username,
        error: 'no_session_cookies',
        restored: false,
        stopBatch: false,
        proxyServer,
        screenshot: null,
      };
    }

    // verifySessionAlive already navigates to x.com/home and checks selectors
    const alive = await playwrightService.verifySessionAlive(page, 'x');
    await playwrightService.humanLikeDelay(800, 1500);

    const url = page.url();
    const bodyText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 5000)).catch(() => '');
    const challenge = detectChallenge(url, bodyText);

    const homeFeedVisible = await page.evaluate(() => {
      return !!(
        document.querySelector('[data-testid="primaryColumn"], [aria-label="Home timeline"]') ||
        document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]') ||
        document.querySelector('[data-testid="AppTabBar_Home_Link"], a[href="/home"]')
      );
    }).catch(() => false);

    await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});

    if (challenge === 'rate_limit' || challenge === 'challenge') {
      if (proxyId) {
        await proxyService.updateProxyStats(proxyId, false, { reason: challenge }).catch(() => {});
      }
      return {
        success: false,
        accountId,
        username: account.username,
        restored: true,
        loggedIn: false,
        homeFeedVisible,
        url,
        challenge,
        stopBatch: true,
        proxyServer,
        screenshot: shotPath,
        error: challenge,
      };
    }

    if (!alive || challenge === 'login_wall') {
      if (proxyId) {
        await proxyService.updateProxyStats(proxyId, false, { reason: 'cookie_session_dead' }).catch(() => {});
      }
      return {
        success: false,
        accountId,
        username: account.username,
        restored: true,
        loggedIn: false,
        homeFeedVisible,
        url,
        challenge: challenge || 'not_logged_in',
        stopBatch: false,
        proxyServer,
        screenshot: shotPath,
        error: 'session_not_logged_in',
      };
    }

    // Cookie session works — persist refreshed cookies and mark warmed.
    // Do NOT call ensureLoggedIn / password login.
    await playwrightService.persistSession(page, 'x', accountId);
    await pool.query(
      `UPDATE social_accounts
       SET warmup_status = 'warmed', warmed_up_at = NOW(), last_used_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [accountId]
    ).catch(() => {});

    if (proxyId) {
      await proxyService.updateProxyStats(proxyId, true).catch(() => {});
    }

    return {
      success: true,
      accountId,
      username: account.username,
      restored: true,
      loggedIn: true,
      homeFeedVisible: !!homeFeedVisible,
      url,
      challenge: null,
      stopBatch: false,
      proxyServer,
      screenshot: shotPath,
    };
  } catch (error) {
    if (proxyId) {
      await proxyService.updateProxyStats(proxyId, false, { reason: error.message }).catch(() => {});
    }
    const msg = error.message || String(error);
    const stopBatch = /rate.?limit|challenge|unusual activity/i.test(msg);
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
  const accountIds = ids.length ? ids : [488, 520, 587];

  console.log(`X cookie-session smoke (NO password login) for: ${accountIds.join(', ')}`);
  const results = [];

  for (const accountId of accountIds) {
    console.log(`\n=== Account ${accountId} ===`);
    const result = await smokeTestXCookieSession(accountId);
    results.push(result);
    console.log(JSON.stringify(result, null, 2));

    if (result.stopBatch) {
      console.error(`\nSTOPPING BATCH: account ${accountId} hit ${result.challenge || result.error}`);
      break;
    }

    // Pause between accounts
    await new Promise((r) => setTimeout(r, 5000 + Math.floor(Math.random() * 5000)));
  }

  const ok = results.filter((r) => r.success).length;
  console.log(`\nDone: ${ok}/${results.length} succeeded`);
  console.log('RESULTS_JSON=' + JSON.stringify(results));
  await pool.end().catch(() => {});
  process.exit(ok === results.length ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
