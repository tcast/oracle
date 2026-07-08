#!/usr/bin/env node
/**
 * Debug Yandex registration page in Docker
 */

const { chromium } = require('playwright');

(async () => {
  let browser;
  try {
    console.log('🚀 Launching browser...');
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    console.log('✅ Browser launched');
    const page = await browser.newPage();

    console.log('📡 Loading Yandex registration page...');
    await page.goto('https://passport.yandex.com/registration', {
      waitUntil: 'networkidle',
      timeout: 60000
    });

    console.log('✅ Page loaded');

    // Wait for page to fully render
    await page.waitForTimeout(5000);

    // Get page title
    const title = await page.title();
    console.log('Page title:', title);

    // Find all input fields
    console.log('\n📋 All input fields:\n');
    const inputs = await page.$$eval('input', elements =>
      elements.map((el, idx) => ({
        index: idx,
        type: el.type,
        name: el.name,
        id: el.id,
        placeholder: el.placeholder,
        className: el.className,
        value: el.value
      }))
    );

    inputs.forEach(input => {
      console.log(`Input ${input.index}:`);
      if (input.type) console.log(`  type: "${input.type}"`);
      if (input.name) console.log(`  name: "${input.name}"`);
      if (input.id) console.log(`  id: "${input.id}"`);
      if (input.placeholder) console.log(`  placeholder: "${input.placeholder}"`);
      if (input.className) console.log(`  class: "${input.className}"`);
      console.log('');
    });

    // Try to find the first visible text input
    console.log('🔍 Looking for first visible input...');
    const firstInput = await page.$('input[type="text"]:visible, input:not([type]):visible');
    if (firstInput) {
      const attrs = await firstInput.evaluate(el => ({
        id: el.id,
        name: el.name,
        className: el.className
      }));
      console.log('First visible input:', attrs);
    }

    await browser.close();
    console.log('\n✅ Test complete');

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (browser) await browser.close();
    process.exit(1);
  }
})();
