/**
 * Drive one account to the LinkedIn login checkpoint and dump everything needed
 * to solve the reCAPTCHA: all frame URLs (with k= sitekey), any [data-sitekey],
 * grecaptcha presence, and captured recaptcha network requests. Read-only diag.
 *
 * Usage: node src/scripts/probe-linkedin-checkpoint-sitekey.js --ids=280
 */
const pool = require('../services/db');
const playwrightService = require('../services/playwrightService');

const IDS = (process.argv.find((a) => a.startsWith('--ids=')) || '').split('=')[1];

(async () => {
  const id = Number((IDS || '').split(',')[0]);
  const { rows } = await pool.query(
    `SELECT id, email, credentials FROM social_accounts WHERE id = $1`,
    [id]
  );
  const account = rows[0];
  const creds = typeof account.credentials === 'string' ? JSON.parse(account.credentials) : account.credentials;
  await pool.query(`UPDATE social_account_proxies SET is_active=true WHERE social_account_id=$1`, [id]);

  const opened = await playwrightService.createBrowserForAccount(id, 2, { requireProxy: true });
  const { browser, page } = opened;
  playwrightService._trackBrowser(id, browser);

  const netKeys = new Set();
  page.on('request', (req) => {
    const u = req.url();
    if (/recaptcha\/(api2|enterprise)\/(anchor|reload|bframe)/i.test(u)) {
      const m = u.match(/[?&]k=([^&]+)/);
      if (m) netKeys.add(decodeURIComponent(m[1]));
    }
  });

  try {
    // Load login, submit password to reach checkpoint.
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 2500));
    const emailEl = await page.$('input[type="email"]:visible, #username, input[name="session_key"]')
      || (await page.$$('input[type="email"]'))[0];
    await emailEl.fill(account.email);
    const pwdEl = await page.$('input[type="password"]:visible, #password, input[name="session_password"]')
      || (await page.$$('input[type="password"]'))[0];
    await pwdEl.fill(creds.password);
    await page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 8000));

    // reCAPTCHA anchor sometimes loads only after the captchaInternal iframe settles.
    await new Promise((r) => setTimeout(r, 6000));
    const url = page.url();

    // Drill into the captchaInternal iframe for nested sitekey / iframe srcs.
    const frameDumps = [];
    for (const f of page.frames()) {
      const fu = f.url() || '';
      if (/captchaInternal|captcha/i.test(fu)) {
        const d = await f
          .evaluate(() => {
            const el = document.querySelector('[data-sitekey], .g-recaptcha[data-sitekey]');
            const iframes = [...document.querySelectorAll('iframe')].map((i) => i.src).filter(Boolean);
            return {
              dataSitekey: el ? el.getAttribute('data-sitekey') : null,
              iframes,
              hasGrecaptcha: !!window.grecaptcha,
              hasEnterprise: !!(window.grecaptcha && window.grecaptcha.enterprise),
              htmlSnippet: (document.documentElement.outerHTML || '').slice(0, 1200),
            };
          })
          .catch((e) => ({ evalError: e.message }));
        frameDumps.push({ url: fu.slice(0, 90), ...d });
      }
    }

    const frames = page.frames().map((f) => f.url()).filter((u) => u && u !== 'about:blank');
    const recaptchaFrames = frames.filter((u) => /recaptcha|gstatic|google\.com\/recaptcha/i.test(u));
    const frameKeys = [];
    for (const u of recaptchaFrames) {
      const m = u.match(/[?&]k=([^&]+)/);
      if (m) frameKeys.push(decodeURIComponent(m[1]));
    }
    const dom = await page.evaluate(() => {
      const el = document.querySelector('[data-sitekey], .g-recaptcha[data-sitekey]');
      return {
        dataSitekey: el ? el.getAttribute('data-sitekey') : null,
        hasGrecaptcha: !!window.grecaptcha,
        hasEnterprise: !!(window.grecaptcha && window.grecaptcha.enterprise),
        bodyHead: (document.body?.innerText || '').slice(0, 200),
      };
    }).catch(() => ({}));

    console.log(JSON.stringify({
      id,
      url: url.slice(0, 90),
      allFrames: frames,
      recaptchaFrames,
      frameKeys,
      netKeys: [...netKeys],
      frameDumps,
      dom,
    }, null, 2));
    await page.screenshot({ path: `/tmp/li-checkpoint-probe-${id}.png` }).catch(() => {});
  } catch (e) {
    console.log(JSON.stringify({ id, error: e.message, netKeys: [...netKeys] }));
  } finally {
    await browser.close().catch(() => {});
    playwrightService._untrackBrowser(id);
    await pool.end();
  }
})().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
