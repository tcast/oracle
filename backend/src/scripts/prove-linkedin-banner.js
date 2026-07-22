#!/usr/bin/env node
/**
 * One-shot LinkedIn banner proof for an account (cover-image menu path).
 * Usage: node src/scripts/prove-linkedin-banner.js [accountId]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../services/db');
const playwrightService = require('../services/playwrightService');
const { updateEnrichment } = require('../services/profileEnrichment');

const BANNER_DIR =
  process.env.X_BANNER_DIR || path.join(__dirname, '../../private/x-banners');

function pickBanner(accountId) {
  const files = fs
    .readdirSync(BANNER_DIR)
    .filter((n) => /\.(jpe?g|png)$/i.test(n) && !/face|portrait|avatar/i.test(n))
    .map((n) => path.join(BANNER_DIR, n));
  if (!files.length) throw new Error('no banners');
  return files[accountId % files.length];
}

async function main() {
  const accountId = Number(process.argv[2] || 278);
  const bannerPath = pickBanner(accountId);
  console.log(`Account #${accountId} banner=${path.basename(bannerPath)}`);

  const opened = await playwrightService.createBrowser(
    null,
    false,
    await playwrightService.getOrCreateDeviceProfile(accountId, { forceDesktop: true })
  );
  const page = opened.page;
  opened.accountId = accountId;
  playwrightService._trackBrowser(accountId, opened.browser);

  try {
    await playwrightService.restoreSession(page, 'linkedin', accountId);
    await page.goto('https://www.linkedin.com/in/me/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await playwrightService.humanLikeDelay(2500, 3500);
    await playwrightService.dismissLinkedInModals(page).catch(() => {});

    if (/authwall|\/login/i.test(page.url())) {
      throw new Error(`authwall ${page.url()}`);
    }

    await page
      .locator('button[aria-label*="background" i], button[aria-label*="cover" i], a[aria-label*="background" i]')
      .first()
      .click({ force: true });
    await playwrightService.humanLikeDelay(700, 1200);

    const cover = page.locator('[aria-label="Add cover image"], [aria-label*="Add cover image" i], [aria-label*="Change cover" i]').first();
    const visible = await cover.isVisible().catch(() => false);
    console.log('cover_menu_visible', visible);

    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 20000 }),
      visible
        ? cover.click({ force: true })
        : page.evaluate(() => {
            const el = [...document.querySelectorAll('[aria-label], button, a, div, span')].find((e) =>
              /Add cover image|Change cover image|Upload cover/i.test(
                `${e.getAttribute('aria-label') || ''} ${e.innerText || ''}`
              )
            );
            if (!el) throw new Error('Add cover image not found');
            el.click();
          }),
    ]);
    await chooser.setFiles(bannerPath);
    console.log('FILE_SET');
    await playwrightService.humanLikeDelay(3500, 5000);
    await page.screenshot({ path: `/tmp/li-banner-crop-${accountId}.png` });

    for (let i = 0; i < 8; i++) {
      const clicked = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button, [role="button"]')];
        const order = [
          /^Apply$/i,
          /^Save changes$/i,
          /^Save photo$/i,
          /^Change background$/i,
          /^Done$/i,
          /^Save$/i,
          /^Skip$/i,
          /^Not now$/i,
        ];
        for (const re of order) {
          const b = buttons.find((x) => {
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
      console.log('step', i, clicked);
      if (!clicked) break;
      await playwrightService.humanLikeDelay(2500, 4000);
    }

    await page.goto('https://www.linkedin.com/in/me/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await playwrightService.humanLikeDelay(3000, 4000);
    const proofPath = `/tmp/li-banner-proof-${accountId}.png`;
    await page.screenshot({ path: proofPath });

    const info = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('img')];
      const avatar = imgs.find((i) =>
        /profile-displayphoto|EntityPhoto|presencephoto/i.test(`${i.className} ${i.src}`)
      );
      const bannerImg = imgs.find((i) =>
        /profile-displaybackground|background-display|cover/i.test(
          `${i.className} ${i.src} ${i.alt}`
        )
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
      const bannerSrc = bannerImg?.src || bg || null;
      return {
        avatarSrc: avatar?.src || null,
        bannerSrc,
        hasBanner: !!bannerSrc,
        avatarIsBanner: !!(avatar?.src && bannerSrc && avatar.src === bannerSrc),
      };
    });

    console.log('PROOF', JSON.stringify(info, null, 2));
    const ok = info.hasBanner && !info.avatarIsBanner;
    if (ok) {
      await updateEnrichment(accountId, { banner: true }, { source: 'linkedin_banner' });
      console.log('ENRICHMENT_OK', proofPath);
    } else {
      console.log('VERIFY_FAIL', proofPath);
    }
    await playwrightService.persistSession(page, 'linkedin', accountId).catch(() => {});
    process.exit(ok ? 0 : 2);
  } finally {
    await opened.browser.close().catch(() => {});
    playwrightService._untrackBrowser(accountId);
    await pool.end().catch(() => {});
  }
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});
