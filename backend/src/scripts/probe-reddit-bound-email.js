#!/usr/bin/env node
/**
 * Probe whether bought Reddit accounts still have the DB Hotmail/Outlook
 * email bound in Reddit account settings.
 *
 * Usage (in whisper-backend):
 *   node src/scripts/probe-reddit-bound-email.js [id,id,...]
 *   node src/scripts/probe-reddit-bound-email.js --ids=14,20,24,27,33
 *   TRY_IN_SESSION_CHANGE=1 node src/scripts/probe-reddit-bound-email.js --ids=20
 *
 * Careful: sequential, one browser at a time, long delays. No forgot-password
 * storms. Schedule stays OFF.
 */
require('dotenv').config();
const fs = require('fs');
const pool = require('../services/db');
const playwrightService = require('../services/playwrightService');
const { generatePassword } = require('../utils/passwordGenerator');

const LOG = process.env.PROBE_LOG || '/tmp/reddit-bound-email-probe.jsonl';
const TRY_CHANGE = process.env.TRY_IN_SESSION_CHANGE === '1';
const BETWEEN_MS = Number(process.env.PROBE_BETWEEN_MS || 45000);

function parseCreds(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw;
}

function logRow(obj) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...obj });
  console.log(line);
  try {
    fs.appendFileSync(LOG, `${line}\n`);
  } catch (_) {
    /* ignore */
  }
}

function parseIds() {
  const arg = process.argv.slice(2).find((a) => a && !a.startsWith('--'));
  const flag = process.argv.find((a) => a.startsWith('--ids='));
  const raw = flag ? flag.slice('--ids='.length) : arg || '14,20,24,27,33';
  return raw
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

async function dismissBanners(page) {
  for (const label of ['Accept all', 'Accept', 'I Agree', 'I agree', 'Continue']) {
    const btn = await page.$(`button:has-text("${label}")`);
    if (btn) {
      await btn.click().catch(() => {});
      await playwrightService.humanLikeDelay(400, 800);
    }
  }
}

async function isLoggedInOldReddit(page) {
  try {
    await page.goto('https://old.reddit.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
  } catch (err) {
    return { ok: false, via: 'nav_error', error: String(err.message || err).slice(0, 180) };
  }
  await playwrightService.humanLikeDelay(1500, 2500);
  await dismissBanners(page);
  return page.evaluate(() => {
    const text = (document.body?.innerText || '').slice(0, 3000);
    const userLink = document.querySelector('span.user a, #header-bottom-right .user a');
    const logout = document.querySelector('form.logout, a[href*="logout"]');
    if (userLink && logout) return { ok: true, via: 'header_user', user: userLink.textContent?.trim() };
    if (/preferences|logout/i.test(text) && !/want to join|log in or sign up/i.test(text)) {
      return { ok: true, via: 'body_text' };
    }
    return { ok: false, via: 'logged_out', snippet: text.slice(0, 200) };
  });
}

async function isLoggedInWww(page) {
  try {
    await page.goto('https://www.reddit.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
  } catch (err) {
    return { ok: false, via: 'nav_error', error: String(err.message || err).slice(0, 180) };
  }
  await playwrightService.humanLikeDelay(1500, 2500);
  await dismissBanners(page);
  return page.evaluate(() => {
    const text = (document.body?.innerText || '').slice(0, 4000);
    if (/Expand user menu|Open inbox|Create post/i.test(text)) return { ok: true, via: 'body_signals' };
    if (document.querySelector('#USER_DROPDOWN_ID, [aria-label="Expand user menu"], [aria-label="User menu"]')) {
      return { ok: true, via: 'menu_selector' };
    }
    if (/Log( ?In| in)|Sign Up/i.test(text) && !/Open inbox/i.test(text)) {
      return { ok: false, via: 'logged_out', snippet: text.slice(0, 200) };
    }
    return { ok: false, via: 'unclear', snippet: text.slice(0, 200) };
  });
}

async function loginOldReddit(page, username, password) {
  await page.goto('https://old.reddit.com/login', {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });
  await playwrightService.humanLikeDelay(2000, 3500);
  await dismissBanners(page);

  const user = page.locator('input[name="username"], #user_login, input[name="user"]').first();
  const pass = page.locator('input[name="password"], #passwd_login, input[type="password"]').first();
  await user.waitFor({ state: 'visible', timeout: 20000 });
  await user.click({ clickCount: 3 }).catch(() => {});
  await user.fill('');
  await user.type(username, { delay: 40 });
  await playwrightService.humanLikeDelay(300, 700);
  await pass.click({ clickCount: 3 }).catch(() => {});
  await pass.fill('');
  await pass.type(password, { delay: 40 });
  await playwrightService.humanLikeDelay(400, 800);

  const submit =
    (await page.$('button[type="submit"]')) ||
    (await page.$('button:has-text("log in")')) ||
    (await page.$('input[type="submit"]'));
  if (submit) await submit.click();
  else await page.keyboard.press('Enter');
  await playwrightService.humanLikeDelay(4000, 7000);

  const check = await isLoggedInOldReddit(page);
  if (!check.ok) {
    const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 300);
    throw new Error(`old.reddit login failed: ${body}`);
  }
  return check;
}

async function extractOldPrefsEmail(page) {
  try {
    await page.goto('https://old.reddit.com/prefs/update/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
  } catch (err) {
    return {
      url: null,
      emailValue: null,
      emailExists: false,
      passwordFields: [],
      looksLoggedOut: false,
      blocked: false,
      navError: String(err.message || err).slice(0, 200),
      bodySnippet: '',
    };
  }
  await playwrightService.humanLikeDelay(2500, 4000);
  await dismissBanners(page);

  const data = await page.evaluate(() => {
    const emailInput =
      document.querySelector('input[name="email"]') ||
      document.querySelector('#email') ||
      document.querySelector('input[type="email"]');
    const verifyBtn = document.querySelector('button[name="verify"], input[name="verify"]');
    const body = (document.body?.innerText || '').slice(0, 2500);
    const pwFields = [...document.querySelectorAll('input[type="password"]')].map((el) => ({
      name: el.getAttribute('name'),
      id: el.id,
      placeholder: el.getAttribute('placeholder'),
    }));
    return {
      url: location.href,
      emailValue: emailInput ? emailInput.value || null : null,
      emailExists: !!emailInput,
      hasVerifyControl: !!verifyBtn,
      passwordFields: pwFields,
      bodySnippet: body.slice(0, 500),
      looksLoggedOut: /log in|sign up|want to log|you are not logged/i.test(body),
      blocked: /blocked by network security/i.test(body),
    };
  });
  return data;
}

async function extractNewSettingsEmail(page) {
  await page.goto('https://www.reddit.com/settings/account', {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });
  await playwrightService.humanLikeDelay(3000, 5000);
  await dismissBanners(page);

  const data = await page.evaluate(() => {
    const body = (document.body?.innerText || '').slice(0, 6000);
    const emailRe =
      /([a-zA-Z0-9._%+-]+@(?:hotmail|outlook|live|msn|gmail|yahoo|gmx|proton)[a-zA-Z0-9.-]*\.[a-zA-Z]{2,})/gi;
    const emails = [...new Set((body.match(emailRe) || []).map((e) => e.toLowerCase()))];
    // Masked forms like q***@hotmail.com
    const masked = [
      ...new Set(
        (body.match(/[a-zA-Z0-9*]{1,3}\*+[a-zA-Z0-9*]*@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi) || []).map(
          (e) => e.toLowerCase()
        )
      ),
    ];
    const hasChangePassword = /change password|update password|current password/i.test(body);
    const hasEmailSection = /email address|update email|verify email|add email/i.test(body);
    return {
      url: location.href,
      emails,
      masked,
      hasChangePassword,
      hasEmailSection,
      bodySnippet: body.slice(0, 800),
      looksLoggedOut: /log in to reddit|sign up|want to log in/i.test(body) && !/email address/i.test(body),
      blocked: /blocked by network security/i.test(body),
    };
  });
  return data;
}

function emailsMatch(dbEmail, observed) {
  if (!dbEmail || !observed) return false;
  return String(dbEmail).trim().toLowerCase() === String(observed).trim().toLowerCase();
}

function maskedMatches(dbEmail, masked) {
  if (!dbEmail || !masked) return null;
  const [local, domain] = String(dbEmail).toLowerCase().split('@');
  const [mLocal, mDomain] = String(masked).toLowerCase().split('@');
  if (!local || !domain || !mLocal || !mDomain) return null;
  if (domain !== mDomain) return false;
  // Compare non-star chars as prefix/suffix hints
  const prefix = mLocal.replace(/\*.*$/, '');
  const suffix = mLocal.includes('*') ? mLocal.replace(/^.*\*/, '') : '';
  if (prefix && !local.startsWith(prefix)) return false;
  if (suffix && !local.endsWith(suffix)) return false;
  return true;
}

async function tryInSessionPasswordChange(page, account, creds, oldPrefs) {
  const currentPassword = creds.password;
  if (!currentPassword) {
    return { ok: false, error: 'no_current_password' };
  }
  const newPassword = generatePassword(16);

  // Prefer old.reddit prefs password fields when present
  if ((oldPrefs?.passwordFields || []).length >= 2) {
    await page.goto('https://old.reddit.com/prefs/update/', {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });
    await playwrightService.humanLikeDelay(2000, 3500);

    const cur = page.locator('input[name="curpass"], input[name="old_password"], #curpass').first();
    const neu = page.locator('input[name="newpass"], input[name="password"], #newpass, #passwd').first();
    const ver = page
      .locator('input[name="verpass"], input[name="passwd2"], #verpass, #passwd2')
      .first();

    const curVisible = await cur.isVisible().catch(() => false);
    if (!curVisible) {
      return { ok: false, error: 'old_prefs_password_fields_not_visible', newPasswordPreview: null };
    }

    await cur.click({ clickCount: 3 }).catch(() => {});
    await cur.fill('');
    await cur.type(currentPassword, { delay: 40 });
    await playwrightService.humanLikeDelay(300, 700);
    await neu.click({ clickCount: 3 }).catch(() => {});
    await neu.fill('');
    await neu.type(newPassword, { delay: 40 });
    await playwrightService.humanLikeDelay(300, 700);
    if (await ver.isVisible().catch(() => false)) {
      await ver.click({ clickCount: 3 }).catch(() => {});
      await ver.fill('');
      await ver.type(newPassword, { delay: 40 });
    }

    const save =
      (await page.$('button[type="submit"]')) ||
      (await page.$('button:has-text("save")')) ||
      (await page.$('input[type="submit"]'));
    if (!save) return { ok: false, error: 'save_button_missing' };
    await save.click();
    await playwrightService.humanLikeDelay(3000, 5000);

    const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 800);
    const ok = /your preferences have been updated|password.*(changed|updated)|success/i.test(body);
    const bad = /incorrect|wrong password|try again|error/i.test(body);
    if (!ok || bad) {
      return { ok: false, error: `prefs_save_result: ${body.slice(0, 200)}` };
    }

    const nextCreds = {
      ...creds,
      password: newPassword,
      password_rotated_at: new Date().toISOString(),
      password_rotate_method: 'in_session_prefs',
      previous_password: currentPassword,
    };
    await pool.query(
      `UPDATE social_accounts
       SET credentials = $2::jsonb, updated_at = NOW()
       WHERE id = $1`,
      [account.id, JSON.stringify(nextCreds)]
    );
    await playwrightService.persistSession(page, 'reddit', account.id).catch(() => {});
    return { ok: true, method: 'old_reddit_prefs', passwordPersisted: true };
  }

  // New Reddit settings change-password flow
  await page.goto('https://www.reddit.com/settings/account', {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });
  await playwrightService.humanLikeDelay(2500, 4000);
  const changeBtn =
    (await page.$('button:has-text("Change password")')) ||
    (await page.$('button:has-text("Update password")')) ||
    (await page.$('a:has-text("Change password")'));
  if (!changeBtn) {
    return { ok: false, error: 'change_password_control_not_found' };
  }
  await changeBtn.click();
  await playwrightService.humanLikeDelay(1500, 3000);

  const pwInputs = page.locator('input[type="password"]');
  const count = await pwInputs.count();
  if (count < 2) {
    return { ok: false, error: `change_password_inputs=${count}` };
  }
  await pwInputs.nth(0).fill(currentPassword);
  await playwrightService.humanLikeDelay(200, 500);
  await pwInputs.nth(1).fill(newPassword);
  await playwrightService.humanLikeDelay(200, 500);
  if (count >= 3) {
    await pwInputs.nth(2).fill(newPassword);
  }
  const submit =
    (await page.$('button:has-text("Save")')) ||
    (await page.$('button:has-text("Change")')) ||
    (await page.$('button[type="submit"]'));
  if (!submit) return { ok: false, error: 'change_password_submit_missing' };
  await submit.click();
  await playwrightService.humanLikeDelay(3000, 5000);
  const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 800);
  const ok = /password.*(changed|updated)|success|saved/i.test(body);
  if (!ok) {
    return { ok: false, error: `new_settings_result: ${body.slice(0, 220)}` };
  }

  const nextCreds = {
    ...creds,
    password: newPassword,
    password_rotated_at: new Date().toISOString(),
    password_rotate_method: 'in_session_settings',
    previous_password: currentPassword,
  };
  await pool.query(
    `UPDATE social_accounts
     SET credentials = $2::jsonb, updated_at = NOW()
     WHERE id = $1`,
    [account.id, JSON.stringify(nextCreds)]
  );
  await playwrightService.persistSession(page, 'reddit', account.id).catch(() => {});
  return { ok: true, method: 'new_reddit_settings', passwordPersisted: true };
}

async function probeOne(accountId) {
  const { rows } = await pool.query(`SELECT * FROM social_accounts WHERE id = $1`, [accountId]);
  const account = rows[0];
  if (!account) {
    logRow({ accountId, error: 'not_found' });
    return { accountId, error: 'not_found' };
  }
  const creds = parseCreds(account.credentials);
  const dbEmail = (account.email || creds.email || '').toLowerCase();

  let browser;
  let page;
  const out = {
    accountId,
    username: account.username,
    dbEmail,
    loginOk: false,
    match: null,
    matchConfidence: null,
    observedEmail: null,
    maskedEmail: null,
    oldPrefs: null,
    newSettings: null,
    inSessionChange: null,
    error: null,
  };

  try {
    const result = await playwrightService.createBrowserForAccount(accountId, 2, {
      requireProxy: true,
      forceDesktop: true,
    });
    browser = result.browser;
    page = result.page;

    // Prefer session → old.reddit, then www, then password login.
    const restored = await playwrightService.restoreSession(page, 'reddit', accountId);
    let loginMeta = { restored };
    let loggedIn = false;
    if (restored) {
      const checkWww = await isLoggedInWww(page);
      loginMeta.sessionCheckWww = checkWww;
      if (checkWww.ok) loggedIn = true;
      if (!loggedIn) {
        const checkOld = await isLoggedInOldReddit(page);
        loginMeta.sessionCheckOld = checkOld;
        if (checkOld.ok) loggedIn = true;
      }
    }
    if (!loggedIn) {
      try {
        loginMeta.oldLogin = await loginOldReddit(page, account.username, creds.password);
        loggedIn = true;
        await playwrightService.persistSession(page, 'reddit', accountId).catch(() => {});
      } catch (loginErr) {
        loginMeta.oldLoginError = String(loginErr.message || loginErr).slice(0, 220);
        try {
          loggedIn = !!(await playwrightService.ensureLoggedIn(
            page,
            'reddit',
            accountId,
            account.username,
            creds.password
          ));
          loginMeta.wwwFallback = loggedIn;
        } catch (wwwErr) {
          out.error = `login_failed: ${loginErr.message || loginErr} | www: ${wwwErr.message || wwwErr}`;
          out.loginMeta = loginMeta;
          logRow(out);
          return out;
        }
      }
    }
    out.loginOk = !!loggedIn;
    out.loginMeta = loginMeta;
    if (!loggedIn) {
      out.error = 'login_failed';
      logRow(out);
      return out;
    }

    const oldPrefs = await extractOldPrefsEmail(page);
    out.oldPrefs = {
      url: oldPrefs.url,
      emailValue: oldPrefs.emailValue,
      emailExists: oldPrefs.emailExists,
      passwordFieldCount: (oldPrefs.passwordFields || []).length,
      passwordFieldNames: (oldPrefs.passwordFields || []).map((f) => f.name),
      looksLoggedOut: oldPrefs.looksLoggedOut,
      blocked: oldPrefs.blocked,
      bodySnippet: oldPrefs.bodySnippet,
    };

    let newSettings = null;
    if (!oldPrefs.emailValue || oldPrefs.blocked || oldPrefs.looksLoggedOut) {
      newSettings = await extractNewSettingsEmail(page);
      out.newSettings = {
        url: newSettings.url,
        emails: newSettings.emails,
        masked: newSettings.masked,
        hasChangePassword: newSettings.hasChangePassword,
        hasEmailSection: newSettings.hasEmailSection,
        looksLoggedOut: newSettings.looksLoggedOut,
        blocked: newSettings.blocked,
        bodySnippet: newSettings.bodySnippet,
      };
    } else {
      // Still peek new settings lightly for change-password UI presence
      newSettings = await extractNewSettingsEmail(page);
      out.newSettings = {
        url: newSettings.url,
        emails: newSettings.emails,
        masked: newSettings.masked,
        hasChangePassword: newSettings.hasChangePassword,
        hasEmailSection: newSettings.hasEmailSection,
        looksLoggedOut: newSettings.looksLoggedOut,
        blocked: newSettings.blocked,
        bodySnippet: newSettings.bodySnippet?.slice(0, 400),
      };
    }

    const observed =
      (oldPrefs.emailValue && oldPrefs.emailValue.includes('@') ? oldPrefs.emailValue : null) ||
      newSettings?.emails?.[0] ||
      null;
    out.observedEmail = observed ? String(observed).toLowerCase() : null;
    out.maskedEmail = newSettings?.masked?.[0] || null;

    if (out.observedEmail) {
      out.match = emailsMatch(dbEmail, out.observedEmail);
      out.matchConfidence = 'exact';
    } else if (out.maskedEmail) {
      const m = maskedMatches(dbEmail, out.maskedEmail);
      out.match = m;
      out.matchConfidence = m == null ? 'unknown_mask' : 'masked';
    } else if (oldPrefs.emailExists && (oldPrefs.emailValue === '' || oldPrefs.emailValue == null)) {
      out.match = false;
      out.matchConfidence = 'empty_email_field';
    } else {
      out.match = null;
      out.matchConfidence = 'unreadable';
    }

    if (TRY_CHANGE && out.loginOk) {
      out.inSessionChange = await tryInSessionPasswordChange(page, account, creds, oldPrefs);
    } else if (out.loginOk) {
      out.inSessionChange = {
        attempted: false,
        hasPasswordFieldsOnPrefs: (oldPrefs.passwordFields || []).length >= 2,
        hasChangePasswordUi: !!(newSettings && newSettings.hasChangePassword),
      };
    }

    // Screenshot for audit
    const shot = `/tmp/reddit-bound-email-${accountId}.png`;
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    out.screenshot = shot;

    logRow(out);
    return out;
  } catch (err) {
    out.error = String(err.message || err).slice(0, 400);
    logRow(out);
    return out;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function main() {
  const ids = parseIds();
  console.log(`Probing bound email for Reddit accounts: ${ids.join(', ')}`);
  console.log(`TRY_IN_SESSION_CHANGE=${TRY_CHANGE} BETWEEN_MS=${BETWEEN_MS}`);

  const results = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    console.log(`\n=== account ${id} (${i + 1}/${ids.length}) ===`);
    const row = await probeOne(id);
    results.push(row);
    if (i < ids.length - 1) {
      console.log(`Sleeping ${BETWEEN_MS}ms before next account…`);
      await new Promise((r) => setTimeout(r, BETWEEN_MS));
    }
  }

  const summary = {
    probed: results.length,
    loginOk: results.filter((r) => r.loginOk).length,
    exactMatch: results.filter((r) => r.match === true && r.matchConfidence === 'exact').length,
    maskedMatch: results.filter((r) => r.match === true && r.matchConfidence === 'masked').length,
    mismatch: results.filter((r) => r.match === false).length,
    unknown: results.filter((r) => r.match == null).length,
    loginFail: results.filter((r) => !r.loginOk).length,
    inSessionOk: results.filter((r) => r.inSessionChange?.ok).length,
    rows: results.map((r) => ({
      id: r.accountId,
      user: r.username,
      db: r.dbEmail,
      obs: r.observedEmail,
      masked: r.maskedEmail,
      match: r.match,
      conf: r.matchConfidence,
      login: r.loginOk,
      changeUi: r.inSessionChange,
      err: r.error,
    })),
  };
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
