#!/usr/bin/env node
/**
 * One-shot: register with a catchall email and try known Reddit OTP codes.
 * Usage: PILOT_EMAIL_ID=69 PILOT_PROXY_IDS=104 node src/scripts/pilot-reddit-try-codes.js [code1] [code2]
 */
require('dotenv').config();
const accountCreationService = require('../services/accountCreationService');
const proxyService = require('../services/proxyService');
const pool = require('../services/db');
const { generatePassword } = require('../utils/passwordGenerator');
const { generateRealisticUsername } = require('../utils/nameGenerator');

const emailId = parseInt(process.env.PILOT_EMAIL_ID || '69', 10);
const proxyId = parseInt(String(process.env.PILOT_PROXY_IDS || '104').split(',')[0], 10);
const codes = process.argv.slice(2).filter(Boolean);

(async () => {
  const emailAccount = (await pool.query('SELECT * FROM email_accounts WHERE id=$1', [emailId])).rows[0];
  if (!emailAccount) throw new Error('email missing');
  const proxyRow = (await pool.query('SELECT * FROM proxies WHERE id=$1', [proxyId])).rows[0];
  if (!proxyRow) throw new Error('proxy missing');
  const proxyConfig = proxyService.formatProxyConfig(proxyRow);
  proxyConfig._proxyId = proxyId;

  const username = (generateRealisticUsername('random') + Date.now().toString().slice(-4)).slice(0, 20);
  const password = generatePassword(14);
  console.log(JSON.stringify({ email: emailAccount.email, username, proxyId, codes }));

  const { browser, page } = await accountCreationService.createBrowser(proxyConfig);
  try {
    await page.goto('https://www.reddit.com/register/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await accountCreationService.humanLikeDelay(2500, 4000);
    for (const label of ['Accept all', 'Accept', 'I agree', 'Continue']) {
      const btn = await page.$(`button:has-text("${label}")`);
      if (btn) await btn.click().catch(() => {});
    }
    const emailChoice =
      (await page.$('button:has-text("Email")')) ||
      (await page.$('a:has-text("Email")'));
    if (emailChoice) {
      await emailChoice.click().catch(() => {});
      await accountCreationService.humanLikeDelay(1000, 2000);
    }
    const emailLocator = page
      .locator('faceplate-text-input[name="email"] input, input[name="email"], input[type="email"], #regEmail')
      .first();
    await emailLocator.waitFor({ state: 'visible', timeout: 25000 });
    await accountCreationService.typeIntoLocator(page, emailLocator, emailAccount.email);
    await accountCreationService.humanLikeDelay();
    const continueBtn = await page.$(
      'button:has-text("Continue"), button:has-text("Next"), button[type="submit"]'
    );
    if (continueBtn) await continueBtn.click();
    await accountCreationService.humanLikeDelay(2000, 3500);

    const body = await page.evaluate(() => (document.body?.innerText || '').slice(0, 500));
    console.log('after_email', body.replace(/\s+/g, ' ').slice(0, 220));

    const codeInput = page
      .locator('input[name="code"], input[autocomplete="one-time-code"], input[placeholder*="code" i]')
      .first();
    const hasCode = await codeInput.isVisible().catch(() => false);
    console.log('hasCodeInput', hasCode);
    if (!hasCode) throw new Error('no code input — ' + body.slice(0, 160));

    // Prefer freshly arrived IMAP codes first
    let tried = [...codes];
    try {
      const emailInboxService = require('../services/emailInboxService');
      const latest = await emailInboxService.getLatestVerification(emailAccount, {
        limit: 10,
        fromIncludes: 'reddit',
      });
      if (latest?.code) tried.unshift(latest.code);
      for (const c of latest?.codes || []) tried.unshift(c);
    } catch (e) {
      console.warn('imap_read', e.message);
    }
    tried = [...new Set(tried.map(String))];

    for (const code of tried) {
      console.log('try_code', code);
      await codeInput.click({ clickCount: 3 }).catch(() => {});
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      await page.keyboard.type(String(code), { delay: 80 });
      await accountCreationService.humanLikeDelay(500, 1000);
      const submit = await page.$('button[type="submit"], button:has-text("Continue"), button:has-text("Next")');
      if (submit) await submit.click();
      await accountCreationService.humanLikeDelay(2500, 4000);
      const now = await page.evaluate(() => (document.body?.innerText || '').slice(0, 400));
      console.log('after_code', now.replace(/\s+/g, ' ').slice(0, 220));
      if (/username|password|create|almost|pick a username/i.test(now) && !/verification code|verify your email/i.test(now)) {
        console.log('CODE_ACCEPTED', code);
        // Fill username/password and finish
        const userField = page
          .locator('faceplate-text-input[name="username"] input, input[name="username"], #regUsername')
          .first();
        const passField = page
          .locator('faceplate-text-input[name="password"] input, input[name="password"], #regPassword')
          .first();
        if (await userField.isVisible().catch(() => false)) {
          await accountCreationService.typeIntoLocator(page, userField, username);
        }
        if (await passField.isVisible().catch(() => false)) {
          await accountCreationService.typeIntoLocator(page, passField, password);
        }
        const signup = await page.$(
          'button[type="submit"], button:has-text("Sign Up"), button:has-text("Create"), button:has-text("Continue")'
        );
        if (signup) await signup.click();
        await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
        await accountCreationService.humanLikeDelay(3000, 5000);
        const cookies = await page.context().cookies();
        const inserted = await pool.query(
          `INSERT INTO social_accounts
             (platform, username, email, credentials, status, is_simulated, warmup_status, email_account_id)
           VALUES ('reddit', $1, $2, $3::jsonb, 'active', false, 'pending', $4)
           RETURNING id, username, email, status, created_at`,
          [
            username,
            emailAccount.email,
            JSON.stringify({
              password,
              email: emailAccount.email,
              email_password: emailAccount.password,
              source: 'pilot_try_codes',
              needs_signup: false,
            }),
            emailAccount.id,
          ]
        );
        await pool.query(
          `UPDATE email_accounts
           SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
           WHERE id = $1`,
          [
            emailAccount.id,
            JSON.stringify({
              linked_reddit: username,
              linked_social_account_id: inserted.rows[0].id,
              linked_at: new Date().toISOString(),
            }),
          ]
        );
        await proxyService.assignProxiesToAccount(inserted.rows[0].id, [proxyId]);
        if (cookies?.length) {
          await pool
            .query(
              `INSERT INTO browser_sessions (account_id, platform, cookies, session_data, user_agent)
               VALUES ($1, 'reddit', $2::jsonb, '{}'::jsonb, NULL)
               ON CONFLICT (account_id, platform)
               DO UPDATE SET cookies = $2::jsonb, updated_at = NOW()`,
              [inserted.rows[0].id, JSON.stringify(cookies)]
            )
            .catch(() => {});
        }
        await accountCreationService.recordAttempt({
          platform: 'reddit',
          status: 'created',
          proxyId,
          emailAccountId: emailAccount.id,
          socialAccountId: inserted.rows[0].id,
          username,
          email: emailAccount.email,
          source: 'pilot_try_codes',
          detail: { codeUsed: code },
        });
        console.log('CREATED', JSON.stringify(inserted.rows[0]));
        process.exitCode = 0;
        return;
      }
    }
    throw new Error('no codes accepted');
  } finally {
    await browser.close().catch(() => {});
    await pool.end().catch(() => {});
  }
})().catch((e) => {
  console.error('FATAL', e.message);
  process.exitCode = 1;
});
