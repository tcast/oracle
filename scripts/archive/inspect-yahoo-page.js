#!/usr/bin/env node
/**
 * Inspect Yahoo signup page structure
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

    console.log('📡 Loading Yahoo signup page...');
    await page.goto('https://login.yahoo.com/account/create', {
      waitUntil: 'networkidle',
      timeout: 60000
    });

    console.log('✅ Page loaded');

    // Wait for page to render
    await page.waitForTimeout(3000);

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
        className: el.className
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

    // Check for buttons
    console.log('\n🔘 Buttons:\n');
    const buttons = await page.$$eval('button', elements =>
      elements.map((el, idx) => ({
        index: idx,
        type: el.type,
        id: el.id,
        className: el.className,
        text: el.textContent
      }))
    );

    buttons.slice(0, 10).forEach(btn => {
      console.log(`Button ${btn.index}:`);
      if (btn.type) console.log(`  type: "${btn.type}"`);
      if (btn.id) console.log(`  id: "${btn.id}"`);
      if (btn.text) console.log(`  text: "${btn.text.substring(0, 50)}"`);
      console.log('');
    });

    await browser.close();
    console.log('✅ Inspection complete');

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (browser) await browser.close();
    process.exit(1);
  }
})();
