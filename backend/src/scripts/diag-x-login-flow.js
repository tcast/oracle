#!/usr/bin/env node
/**
 * Diagnostic: drive X login to the password-submit point and capture what the
 * flow actually presents (iframes, arkose/funcaptcha markers, network calls,
 * flow error text). Read-only investigation — does NOT try to complete login.
 *
 * Usage (Camoufox sidecar): node src/scripts/diag-x-login-flow.js <accountId> <proxyId>
 */
require('dotenv').config();
process.env.BROWSER_ENGINE = 'camoufox';

const pool = require('../services/db');
const playwrightService = require('../services/playwrightService');
const proxyService = require('../services/proxyService');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const accountId = Number(process.argv[2] || 591);
  const proxyId = Number(process.argv[3]);
  let browser;

  const account = await playwrightService.getAccount(accountId);
  const creds = typeof account.credentials === 'string' ? JSON.parse(account.credentials) : (account.credentials || {});
  const password = creds.password;
  const username = account.username;

  const { rows } = await pool.query('SELECT * FROM proxies WHERE id = $1', [proxyId]);
  const proxyConfig = proxyService.formatProxyConfig(rows[0]);
  console.log(`DIAG: ${username} (#${accountId}) via proxy ${proxyId} ${proxyConfig.server}`);

  const result = await playwrightService.createBrowserForAccount(accountId, 1, {
    requireProxy: true, skipProxy: false, forceDesktop: true, proxyOverride: proxyConfig,
  });
  browser = result.browser;
  const page = result.page;

  // Log all network requests that look like challenge / arkose / captcha / flow.
  const netHits = [];
  page.on('request', (req) => {
    const u = req.url();
    if (/arkose|funcaptcha|captcha|hcaptcha|recaptcha|onboarding\/task|1\.1\/onboarding|flow|verify/i.test(u)) {
      netHits.push(`${req.method()} ${u.slice(0, 160)}`);
    }
  });

  try {
    await page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await sleep(3000);
    await playwrightService.dismissXConsent(page).catch(() => {});

    // username
    const userSel = 'input[autocomplete="username"], input[name="text"], input[name="username_or_email"]';
    const u = await page.waitForSelector(userSel, { timeout: 30000 });
    await u.click({ force: true }); await u.type(username, { delay: 45 });
    await sleep(800);
    await page.keyboard.press('Enter');
    await sleep(4000);

    // password
    const p = await page.waitForSelector('input[name="password"], input[type="password"]', { timeout: 20000 });
    await p.click({ force: true }); await p.type(password, { delay: 45 });
    await sleep(800);
    await page.keyboard.press('Enter');

    // Watch the next 25s for what appears (challenge vs error)
    for (let i = 0; i < 5; i++) {
      await sleep(5000);
      const snap = await page.evaluate(() => {
        const iframes = [...document.querySelectorAll('iframe')].map((f) => f.src || f.getAttribute('data-src') || '(no src)');
        const html = document.documentElement.outerHTML;
        const markers = {
          arkose: /arkose|funcaptcha|arkoselabs/i.test(html),
          arkoseIframe: [...document.querySelectorAll('iframe')].some((f) => /arkose|funcaptcha/i.test(f.src || '')),
          publicKey: (html.match(/[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/i) || [])[0] || null,
          enforcementFrame: [...document.querySelectorAll('*')].some((el) => /enforcement/i.test(el.id || '')),
        };
        const text = (document.body?.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 15).join(' | ');
        return { url: location.href, iframes, markers, text };
      }).catch((e) => ({ err: e.message }));
      console.log(`\n[t+${(i + 1) * 5 + 6}s] url=${snap.url}`);
      console.log('  markers:', JSON.stringify(snap.markers));
      console.log('  iframes:', JSON.stringify(snap.iframes));
      console.log('  text:', snap.text);
    }

    console.log('\n=== NETWORK (challenge/flow-related) ===');
    [...new Set(netHits)].forEach((h) => console.log('  ' + h));

    await page.screenshot({ path: '/tmp/diag-x-flow.png', fullPage: true }).catch(() => {});
    console.log('\nscreenshot: /tmp/diag-x-flow.png');
  } catch (e) {
    console.error('DIAG error:', e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    playwrightService._untrackBrowser(accountId);
    await pool.end().catch(() => {});
  }
}

main().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
