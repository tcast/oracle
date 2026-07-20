const accountCreationService = require('../services/accountCreationService');
const proxyService = require('../services/proxyService');
const pool = require('../services/db');

(async () => {
  const r = await pool.query(`
    SELECT p.* FROM proxies p
    WHERE p.is_active AND p.country = 'US' AND p.provider ILIKE '%brightdata%'
    ORDER BY p.id
    LIMIT 1`);
  const p = r.rows[0];
  if (!p) throw new Error('No Bright Data US proxy');
  const cfg = proxyService.formatProxyConfig(p);
  console.log('using proxy', p.id, p.provider, p.server);

  const { browser, page } = await accountCreationService.createBrowser(cfg);
  try {
    await page.goto('https://www.reddit.com/register/', {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });
    await page.waitForTimeout(5000);
    const info = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll('input')].map((i) => ({
        type: i.type,
        name: i.name,
        id: i.id,
        placeholder: i.placeholder,
        aria: i.getAttribute('aria-label'),
      }));
      const customs = [
        ...document.querySelectorAll(
          'faceplate-text-input, auth-flow-modal, shreddit-signup, faceplate-tracker'
        ),
      ].map((e) => e.tagName);
      return {
        title: document.title,
        url: location.href,
        inputs,
        customs,
        text: (document.body.innerText || '').slice(0, 800),
      };
    });
    console.log(JSON.stringify(info, null, 2));
    await page.screenshot({ path: '/tmp/reddit-reg-probe2.png', fullPage: true });
    console.log('screenshot /tmp/reddit-reg-probe2.png');
  } catch (e) {
    console.error('PROBE FAIL', e.message);
    try {
      await page.screenshot({ path: '/tmp/reddit-reg-probe-fail.png' });
    } catch (_) {
      /* ignore */
    }
  } finally {
    await browser.close();
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
