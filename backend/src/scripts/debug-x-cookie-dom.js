#!/usr/bin/env node
require('dotenv').config();
const playwrightService = require('../services/playwrightService');
const pool = require('../services/db');

const accountId = Number(process.argv[2] || 601);

(async () => {
  await playwrightService.requireProxyForLive(accountId);
  const { browser, page } = await playwrightService.createBrowserForAccount(accountId, 2, {
    requireProxy: true,
  });
  try {
    await playwrightService.restoreSession(page, 'x', accountId);
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise((r) => setTimeout(r, 8000));
    const info = await page.evaluate(() => {
      const all = [...document.querySelectorAll('[data-testid]')].map((el) =>
        el.getAttribute('data-testid')
      );
      const uniq = [...new Set(all)].filter((t) =>
        /Side|Account|User|Nav|Avatar|Profile|Post|Tweet/i.test(t)
      );
      const switcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
      return {
        url: location.href,
        testids: uniq.slice(0, 120),
        hasSwitcher: !!switcher,
        switcherText: (switcher?.innerText || '').replace(/\s+/g, ' ').trim(),
        hasPrimary: !!document.querySelector('[data-testid="primaryColumn"]'),
        bodyTail: (document.body?.innerText || '').split('\n').slice(-25),
      };
    });
    console.log(JSON.stringify(info, null, 2));
  } finally {
    await browser.close().catch(() => {});
    playwrightService._untrackBrowser(accountId);
    await pool.end();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
