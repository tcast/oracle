#!/usr/bin/env node
require('dotenv').config();
const playwrightService = require('../services/playwrightService');
const pool = require('../services/db');

(async () => {
  const id = Number(process.argv[2] || 278);
  const o = await playwrightService.createBrowser(
    null,
    false,
    await playwrightService.getOrCreateDeviceProfile(id, { forceDesktop: true })
  );
  const page = o.page;
  o.accountId = id;
  playwrightService._trackBrowser(id, o.browser);
  await playwrightService.restoreSession(page, 'linkedin', id);
  await page.goto('https://www.linkedin.com/in/me/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 3000));
  await page.locator('button[aria-label*="background" i]').first().click({ force: true });
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: `/tmp/li-menu2-${id}.png` });

  const before = await page.evaluate(() => ({
    inputs: [...document.querySelectorAll('input')].map((i) => ({
      type: i.type,
      accept: i.accept,
      aria: i.getAttribute('aria-label'),
      id: i.id,
      name: i.name,
      cls: String(i.className || '').slice(0, 80),
    })),
    menuHtml: (
      document.querySelector('[role="menu"], .artdeco-dropdown__content, .artdeco-dropdown__content-inner') ||
      {}
    ).outerHTML?.slice(0, 2500),
  }));
  console.log('BEFORE', JSON.stringify(before, null, 2));

  // Try several click strategies on Add cover image
  const handle = await page.$('[aria-label="Add cover image"]');
  console.log('handle', !!handle);
  if (handle) {
    // Listen for filechooser with longer timeout while trying multiple click styles
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 25000 }).catch((e) => e);
    await handle.click({ force: true });
    await new Promise((r) => setTimeout(r, 500));
    await handle.dispatchEvent('click');
    await new Promise((r) => setTimeout(r, 500));
    // Also try clicking child SVG / icon
    await page.evaluate(() => {
      const el = document.querySelector('[aria-label="Add cover image"]');
      if (!el) return;
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const chooser = await chooserPromise;
    if (chooser && chooser.setFiles) {
      console.log('CHOOSER_OK');
      await chooser.setFiles('/app/private/x-banners/meadow-haze.jpg');
    } else {
      console.log('CHOOSER_FAIL', String(chooser && chooser.message));
    }
  }

  await new Promise((r) => setTimeout(r, 2000));
  const after = await page.evaluate(() => ({
    inputs: [...document.querySelectorAll('input[type="file"]')].map((i) => ({
      accept: i.accept,
      aria: i.getAttribute('aria-label'),
      id: i.id,
      name: i.name,
    })),
    dialog: document.querySelector('[role="dialog"]')?.innerText?.slice(0, 500) || null,
    url: location.href,
  }));
  console.log('AFTER', JSON.stringify(after, null, 2));
  await page.screenshot({ path: `/tmp/li-after-cover-${id}.png` });

  // If file input appeared, set it
  const fileInput = await page.$('input[type="file"]');
  if (fileInput) {
    await fileInput.setInputFiles('/app/private/x-banners/meadow-haze.jpg');
    console.log('SET_VIA_INPUT');
    await new Promise((r) => setTimeout(r, 4000));
    await page.screenshot({ path: `/tmp/li-crop3-${id}.png` });
  }

  await o.browser.close();
  playwrightService._untrackBrowser(id);
  await pool.end();
})().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});
