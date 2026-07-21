#!/usr/bin/env node
/**
 * Probe Reddit /register UI for phone vs email signup controls.
 * Usage: PILOT_PROXY_IDS=104 node src/scripts/probe-reddit-register-ui.js
 */
require('dotenv').config();
const accountCreationService = require('../services/accountCreationService');
const proxyService = require('../services/proxyService');
const pool = require('../services/db');
const fs = require('fs');

const proxyId = parseInt(String(process.env.PILOT_PROXY_IDS || '104').split(',')[0], 10);
const snap = process.env.PILOT_SNAP || `/tmp/reddit-register-ui-${Date.now()}.png`;

(async () => {
  const proxyRow = (await pool.query('SELECT * FROM proxies WHERE id=$1', [proxyId])).rows[0];
  if (!proxyRow) throw new Error(`proxy ${proxyId} missing`);
  const proxyConfig = proxyService.formatProxyConfig(proxyRow);
  proxyConfig._proxyId = proxyId;
  const { browser, page } = await accountCreationService.createBrowser(proxyConfig);
  try {
    await page.goto('https://www.reddit.com/register/', {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });
    await accountCreationService.humanLikeDelay(3000, 5000);
    await accountCreationService.dismissRedditCookieBanners(page);
    await accountCreationService.humanLikeDelay(1000, 2000);

    const info = await page.evaluate(() => {
      const text = (document.body?.innerText || '').slice(0, 2500);
      const buttons = [...document.querySelectorAll('button, a, [role="button"]')]
        .map((el) => ({
          tag: el.tagName,
          text: (el.innerText || el.textContent || '').trim().slice(0, 80),
          aria: el.getAttribute('aria-label'),
          href: el.getAttribute('href'),
        }))
        .filter((b) => b.text || b.aria)
        .slice(0, 60);
      const inputs = [...document.querySelectorAll('input, faceplate-text-input')]
        .map((el) => ({
          tag: el.tagName,
          name: el.getAttribute('name'),
          type: el.getAttribute('type'),
          autocomplete: el.getAttribute('autocomplete'),
          placeholder: el.getAttribute('placeholder'),
        }))
        .slice(0, 40);
      return {
        title: document.title,
        url: location.href,
        text,
        buttons,
        inputs,
        hasPhoneText: /phone/i.test(text),
        hasEmailText: /email/i.test(text),
      };
    });

    await page.screenshot({ path: snap, fullPage: true }).catch(() => {});
    console.log(JSON.stringify({ snap, proxyId, ...info }, null, 2));
  } finally {
    await browser.close().catch(() => {});
    await pool.end().catch(() => {});
  }
})().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
