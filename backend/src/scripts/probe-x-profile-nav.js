#!/usr/bin/env node
/**
 * Probe: home → click Profile sidebar → wait Edit profile → dump inputs.
 * Usage: node src/scripts/probe-x-profile-nav.js <accountId>
 */
require('dotenv').config();
const playwrightService = require('../services/playwrightService');

async function main() {
  const accountId = Number(process.argv[2]);
  if (!accountId) throw new Error('accountId required');

  await playwrightService.requireProxyForLive(accountId);
  const { browser, page } = await playwrightService.createBrowserForAccount(accountId, 2, {
    requireProxy: true,
  });
  try {
    const account = await playwrightService.getAccount(accountId);
    const creds =
      typeof account.credentials === 'string'
        ? JSON.parse(account.credentials)
        : account.credentials || {};
    const loggedIn = await playwrightService.ensureLoggedIn(
      page,
      'x',
      accountId,
      account.username,
      creds.password,
      { allowLogin: false, totpSecret: creds.totp_secret }
    );
    console.log('loggedIn', loggedIn, account.username);
    if (!loggedIn) throw new Error('not logged in');

    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('[data-testid="AppTabBar_Profile_Link"]', { timeout: 30000 });
    await playwrightService.humanLikeDelay(2000, 3000);

    await page.click('[data-testid="AppTabBar_Profile_Link"]');
    console.log('clicked Profile, waiting for edit…');
    await page
      .waitForURL((u) => /x\.com\/[^/]+\/?$/.test(u.href) && !u.href.includes('/home'), {
        timeout: 20000,
      })
      .catch(() => null);

    const editSel =
      '[data-testid="editProfileButton"], [aria-label="Edit profile"]';
    let edit = await page.waitForSelector(editSel, { timeout: 45000 }).catch(() => null);
    console.log('edit found', !!edit, 'url', page.url());
    await page.screenshot({
      path: `/tmp/x-probe-${accountId}-after-profile-click.png`,
      fullPage: true,
    });

    if (!edit) {
      // Longer settle — profile header often late behind spinner
      await playwrightService.humanLikeDelay(8000, 12000);
      edit = await page.$(editSel);
      console.log('edit after settle', !!edit);
      await page.screenshot({
        path: `/tmp/x-probe-${accountId}-after-settle.png`,
        fullPage: true,
      });
    }

    if (!edit) {
      const body = await page.evaluate(() => (document.body?.innerText || '').slice(0, 1000));
      console.log('body', body);
      return;
    }

    await edit.click();
    await playwrightService.humanLikeDelay(3000, 4500);
    await page.screenshot({
      path: `/tmp/x-probe-${accountId}-edit-modal.png`,
      fullPage: true,
    });
    const inputs = await page.evaluate(() =>
      [...document.querySelectorAll('input,textarea')].map((el) => ({
        name: el.getAttribute('name'),
        testid: el.getAttribute('data-testid'),
        type: el.getAttribute('type'),
        ph: el.getAttribute('placeholder'),
        aria: el.getAttribute('aria-label'),
      }))
    );
    console.log('INPUTS', JSON.stringify(inputs, null, 2));
  } finally {
    await browser.close().catch(() => {});
    playwrightService._untrackBrowser(accountId);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
