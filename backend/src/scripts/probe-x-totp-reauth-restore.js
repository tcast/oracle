#!/usr/bin/env node
/**
 * Follow-up: restore handle if probe renamed it; probe Account information reauth UI.
 * Usage: node src/scripts/probe-x-totp-reauth-restore.js <accountId> [restoreUsername]
 */
require('dotenv').config();
const path = require('path');
const playwrightService = require('../services/playwrightService');

const SHOT = process.env.X_LOGIN_SCREENSHOT_DIR || '/tmp';

async function shot(page, accountId, label) {
  const p = path.join(SHOT, `x-totp-probe-${accountId}-${label}.png`);
  await page.screenshot({ path: p, fullPage: true }).catch(() => {});
  console.log('SHOT', p);
}

async function pageState(page) {
  return page.evaluate(() => {
    const text = (document.body?.innerText || '').slice(0, 4000);
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    return {
      url: location.href,
      hasPassword: !!document.querySelector('input[type="password"]'),
      hasCodeInput: !!document.querySelector(
        'input[data-testid="ocfEnterTextTextInput"], input[autocomplete="one-time-code"], input[inputmode="numeric"]'
      ),
      asksPassword: /enter your password|confirm your password|current password|verify your password/i.test(text),
      asksTotp: /authenticator|authentication app|verification code|Enter (the )?code|6.?digit/i.test(text),
      sidebarHandle: (
        document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')?.innerText || ''
      )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80),
      snippet: lines.slice(0, 16).join(' | '),
      buttons: [...document.querySelectorAll('button, [role="button"], a')]
        .map((el) => (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
        .filter((t) => /password|authenticator|verif|code|confirm|cancel|next|2fa|security|app/i.test(t))
        .slice(0, 15),
    };
  });
}

async function main() {
  const accountId = Number(process.argv[2]);
  const restoreTo = (process.argv[3] || '').replace(/^@/, '').trim();
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
    const totpSecret = creds.totp_secret || creds.totp || creds.twofa;

    await playwrightService.ensureLoggedIn(page, 'x', accountId, account.username, creds.password, {
      allowLogin: false,
      totpSecret,
    });

    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await playwrightService.humanLikeDelay(2000, 3000);
    let st = await pageState(page);
    console.log('LIVE_SIDEBAR', JSON.stringify(st));
    await shot(page, accountId, '10-live-sidebar');

    if (restoreTo) {
      console.log(`Restoring handle → @${restoreTo} (cookie only, no password)`);
      const result = await playwrightService.updateXUsername(page, restoreTo, {
        accountId,
        currentUsername: null,
        password: null, // intentional: prove cookie-only
      });
      console.log('RESTORE_RESULT', JSON.stringify(result));
      await shot(page, accountId, '11-after-restore');
      st = await pageState(page);
      console.log('AFTER_RESTORE', JSON.stringify(st));
    }

    // Probe sensitive "Account information" — often password-gates
    await page.goto('https://x.com/settings/account', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await playwrightService.humanLikeDelay(2000, 3000);
    await page
      .evaluate(() => {
        const links = [...document.querySelectorAll('a, span, div[role="button"], button')];
        const hit = links.find((el) =>
          /^Account information$/i.test((el.innerText || '').trim().split('\n')[0] || '')
        );
        if (hit) {
          hit.click();
          return true;
        }
        const href = document.querySelector('a[href*="your_twitter_data"], a[href*="account/info"]');
        if (href) {
          href.click();
          return true;
        }
        return false;
      })
      .catch(() => false);
    await playwrightService.humanLikeDelay(2500, 4000);
    st = await pageState(page);
    console.log('ACCOUNT_INFO_REAUTH', JSON.stringify(st));
    await shot(page, accountId, '12-account-info');

    // If password prompt: look for TOTP alternate; do NOT submit password
    if (st.hasPassword || st.asksPassword) {
      const switched = await page
        .evaluate(() => {
          const els = [...document.querySelectorAll('a, button, [role="button"], span')];
          const match = els.find((el) =>
            /authenticator|authentication app|verification code|use (a )?code|enter code instead|two.?factor/i.test(
              (el.innerText || el.getAttribute('aria-label') || '').trim()
            )
          );
          if (match) {
            match.click();
            return (match.innerText || '').trim().slice(0, 80);
          }
          return null;
        })
        .catch(() => null);
      console.log('ALT_AUTH_CLICK', switched);
      if (switched) {
        await playwrightService.humanLikeDelay(2000, 3500);
        st = await pageState(page);
        console.log('AFTER_ALT', JSON.stringify(st));
        await shot(page, accountId, '13-account-info-alt');
        if ((st.asksTotp || st.hasCodeInput) && totpSecret && !st.hasPassword) {
          const handled = await playwrightService.handleXTotpChallenge(page, account.username, {
            totpSecret,
          });
          console.log('TOTP_ONLY_ON_ACCOUNT_INFO', handled);
          await shot(page, accountId, '14-totp-only-account-info');
          st = await pageState(page);
          console.log('POST_TOTP', JSON.stringify(st));
        }
      }
    }

    console.log(
      JSON.stringify(
        {
          accountId,
          restoreTo: restoreTo || null,
          finalSidebar: st.sidebarHandle,
          accountInfoAsksPassword: !!(st.asksPassword || st.hasPassword),
          accountInfoAsksTotp: !!(st.asksTotp || st.hasCodeInput),
        },
        null,
        2
      )
    );
  } finally {
    await browser.close().catch(() => {});
    process.exit(0);
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
