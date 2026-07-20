#!/usr/bin/env node
require('dotenv').config();
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const pool = require('../services/db');
chromium.use(stealth);

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

async function main() {
  const id = Number(process.argv[2] || 16);
  const { rows } = await pool.query('SELECT * FROM social_accounts WHERE id = $1', [id]);
  const account = rows[0];
  const creds = parseCreds(account.credentials);
  const email = account.email;
  const password = creds.email_password;
  console.log(`Outlook login debug #${id} ${email}`);

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.CHROMIUM_PATH,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(25000);
    await page.goto('https://login.live.com/', { waitUntil: 'domcontentloaded' });
    await page.fill('input[type="email"], input[name="loginfmt"]', email);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
      page.click('input[type="submit"], button[type="submit"]'),
    ]);
    await page.waitForTimeout(1000);
    await page.waitForSelector('input[type="password"], input[name="passwd"]', { timeout: 20000 });
    await page.fill('input[type="password"], input[name="passwd"]', password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}),
      page.click('input[type="submit"], button[type="submit"]'),
    ]);
    await page.waitForTimeout(3000);

    for (let i = 0; i < 3; i++) {
      if (/outlook\.live\.com|outlook\.office/i.test(page.url())) break;
      const clicked = await page.evaluate(() => {
        const btn =
          document.querySelector('input#idSIButton9') ||
          [...document.querySelectorAll('button')].find((b) =>
            /^(Yes|Next|Continue)$/i.test((b.innerText || '').trim())
          );
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });
      if (clicked) await page.waitForTimeout(2000);
      else break;
    }

    if (!/outlook\.live\.com|outlook\.office/i.test(page.url())) {
      await page.goto('https://outlook.live.com/mail/0/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await page.waitForTimeout(4000);
    }

    const snap = `/tmp/outlook-debug-${id}.png`;
    await page.screenshot({ path: snap, fullPage: true }).catch(() => {});
    const info = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      text: (document.body?.innerText || '').slice(0, 600),
      optionCount: document.querySelectorAll('[role="option"]').length,
      rowCount: document.querySelectorAll('[role="row"]').length,
    }));
    console.log(JSON.stringify({ snap, ...info }, null, 2));
  } finally {
    await browser.close().catch(() => {});
    await pool.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
