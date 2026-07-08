#!/usr/bin/env node
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

(async () => {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled'
      ]
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
      locale: 'en-US'
    });

    const page = await context.newPage();

    console.log('Loading Yahoo signup...');
    await page.goto('https://login.yahoo.com/account/create', {
      waitUntil: 'networkidle',
      timeout: 60000
    });

    await page.waitForTimeout(5000);

    console.log('URL:', page.url());
    console.log('Title:', await page.title());

    // Check if redirected
    if (!page.url().includes('create')) {
      console.log('⚠️  Page redirected away from signup!');
    }

    // Take screenshot
    await page.screenshot({ path: '/tmp/yahoo-page.png', fullPage: true });
    console.log('Screenshot saved to /tmp/yahoo-page.png');

    // Check for form fields
    const firstNameExists = await page.$('#usernamereg-firstName');
    console.log('First name field exists:', !!firstNameExists);

    // Get page HTML
    const bodyText = await page.evaluate(() => document.body.innerText);
    console.log('\nPage text (first 500 chars):\n', bodyText.substring(0, 500));

    await browser.close();
  } catch (error) {
    console.error('Error:', error.message);
    if (browser) await browser.close();
  }
})();
