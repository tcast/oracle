#!/usr/bin/env node
/**
 * Probe X "Set up profile" onboarding flow (photo → name → bio …).
 * Usage: node src/scripts/probe-x-setup-flow.js <accountId>
 */
require('dotenv').config();
const playwrightService = require('../services/playwrightService');

async function dump(page, label) {
  const data = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]') || document.body;
    const text = (dialog.innerText || '').slice(0, 600);
    const inputs = [...document.querySelectorAll('input,textarea,[contenteditable="true"]')].map(
      (el) => ({
        tag: el.tagName,
        name: el.getAttribute('name'),
        testid: el.getAttribute('data-testid'),
        type: el.getAttribute('type'),
        ph: el.getAttribute('placeholder'),
        aria: el.getAttribute('aria-label'),
        ce: el.getAttribute('contenteditable'),
        text: (el.innerText || '').slice(0, 40),
      })
    );
    const buttons = [...document.querySelectorAll('button, [role="button"]')]
      .map((b) => (b.innerText || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 25);
    return { url: location.href, text, inputs, buttons };
  });
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(data, null, 2));
  return data;
}

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
    await page.click('[data-testid="AppTabBar_Profile_Link"]');
    await playwrightService.humanLikeDelay(3000, 4500);

    const setupSel =
      '[data-testid="editProfileButton"], [aria-label="Edit profile"], [aria-label="Set up profile"]';
    await page.waitForSelector(setupSel, { timeout: 45000 }).catch(() => null);
    let btn =
      (await page.$(setupSel)) ||
      (await page.locator('button:has-text("Set up profile"), a:has-text("Set up profile"), button:has-text("Edit profile")').first().elementHandle().catch(() => null));
    if (!btn) {
      await dump(page, 'no-setup-btn');
      await page.screenshot({ path: `/tmp/x-setup-${accountId}-nosetup.png`, fullPage: true });
      throw new Error('Set up / Edit profile button not found');
    }
    console.log(
      'btn',
      await btn.getAttribute('data-testid'),
      await btn.innerText().catch(() => '')
    );
    await btn.click();
    await playwrightService.humanLikeDelay(2500, 4000);
    await page.screenshot({ path: `/tmp/x-setup-${accountId}-step0.png`, fullPage: true });
    await dump(page, 'after-setup-click');

    for (let step = 0; step < 6; step++) {
      const skip = await page
        .locator('button:has-text("Skip for now"), [role="button"]:has-text("Skip for now")')
        .first()
        .elementHandle()
        .catch(() => null);
      if (skip) {
        console.log('click Skip for now');
        await skip.click();
        await playwrightService.humanLikeDelay(2500, 4000);
        await page.screenshot({ path: `/tmp/x-setup-${accountId}-skip${step}.png`, fullPage: true });
        await dump(page, `after-skip-${step}`);
        continue;
      }

      const next = await page
        .locator('button:has-text("Next"), [role="button"]:has-text("Next")')
        .first()
        .elementHandle()
        .catch(() => null);
      if (next) {
        console.log('click Next');
        await next.click();
        await playwrightService.humanLikeDelay(2500, 4000);
        await page.screenshot({ path: `/tmp/x-setup-${accountId}-next${step}.png`, fullPage: true });
        await dump(page, `after-next-${step}`);
        continue;
      }

      break;
    }

    await dump(page, 'final');
  } finally {
    await browser.close().catch(() => {});
    playwrightService._untrackBrowser(accountId);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
