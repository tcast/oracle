#!/usr/bin/env node
require('dotenv').config();
const pool = require('../services/db');
const playwrightService = require('../services/playwrightService');
const proxyService = require('../services/proxyService');

async function main() {
  const proxyId = Number(process.argv[2] || 388);
  const { rows } = await pool.query('SELECT * FROM proxies WHERE id = $1', [proxyId]);
  if (!rows[0]) throw new Error('proxy not found');
  const proxyConfig = proxyService.formatProxyConfig(rows[0]);
  const deviceProfile = await playwrightService.getOrCreateDeviceProfile(20, {
    forceDesktop: true,
  });
  const result = await playwrightService.createBrowser(proxyConfig, false, deviceProfile);
  const page = result.page;
  try {
    await page.goto('https://old.reddit.com/password/', {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });
    await new Promise((r) => setTimeout(r, 5000));

    const count = {
      input: await page.locator('input').count(),
      faceplate: await page.locator('faceplate-text-input').count(),
      textbox: await page.getByRole('textbox').count().catch(() => -1),
      button: await page.getByRole('button').count().catch(() => -1),
    };

    const shadow = await page.evaluate(() => {
      const fps = [...document.querySelectorAll('faceplate-text-input')];
      return fps.map((fp) => {
        const inp = fp.shadowRoot?.querySelector('input');
        return {
          name: fp.getAttribute('name'),
          hasInput: !!inp,
          placeholder: inp?.placeholder || null,
        };
      });
    });

    const html = await page.content();
    const idx = html.indexOf('Reset');
    console.log(
      JSON.stringify(
        {
          url: page.url(),
          count,
          shadow,
          snippet: idx >= 0 ? html.slice(idx, idx + 1000) : html.slice(0, 1000),
        },
        null,
        2
      )
    );

    // Try typing into faceplate shadow input if present
    if (shadow.length) {
      const loc = page.locator('faceplate-text-input input').first();
      const visible = await loc.isVisible().catch(() => false);
      console.log('faceplate input visible?', visible);
      if (visible) {
        await loc.fill('test@example.com');
        console.log('filled ok');
      }
    } else if (count.textbox > 0) {
      await page.getByRole('textbox').first().fill('test@example.com');
      console.log('filled via role textbox');
    } else if (count.input > 0) {
      await page.locator('input').first().fill('test@example.com');
      console.log('filled via input');
    } else {
      // dump all interactive
      const interactive = await page.evaluate(() =>
        [...document.querySelectorAll('input, button, a, faceplate-text-input, [role="textbox"]')]
          .slice(0, 40)
          .map((el) => ({
            tag: el.tagName,
            type: el.getAttribute('type'),
            name: el.getAttribute('name'),
            role: el.getAttribute('role'),
            text: (el.innerText || '').slice(0, 40),
          }))
      );
      console.log('interactive', JSON.stringify(interactive, null, 2));
    }
  } finally {
    await result.browser.close().catch(() => {});
    await pool.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
