#!/usr/bin/env node
require('dotenv').config();
const path = require('path');
const playwrightService = require('../services/playwrightService');
const pool = require('../services/db');
const { updateEnrichment } = require('../services/profileEnrichment');

const BANNER = path.join(__dirname, '../../private/x-banners/coastal-fog.jpg');

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
  await playwrightService.humanLikeDelay(2500, 3500);
  await playwrightService.dismissLinkedInModals(page).catch(() => {});

  await page.locator('button[aria-label*="background" i]').first().click();
  await playwrightService.humanLikeDelay(700, 1100);
  await page.locator('div[aria-label="Add cover image"]').first().click({ noWaitAfter: true });
  await playwrightService.humanLikeDelay(2000, 3000);
  await page.screenshot({ path: `/tmp/li-cover-modal-${id}.png` });

  const modalText = await page.evaluate(() => (document.body.innerText || '').slice(0, 800));
  console.log('MODAL_HINT', modalText.includes('Upload single photo'), modalText.includes('Choose an image'));

  const uploadBtn = page.getByText(/Upload single photo|Choose an image|Upload your own/i).first();
  console.log('upload_btn', await uploadBtn.count());

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 20000 }),
    (async () => {
      // Prefer exact button labels inside modal
      const clicked = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button, [role="button"], a, label, div')];
        const order = [/^Upload single photo$/i, /^Choose an image$/i, /Upload single photo/i, /Choose an image/i];
        for (const re of order) {
          const b = buttons.find((x) => {
            const t = (x.innerText || x.getAttribute('aria-label') || '').trim();
            if (!re.test(t)) return false;
            const r = x.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          if (b) {
            b.click();
            return (b.innerText || b.getAttribute('aria-label') || '').trim().slice(0, 40);
          }
        }
        return null;
      });
      console.log('clicked_upload', clicked);
      if (!clicked) await uploadBtn.click({ timeout: 5000 }).catch(() => {});
    })(),
  ]);
  await chooser.setFiles(BANNER);
  console.log('FILE_SET');
  await playwrightService.humanLikeDelay(4000, 5500);
  await page.screenshot({ path: `/tmp/li-banner-crop-${id}.png` });

  for (let i = 0; i < 8; i++) {
    const clicked = await page.evaluate(() => {
      const order = [/^Apply$/i, /^Save changes$/i, /^Save photo$/i, /^Save$/i, /^Done$/i, /^Skip$/i];
      for (const re of order) {
        const b = [...document.querySelectorAll('button, [role="button"]')].find((x) => {
          if (!re.test((x.innerText || '').trim()) || x.disabled) return false;
          const r = x.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (b) {
          b.click();
          return (b.innerText || '').trim();
        }
      }
      return null;
    });
    console.log('save', clicked);
    if (!clicked) break;
    await playwrightService.humanLikeDelay(2500, 4000);
  }

  await page.goto('https://www.linkedin.com/in/me/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await playwrightService.humanLikeDelay(3000, 4500);
  await page.screenshot({ path: `/tmp/li-banner-proof-${id}.png` });

  const info = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img')];
    const avatar = imgs.find((i) =>
      /profile-displayphoto|EntityPhoto/i.test(`${i.className} ${i.src}`)
    );
    let bg = null;
    for (const el of document.querySelectorAll('div')) {
      const s = getComputedStyle(el).backgroundImage || '';
      if (!/media\.licdn\.com/i.test(s)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 400 && r.height > 80 && r.top < 450) {
        const m = s.match(/url\(["']?([^"')]+)/);
        bg = m ? m[1] : s;
        break;
      }
    }
    return {
      avatarSrc: avatar?.src || null,
      bannerSrc: bg,
      hasBanner: !!bg,
      distinct: !!(avatar?.src && bg && !avatar.src.includes(bg) && avatar.src !== bg),
    };
  });
  console.log(JSON.stringify(info, null, 2));
  if (info.hasBanner) {
    await updateEnrichment(id, { banner: true }, { source: 'linkedin_banner' });
    console.log('ENRICHMENT_OK');
  }
  await playwrightService.persistSession(page, 'linkedin', id).catch(() => {});
  await o.browser.close();
  playwrightService._untrackBrowser(id);
  await pool.end();
  process.exit(info.hasBanner ? 0 : 2);
})().catch(async (e) => {
  console.error('ERR', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
