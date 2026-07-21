#!/usr/bin/env node
/**
 * Diagnostic: cookie session → profile → Edit profile → dump inputs/screenshots.
 * Usage: X_PERSONA_LIVE=1 node src/scripts/probe-x-edit-profile.js <accountId>
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

    const steps = [
      ['settings', 'https://x.com/settings/profile'],
      ['profile', `https://x.com/${account.username}`],
      ['home', 'https://x.com/home'],
    ];

    for (const [label, url] of steps) {
      console.log(`\n=== ${label}: ${url} ===`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
        console.log('goto err', e.message);
      });
      await playwrightService.humanLikeDelay(3000, 4500);
      const shot = `/tmp/x-probe-${accountId}-${label}.png`;
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      const info = await page.evaluate(() => {
        const text = (document.body?.innerText || '').slice(0, 1500);
        const buttons = [...document.querySelectorAll('a, button, [role="button"]')]
          .map((el) => ({
            tag: el.tagName,
            testid: el.getAttribute('data-testid'),
            aria: el.getAttribute('aria-label'),
            href: el.getAttribute('href'),
            text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80),
          }))
          .filter(
            (b) =>
              /edit|profile|settings|photo|avatar|save/i.test(
                `${b.testid || ''} ${b.aria || ''} ${b.text || ''} ${b.href || ''}`
              )
          )
          .slice(0, 40);
        const inputs = [...document.querySelectorAll('input, textarea')].slice(0, 30).map((el) => ({
          tag: el.tagName,
          name: el.getAttribute('name'),
          testid: el.getAttribute('data-testid'),
          type: el.getAttribute('type'),
          placeholder: el.getAttribute('placeholder'),
          aria: el.getAttribute('aria-label'),
        }));
        return { url: location.href, buttons, inputs, textSnippet: text.slice(0, 400) };
      });
      console.log(JSON.stringify(info, null, 2));
      console.log('shot', shot);
    }

    // Try click Edit profile on profile page
    await page.goto(`https://x.com/${account.username}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await playwrightService.humanLikeDelay(3000, 4500);
    const clicked = await page.evaluate(() => {
      const candidates = [...document.querySelectorAll('a, button, [role="button"]')];
      for (const el of candidates) {
        const t = `${el.getAttribute('data-testid') || ''} ${el.getAttribute('aria-label') || ''} ${(el.innerText || '').trim()}`;
        if (/editProfileButton|Edit profile/i.test(t)) {
          el.click();
          return t.slice(0, 120);
        }
      }
      return null;
    });
    console.log('\nclicked edit?', clicked);
    await playwrightService.humanLikeDelay(2500, 4000);
    await page.screenshot({ path: `/tmp/x-probe-${accountId}-after-edit.png`, fullPage: true }).catch(() => {});
    const after = await page.evaluate(() => ({
      url: location.href,
      inputs: [...document.querySelectorAll('input, textarea')].slice(0, 30).map((el) => ({
        tag: el.tagName,
        name: el.getAttribute('name'),
        testid: el.getAttribute('data-testid'),
        type: el.getAttribute('type'),
        placeholder: el.getAttribute('placeholder'),
        aria: el.getAttribute('aria-label'),
      })),
      dialogs: [...document.querySelectorAll('[role="dialog"], [data-testid="sheetDialog"]')].map(
        (d) => (d.innerText || '').slice(0, 200)
      ),
    }));
    console.log(JSON.stringify(after, null, 2));
  } finally {
    await browser.close().catch(() => {});
    playwrightService._untrackBrowser(accountId);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
