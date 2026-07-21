#!/usr/bin/env node
/**
 * Debug-only: session → prefs → update_password + form → dump status (no re-login).
 * Usage: node src/scripts/debug-reddit-pw-change-status.js [accountId]
 */
require('dotenv').config();
const pool = require('../services/db');
const playwrightService = require('../services/playwrightService');
const { generatePassword } = require('../utils/passwordGenerator');

async function main() {
  const id = Number(process.argv[2] || 33);
  const { rows } = await pool.query('SELECT * FROM social_accounts WHERE id=$1', [id]);
  const a = rows[0];
  if (!a) throw new Error('missing');
  const creds = typeof a.credentials === 'string' ? JSON.parse(a.credentials) : a.credentials;
  const newPassword = generatePassword(16).replace(/[^A-Za-z0-9!@#$%&*_\-]/g, 'A');

  const result = await playwrightService.createBrowserForAccount(id, 2, {
    requireProxy: true,
    forceDesktop: true,
  });
  const page = result.page;
  try {
    const loggedIn = await playwrightService.ensureLoggedIn(
      page,
      'reddit',
      id,
      a.username,
      creds.password
    );
    console.log('loggedIn', loggedIn);

    await page.goto('https://old.reddit.com/prefs/update/', {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });
    await playwrightService.humanLikeDelay(2500, 4000);

    const modhash = await page.evaluate(() => {
      if (window.reddit?.modhash) return window.reddit.modhash;
      const m = document.body.innerHTML.match(/modhash["']\s*:\s*["']([^"']+)/);
      return m?.[1] || document.querySelector('input[name="uh"]')?.value || null;
    });
    console.log('modhash', !!modhash, (modhash || '').slice(0, 8));

    // 1) Wrong password — prove the endpoint validates (not a no-op stub)
    const apiBad = await page.evaluate(
      async ({ uh }) => {
        const body = new URLSearchParams({
          curpass: 'DefinitelyWrongPassword123!',
          newpass: 'TempNewPass123!x',
          verpass: 'TempNewPass123!x',
          uh,
          api_type: 'json',
        });
        const res = await fetch('/api/update_password', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'x-modhash': uh,
          },
          body: body.toString(),
        });
        return { status: res.status, text: (await res.text()).slice(0, 1500) };
      },
      { uh: modhash }
    );
    console.log('api_wrong_curpass', JSON.stringify(apiBad));

    // 2) Correct password change
    const api = await page.evaluate(
      async ({ curpass, newpass, uh }) => {
        const body = new URLSearchParams({
          curpass,
          newpass,
          verpass: newpass,
          uh,
          api_type: 'json',
        });
        const res = await fetch('/api/update_password', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'x-modhash': uh,
          },
          body: body.toString(),
        });
        const text = await res.text();
        return { status: res.status, text: text.slice(0, 1500) };
      },
      { curpass: creds.password, newpass: newPassword, uh: modhash }
    );
    console.log('api_correct', JSON.stringify(api));

    await page.evaluate(
      ({ curpass, newpass }) => {
        const cur = document.querySelector('input[name="curpass"]');
        const neu = document.querySelector('input[name="newpass"]');
        const ver = document.querySelector('input[name="verpass"]');
        if (cur) cur.value = curpass;
        if (neu) neu.value = newpass;
        if (ver) ver.value = newpass;
        const form = cur?.form;
        const submit = form?.querySelector('button[type="submit"], input[type="submit"]');
        if (submit) submit.click();
        else form?.submit();
      },
      { curpass: creds.password, newpass: newPassword }
    );
    await playwrightService.humanLikeDelay(4000, 6000);

    const after = await page.evaluate(() => {
      const statuses = [...document.querySelectorAll('.status, #status, .error, .success')].map(
        (el) => (el.textContent || '').trim()
      );
      const pwVals = {
        cur: document.querySelector('input[name="curpass"]')?.value?.length || 0,
        neu: document.querySelector('input[name="newpass"]')?.value?.length || 0,
        ver: document.querySelector('input[name="verpass"]')?.value?.length || 0,
      };
      return {
        url: location.href,
        statuses,
        pwVals,
        body: (document.body?.innerText || '').slice(0, 600),
      };
    });
    console.log('after', JSON.stringify(after, null, 2));
    await page.screenshot({ path: `/tmp/reddit-pw-status-${id}.png`, fullPage: true });
    console.log('newPasswordLength', newPassword.length, '(not persisted)');
  } finally {
    await result.browser.close().catch(() => {});
    await pool.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
