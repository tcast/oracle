#!/usr/bin/env node
/**
 * Camoufox (anti-detect Firefox) pilot for a SINGLE X login.
 *
 * Purpose: test whether the Camoufox engine gets past the "We've temporarily
 * limited your login" wall that the Chromium + JS-stealth stack keeps hitting
 * at the username/password step (before 2FA).
 *
 * Safety contract:
 *   - ONE account only (default 589 / alexandra11sg4), ONE attempt.
 *   - Forces BROWSER_ENGINE=camoufox for this process only.
 *   - Uses a fresh, healthy residential ProxyBase proxy (never BrightData ISP).
 *   - If X returns "temporarily limited" -> STOP immediately, no retry, no other
 *     accounts, and cool the proxy.
 *   - Generates a live TOTP right before typing (handled inside xLogin).
 *
 * Run on a glibc host in Node >= 20 with the Camoufox binary fetched
 * (`npx camoufox-js fetch`). It will NOT run in the Alpine/Node18 prod image.
 *
 * Usage:
 *   BROWSER_ENGINE=camoufox node src/scripts/pilot-x-camoufox-login.js [accountId] [proxyId]
 */
require('dotenv').config();
process.env.BROWSER_ENGINE = 'camoufox';

const fs = require('fs');
const path = require('path');
const pool = require('../services/db');
const playwrightService = require('../services/playwrightService');
const proxyService = require('../services/proxyService');

const SCREENSHOT_DIR = process.env.X_LOGIN_SCREENSHOT_DIR || '/tmp';

async function pickFreshResidentialProxy(explicitId) {
  if (explicitId) {
    const { rows } = await pool.query('SELECT * FROM proxies WHERE id = $1', [explicitId]);
    if (!rows[0]) throw new Error(`Proxy ${explicitId} not found`);
    return rows[0];
  }
  // Prefer ProxyBase "residential" (not mobile) rows that have never been used,
  // are active, not cooling, and not marked unhealthy.
  const { rows } = await pool.query(
    `SELECT * FROM proxies
     WHERE is_active = true
       AND lower(provider) LIKE '%proxybase%'
       AND name ILIKE '%residential%'
       AND (cooldown_until IS NULL OR cooldown_until <= NOW())
       AND COALESCE(consecutive_failures, 0) < 3
       AND (last_health_ok IS DISTINCT FROM false)
     ORDER BY last_used_at ASC NULLS FIRST, id ASC
     LIMIT 1`
  );
  if (!rows[0]) throw new Error('No fresh residential ProxyBase proxy available');
  return rows[0];
}

async function main() {
  const accountId = Number(process.argv[2] || 589);
  const explicitProxyId = process.argv[3] ? Number(process.argv[3]) : null;
  const shotPath = path.join(SCREENSHOT_DIR, `x-camoufox-${accountId}.png`);

  let browser;
  let proxyId = null;

  try {
    const account = await playwrightService.getAccount(accountId);
    if (account.platform !== 'x') {
      throw new Error(`Account ${accountId} is ${account.platform}, expected x`);
    }
    const creds = typeof account.credentials === 'string'
      ? JSON.parse(account.credentials)
      : (account.credentials || {});
    const password = creds.password;
    const totpSecret = creds.totp_secret || creds.totp || creds.twofa;
    if (!password || password === 'default_password') throw new Error('Account has no real password');
    if (!totpSecret) throw new Error('Account has no totp_secret');

    const proxyRow = await pickFreshResidentialProxy(explicitProxyId);
    proxyId = proxyRow.id;
    const proxyConfig = proxyService.formatProxyConfig(proxyRow);
    console.log(`Pilot: account ${accountId} (${account.username}) via ProxyBase proxy ${proxyRow.id} "${proxyRow.name}" ${proxyConfig.server}`);
    await pool.query('UPDATE proxies SET last_used_at = NOW() WHERE id = $1', [proxyId]).catch(() => {});

    const result = await playwrightService.createBrowserForAccount(accountId, 1, {
      requireProxy: true,
      skipProxy: false,
      forceDesktop: true,
      proxyOverride: proxyConfig,
    });
    browser = result.browser;
    const page = result.page;

    // Report the egress IP the fingerprint is being built around.
    try {
      await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 60000 });
      const ip = await page.evaluate(() => document.body?.innerText || '');
      console.log(`Egress IP via proxy: ${ip}`);
    } catch (e) {
      console.log(`Egress IP check failed: ${e.message}`);
    }

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
    const bodyText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 4000)).catch(() => '');
    const rateLimited = /temporarily limited your login|try again later/i.test(bodyText);
    const homeOk = await page.evaluate(() => !!(
      document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]') ||
      document.querySelector('[data-testid="AppTabBar_Home_Link"], [data-testid="BottomBar_Home_Link"]') ||
      document.querySelector('[aria-label="Home timeline"], [data-testid="primaryColumn"]')
    )).catch(() => false);

    await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});

    // Read the auth cookies that prove a real session.
    const cookies = await page.context().cookies().catch(() => []);
    const authToken = cookies.find((c) => c.name === 'auth_token');
    const ct0 = cookies.find((c) => c.name === 'ct0');

    if (rateLimited) {
      await proxyService.updateProxyStats(proxyId, false, { reason: 'rate_limit' }).catch(() => {});
      console.log(JSON.stringify({
        pilot: 'camoufox', accountId, username: account.username,
        result: 'RATE_LIMITED', stopped: true, url,
        proxyId, screenshot: shotPath,
      }, null, 2));
      console.log('\nCAMOUFOX_PILOT=NO — X still "temporarily limited" the login. STOPPING (no retry).');
      return { stop: true };
    }

    const success = !!(loggedIn && homeOk && authToken);
    if (success) {
      await playwrightService.persistSession(page, 'x', accountId);
      await pool.query(
        `UPDATE social_accounts
         SET warmup_status = 'warmed', warmed_up_at = NOW(), last_used_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [accountId]
      ).catch(() => {});
      await proxyService.updateProxyStats(proxyId, true).catch(() => {});
    } else {
      await proxyService.updateProxyStats(proxyId, false, { reason: 'login_failed' }).catch(() => {});
    }

    console.log(JSON.stringify({
      pilot: 'camoufox', accountId, username: account.username,
      result: success ? 'SUCCESS' : 'LOGIN_FAILED',
      loggedIn: !!loggedIn, homeOk: !!homeOk,
      auth_token: authToken ? `present(${authToken.value.length} chars)` : 'MISSING',
      ct0: ct0 ? `present(${ct0.value.length} chars)` : 'MISSING',
      url, proxyId, screenshot: shotPath,
    }, null, 2));
    console.log(`\nCAMOUFOX_PILOT=${success ? 'YES' : 'NO'}`);
    return { stop: false };
  } catch (error) {
    const msg = error.message || String(error);
    const rateLimited = /temporarily limited|try again later|rate.?limit/i.test(msg);
    if (proxyId) {
      await proxyService.updateProxyStats(proxyId, false, { reason: msg }).catch(() => {});
    }
    if (fs.existsSync(shotPath)) console.log(`screenshot: ${shotPath}`);
    console.log(JSON.stringify({
      pilot: 'camoufox', accountId, result: rateLimited ? 'RATE_LIMITED' : 'ERROR', error: msg,
    }, null, 2));
    console.log(`\nCAMOUFOX_PILOT=NO — ${rateLimited ? 'temporarily limited' : 'error'}: ${msg}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    playwrightService._untrackBrowser(accountId);
    await pool.end().catch(() => {});
  }
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
