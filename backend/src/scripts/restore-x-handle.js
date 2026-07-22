#!/usr/bin/env node
/** Restore X handle via typedScreenName. Usage: node src/scripts/restore-x-handle.js <id> <username> */
require('dotenv').config();
const playwrightService = require('../services/playwrightService');

async function main() {
  const accountId = Number(process.argv[2]);
  const want = String(process.argv[3] || '').replace(/^@/, '').trim();
  if (!accountId || !want) throw new Error('Usage: restore-x-handle.js <id> <username>');

  await playwrightService.requireProxyForLive(accountId);
  const { browser, page } = await playwrightService.createBrowserForAccount(accountId, 2, {
    requireProxy: true,
  });
  try {
    const account = await playwrightService.getAccount(accountId);
    const creds = account.credentials || {};
    await playwrightService.ensureLoggedIn(page, 'x', accountId, account.username, creds.password, {
      allowLogin: false,
      totpSecret: creds.totp_secret,
    });

    await page.goto('https://x.com/settings/screen_name', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await page.waitForSelector('input[name="typedScreenName"]', { timeout: 25000 });
    await playwrightService.humanLikeDelay(1200, 2000);

    const input = await page.$('input[name="typedScreenName"]');
    const before = await input.inputValue();
    console.log({ before, want });
    await playwrightService.humanTypeInto(input, want, { clear: true, confirm: true });
    await playwrightService.humanLikeDelay(1200, 2000);

    const save =
      (await page.$('[data-testid="settingsDetailSave"]')) ||
      (await page.evaluateHandle(() => {
        const b = [...document.querySelectorAll('button')].find((x) =>
          /^Save$/i.test((x.innerText || '').trim())
        );
        return b || null;
      }).then((h) => h.asElement()));
    if (save) {
      await save.click();
      await playwrightService.humanLikeDelay(3500, 5000);
    }

    await page.screenshot({ path: `/tmp/x-totp-probe-${accountId}-15-restored.png`, fullPage: true });
    const st = await page.evaluate(() => ({
      url: location.href,
      sidebar: document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')?.innerText || '',
      val: document.querySelector('input[name="typedScreenName"]')?.value || '',
      hasPw: !!document.querySelector('input[type="password"]'),
      hasCode: !!document.querySelector(
        'input[autocomplete="one-time-code"], input[inputmode="numeric"]'
      ),
      snippet: (document.body?.innerText || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 14)
        .join(' | '),
    }));
    console.log(JSON.stringify(st, null, 2));
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
