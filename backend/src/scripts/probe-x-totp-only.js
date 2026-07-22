#!/usr/bin/env node
/**
 * Probe: can TOTP alone satisfy X login challenge or username-change reauth?
 *
 * Cookie-first. Does NOT submit password.
 * On settings rename Save: documents password vs 2FA prompt; if 2FA, submits TOTP.
 *
 * Usage (inside whisper-backend):
 *   node src/scripts/probe-x-totp-only.js <accountId>
 *   PROBE_TRY_RENAME=1 node src/scripts/probe-x-totp-only.js <accountId>
 *
 * Screenshots → /tmp/x-totp-probe-<id>-*.png (copy out after).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const playwrightService = require('../services/playwrightService');

const SHOT = process.env.X_LOGIN_SCREENSHOT_DIR || '/tmp';
const TRY_RENAME = process.env.PROBE_TRY_RENAME === '1';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function shot(page, accountId, label) {
  const p = path.join(SHOT, `x-totp-probe-${accountId}-${label}.png`);
  await page.screenshot({ path: p, fullPage: true }).catch(() => {});
  console.log(`SHOT ${p}`);
  return p;
}

async function pageState(page) {
  return page
    .evaluate(() => {
      const text = (document.body?.innerText || '').slice(0, 4500);
      const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const inputs = [...document.querySelectorAll('input')]
        .filter((el) => el.offsetParent !== null)
        .map((el) => ({
          type: el.type,
          name: el.name,
          autocomplete: el.autocomplete,
          testid: el.getAttribute('data-testid'),
          inputmode: el.getAttribute('inputmode'),
          placeholder: el.placeholder,
        }));
      const buttons = [...document.querySelectorAll('button, [role="button"], a')]
        .map((el) => (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .filter((t) =>
          /password|authenticator|verif|code|confirm|save|cancel|next|2fa|two.?factor|security|app/i.test(
            t
          )
        )
        .slice(0, 20);
      return {
        url: location.href,
        hasHome: !!document.querySelector(
          '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Home_Link"], [aria-label="Home timeline"]'
        ),
        hasPassword: !!document.querySelector('input[type="password"]'),
        hasCodeInput: !!document.querySelector(
          'input[data-testid="ocfEnterTextTextInput"], input[autocomplete="one-time-code"], input[inputmode="numeric"]'
        ),
        snippet: lines.slice(0, 18).join(' | '),
        inputs,
        buttons,
        asksPassword: /enter your password|confirm your password|current password|verify your password/i.test(
          text
        ),
        asksTotp:
          /authenticator|authentication app|authentication code|verification code|Enter (the )?code|6.?digit/i.test(
            text
          ),
        loginWall: /\/i\/flow\/login|\/login/i.test(location.href),
      };
    })
    .catch((e) => ({ error: e.message }));
}

async function main() {
  const accountId = Number(process.argv[2]);
  if (!accountId) throw new Error('Usage: node probe-x-totp-only.js <accountId>');

  const verdict = {
    accountId,
    cookieAlive: false,
    loginChallengeAfterCookie: null,
    settingsReauth: null,
    totpSubmitted: false,
    totpUnlocked: false,
    renameCanUseTotpOnly: null,
    notes: [],
  };

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
    if (!totpSecret) throw new Error('no totp_secret');
    verdict.username = account.username;
    verdict.hasPassword = !!(creds.password && String(creds.password).trim());
    console.log(
      `PROBE account=#${accountId} @${account.username} hasPassword=${verdict.hasPassword} totpLen=${String(totpSecret).length}`
    );

    // --- 1) Cookie restore only (no password login) ---
    let cookieOk = false;
    try {
      cookieOk = await playwrightService.ensureLoggedIn(
        page,
        'x',
        accountId,
        account.username,
        creds.password,
        { allowLogin: false, totpSecret }
      );
    } catch (e) {
      verdict.notes.push(`cookie_ensure: ${e.message}`);
      console.log('cookie ensure failed:', e.message);
    }
    verdict.cookieAlive = !!cookieOk;

    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await playwrightService.humanLikeDelay(2000, 3500);
    await playwrightService.dismissXConsent(page).catch(() => {});
    let st = await pageState(page);
    console.log('HOME_STATE', JSON.stringify(st));
    await shot(page, accountId, '01-home');

    // If cookie dead and we landed on a 2FA/login challenge — try TOTP only (no password)
    if (!cookieOk || st.loginWall || (!st.hasHome && (st.asksTotp || st.hasCodeInput))) {
      verdict.loginChallengeAfterCookie = st;
      console.log('Attempting TOTP-only on challenge (no password submit)...');
      const handled = await playwrightService.handleXTotpChallenge(page, account.username, {
        totpSecret,
      });
      verdict.totpSubmitted = handled === true;
      await shot(page, accountId, '02-after-totp-challenge');
      st = await pageState(page);
      console.log('AFTER_TOTP_CHALLENGE', JSON.stringify({ handled, ...st }));
      if (st.hasHome && !st.loginWall) {
        verdict.totpUnlocked = true;
        verdict.cookieAlive = true;
        verdict.notes.push('TOTP alone cleared post-cookie challenge / login wall');
      } else if (handled === 'rate_limited') {
        verdict.notes.push('rate_limited on TOTP');
        console.log(JSON.stringify({ verdict }, null, 2));
        return;
      } else {
        verdict.notes.push('TOTP alone did not unlock login wall (password likely required first)');
      }
    }

    if (!verdict.cookieAlive) {
      verdict.renameCanUseTotpOnly = false;
      verdict.notes.push('No live cookie session — cannot probe settings rename reauth');
      console.log(JSON.stringify({ verdict }, null, 2));
      return;
    }

    // --- 2) Settings username page — inspect reauth ---
    await page.goto('https://x.com/settings/screen_name', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    // Wait for Change username panel (not just shell + settings search)
    await page
      .waitForFunction(
        () => {
          const t = document.body?.innerText || '';
          return /Change username|Your account/i.test(t) && document.querySelectorAll('input').length >= 1;
        },
        { timeout: 25000 }
      )
      .catch(() => null);
    await playwrightService.humanLikeDelay(1500, 2500);
    st = await pageState(page);
    console.log('SCREEN_NAME_STATE', JSON.stringify(st));
    await shot(page, accountId, '03-screen-name');

    // Prefer the Username field in "Change username" — NEVER the Settings search box
    const input = await page
      .evaluateHandle(() => {
        const prefer = document.querySelector(
          'input[name="username"], input[name="screen_name"], input[autocomplete="username"]'
        );
        if (prefer && prefer.offsetParent) return prefer;
        const inputs = [...document.querySelectorAll('input[type="text"], input:not([type])')].filter(
          (el) => el.offsetParent
        );
        // Skip settings search (placeholder Search / aria search)
        const candidates = inputs.filter((el) => {
          const ph = (el.placeholder || '').toLowerCase();
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          const testid = (el.getAttribute('data-testid') || '').toLowerCase();
          if (/search/.test(ph + aria + testid)) return false;
          return true;
        });
        // Prefer input whose nearby label/text says Username
        for (const el of candidates) {
          const root = el.closest('label, div, section, form') || el.parentElement;
          const ctx = (root?.innerText || '').slice(0, 200);
          if (/^username$/im.test(ctx) || /Change username/i.test(ctx)) return el;
        }
        // Fallback: last non-search text input (detail pane is usually rightmost)
        return candidates[candidates.length - 1] || null;
      })
      .then((h) => h.asElement())
      .catch(() => null);

    if (!input) {
      verdict.notes.push('username input missing on settings/screen_name');
      verdict.renameCanUseTotpOnly = null;
      console.log(JSON.stringify({ verdict }, null, 2));
      return;
    }

    const currentVal = await input.inputValue().catch(() => account.username);
    // Soft probe: type a temporary handle, Save, inspect modal — only commit if PROBE_TRY_RENAME=1 + TOTP works
    const probeHandle = String(currentVal || account.username)
      .replace(/^@/, '')
      .slice(0, 12);
    const alt = `${probeHandle.replace(/_+$/, '').slice(0, 11)}_${Math.floor(Math.random() * 90 + 10)}`.slice(
      0,
      15
    );
    console.log(`Typing probe handle @${alt} (current=@${currentVal}) TRY_RENAME=${TRY_RENAME}`);
    await playwrightService.humanTypeInto(input, alt, { clear: true, confirm: false });
    await playwrightService.humanLikeDelay(1200, 2000);

    // Save in the Change username detail pane (not a random Save elsewhere)
    const save = await page
      .evaluateHandle(() => {
        const byTest = document.querySelector('[data-testid="settingsDetailSave"]');
        if (byTest) return byTest;
        const buttons = [...document.querySelectorAll('button, [role="button"]')];
        // Prefer Save near "Change username"
        const detail = [...document.querySelectorAll('section, div')].find((el) =>
          /^Change username/m.test((el.innerText || '').slice(0, 80))
        );
        const scope = detail || document;
        const scoped = [...scope.querySelectorAll('button, [role="button"]')].find(
          (b) => /^(Save|Done|Next)$/i.test((b.innerText || '').trim())
        );
        if (scoped) return scoped;
        return buttons.find((b) => /^(Save)$/i.test((b.innerText || '').trim())) || null;
      })
      .then((h) => h.asElement())
      .catch(() => null);
    if (save) {
      await save.click().catch(() => {});
      await playwrightService.humanLikeDelay(3000, 5000);
    } else {
      verdict.notes.push('Save button not found after typing username');
    }

    st = await pageState(page);
    verdict.settingsReauth = {
      asksPassword: !!st.asksPassword || !!st.hasPassword,
      asksTotp: !!st.asksTotp || !!st.hasCodeInput,
      hasPassword: !!st.hasPassword,
      hasCodeInput: !!st.hasCodeInput,
      buttons: st.buttons,
      snippet: st.snippet,
      url: st.url,
    };
    console.log('REAUTH_AFTER_SAVE', JSON.stringify(verdict.settingsReauth));
    await shot(page, accountId, '04-reauth-prompt');

    // Look for alternate "use authentication app" / code path without password
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
    if (switched) {
      verdict.notes.push(`clicked alternate auth: ${switched}`);
      await playwrightService.humanLikeDelay(2000, 3500);
      st = await pageState(page);
      console.log('AFTER_ALT_AUTH_CLICK', JSON.stringify(st));
      await shot(page, accountId, '05-alt-auth');
      verdict.settingsReauth.afterAlt = {
        asksPassword: !!st.asksPassword || !!st.hasPassword,
        asksTotp: !!st.asksTotp || !!st.hasCodeInput,
        snippet: st.snippet,
        buttons: st.buttons,
      };
    }

    // If TOTP UI is present (with or without password also present), try TOTP-only submit
    const reauth = verdict.settingsReauth;
    const totpUi = reauth.asksTotp || reauth.hasCodeInput || reauth.afterAlt?.asksTotp;
    const pwUi = reauth.asksPassword || reauth.hasPassword || reauth.afterAlt?.asksPassword;

    if (totpUi && !pwUi) {
      console.log('Reauth is TOTP-only — submitting authenticator code');
      const handled = await playwrightService.handleXTotpChallenge(page, account.username, {
        totpSecret,
      });
      verdict.totpSubmitted = handled === true || verdict.totpSubmitted;
      await shot(page, accountId, '06-totp-reauth-post');
      st = await pageState(page);
      const stillPw = st.hasPassword || st.asksPassword;
      const stillChallenge = st.hasCodeInput && st.asksTotp;
      verdict.totpUnlocked = !stillPw && !stillChallenge && !/wrong|incorrect|invalid/i.test(st.snippet || '');
      verdict.renameCanUseTotpOnly = !!verdict.totpUnlocked;
      verdict.notes.push(
        verdict.totpUnlocked
          ? 'TOTP-only reauth appeared to clear username Save'
          : 'TOTP-only UI shown but unlock unclear'
      );
    } else if (totpUi && pwUi) {
      verdict.renameCanUseTotpOnly = false;
      verdict.notes.push('Reauth shows BOTH password and TOTP — password still required');
      // Do NOT submit password; optionally try TOTP into code field if separate
      if (st.hasCodeInput) {
        const handled = await playwrightService.handleXTotpChallenge(page, account.username, {
          totpSecret,
        });
        verdict.totpSubmitted = handled === true || verdict.totpSubmitted;
        await shot(page, accountId, '06-totp-with-pw-field');
        st = await pageState(page);
        if (st.hasPassword && /wrong|incorrect|enter your password/i.test(st.snippet || '')) {
          verdict.notes.push('TOTP alone insufficient while password field still required');
        }
      }
    } else if (pwUi && !totpUi) {
      verdict.renameCanUseTotpOnly = false;
      verdict.notes.push('Reauth is password-only — no TOTP alternate found');
      // Abort: restore original username text without confirming password
      await playwrightService.humanTypeInto(input, String(currentVal).replace(/^@/, ''), {
        clear: true,
        confirm: false,
      }).catch(() => {});
      await shot(page, accountId, '06-password-only-aborted');
    } else {
      verdict.notes.push('No reauth prompt after Save (or Save did nothing)');
      // If no prompt and TRY_RENAME, username may have changed without reauth — rare
      if (TRY_RENAME) {
        verdict.renameCanUseTotpOnly = null;
        verdict.notes.push('PROBE_TRY_RENAME set but no reauth — check if rename applied without auth');
      } else {
        verdict.renameCanUseTotpOnly = null;
      }
      await shot(page, accountId, '06-no-reauth');
    }

    // Cancel any open sheet without password
    await page.keyboard.press('Escape').catch(() => {});
    await playwrightService.humanLikeDelay(500, 1000);

    console.log('\n=== VERDICT ===');
    console.log(JSON.stringify(verdict, null, 2));
    fs.writeFileSync(
      path.join(SHOT, `x-totp-probe-${accountId}-verdict.json`),
      JSON.stringify(verdict, null, 2)
    );
  } finally {
    await browser.close().catch(() => {});
    await sleep(500);
    process.exit(0);
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
