/**
 * Probe whether stored LinkedIn cookies are still alive over the account's
 * assigned residential proxy — WITHOUT attempting a password login (which would
 * trip the reCAPTCHA checkpoint). Read-only diagnostic.
 *
 * Usage: node src/scripts/probe-linkedin-cookie-alive.js [--limit=5] [--ids=1,2]
 */
const pool = require('../services/db');
const playwrightService = require('../services/playwrightService');

const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1] || 5);
const IDS = (process.argv.find((a) => a.startsWith('--ids=')) || '').split('=')[1];

async function probe(accountId, email) {
  let browser;
  try {
    const opened = await playwrightService.createBrowserForAccount(accountId, 2, { requireProxy: true });
    browser = opened.browser;
    opened.accountId = accountId;
    playwrightService._trackBrowser(accountId, opened.browser);
    const page = opened.page;

    const restored = await playwrightService.restoreSession(page, 'linkedin', accountId);
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2500));
    const url = page.url();
    const info = await page
      .evaluate(() => {
        const text = (document.body?.innerText || '').slice(0, 800);
        return {
          loggedIn: /Start a post|Messaging|My Network|Notifications/i.test(text),
          checkpoint: /quick security check|verify you.?re human|I.?m not a robot|reCAPTCHA/i.test(text),
          authwall: /Sign in|Join now|Welcome Back/i.test(text) && /Email or phone|Forgot password/i.test(text),
          snippet: text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4).join(' | '),
        };
      })
      .catch(() => ({}));
    return { id: accountId, email, restored, url: url.slice(0, 70), ...info };
  } catch (e) {
    return { id: accountId, email, error: (e.message || String(e)).slice(0, 120) };
  } finally {
    if (browser) await browser.close().catch(() => {});
    playwrightService._untrackBrowser(accountId);
  }
}

(async () => {
  const params = [];
  let filter = '';
  if (IDS) {
    params.push(IDS.split(',').map((s) => Number(s.trim())).filter(Boolean));
    filter = `AND id = ANY($${params.length}::int[])`;
  }
  params.push(LIMIT);
  const { rows } = await pool.query(
    `SELECT id, email FROM social_accounts
     WHERE platform='linkedin' AND (credentials->>'session_dead')='true' ${filter}
     ORDER BY id LIMIT $${params.length}`,
    params
  );
  // Reactivate bindings so proxy is usable.
  await pool.query(
    `UPDATE social_account_proxies SET is_active=true WHERE social_account_id=ANY($1::int[])`,
    [rows.map((r) => r.id)]
  );
  console.log(`Probing ${rows.length} accounts (cookie-only, via proxy)...`);
  for (const r of rows) {
    const res = await probe(r.id, r.email);
    console.log(JSON.stringify(res));
  }
  await pool.end();
})().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});
