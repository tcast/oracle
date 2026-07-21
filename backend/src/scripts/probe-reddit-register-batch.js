#!/usr/bin/env node
/**
 * Probe N US proxies against reddit.com/register — find ones that aren't blocked.
 * Usage: node src/scripts/probe-reddit-register-batch.js [limit] [provider]
 * provider: isp|proxybase|any
 */
require('dotenv').config();
const accountCreationService = require('../services/accountCreationService');
const proxyService = require('../services/proxyService');
const pool = require('../services/db');

const limit = Math.min(Math.max(parseInt(process.argv[2] || '8', 10) || 8, 1), 20);
const providerHint = String(process.argv[3] || 'isp').toLowerCase();

(async () => {
  let where = `p.is_active AND p.country = 'US'
    AND (p.cooldown_until IS NULL OR p.cooldown_until <= NOW())
    AND COALESCE(p.consecutive_failures, 0) < 3`;
  if (providerHint === 'isp') {
    where += ` AND p.provider ILIKE '%brightdata%' AND COALESCE(p.metadata->>'zone','') IN ('isp_proxy3','isp_proxy4')`;
  } else if (providerHint === 'proxybase') {
    where += ` AND p.provider ILIKE '%proxybase%' AND COALESCE(p.failure_count,0) < 2`;
  }
  const { rows } = await pool.query(
    `SELECT p.* FROM proxies p
     WHERE ${where}
     ORDER BY
       CASE WHEN COALESCE(p.metadata->>'zone','')='isp_proxy4' THEN 0 ELSE 1 END,
       p.last_used_at ASC NULLS FIRST,
       random()
     LIMIT $1`,
    [limit]
  );
  console.log(`probing ${rows.length} proxies hint=${providerHint}`);
  const results = [];
  for (const p of rows) {
    const cfg = proxyService.formatProxyConfig(p);
    let browser;
    const entry = {
      id: p.id,
      provider: p.provider,
      zone: p.metadata?.zone || null,
      name: p.name,
    };
    try {
      const { browser: b, page } = await accountCreationService.createBrowser(cfg);
      browser = b;
      await page.goto('https://www.reddit.com/register/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await page.waitForTimeout(2500);
      const info = await page.evaluate(() => {
        const text = (document.body?.innerText || '').slice(0, 300);
        const blocked = /blocked by network security|js_challenge/i.test(text + location.href);
        const hasEmail =
          !!document.querySelector(
            'faceplate-text-input[name="email"] input, input[name="email"], input[type="email"], #regEmail'
          ) || /email/i.test(text);
        return { url: location.href.slice(0, 120), blocked, hasEmail, text: text.replace(/\s+/g, ' ').slice(0, 160) };
      });
      entry.ok = !info.blocked && (info.hasEmail || /register/i.test(info.url));
      entry.blocked = info.blocked;
      entry.hasEmail = info.hasEmail;
      entry.url = info.url;
      entry.text = info.text;
      if (entry.blocked) {
        await proxyService.updateProxyStats(p.id, false, { reason: 'reddit_network_security_probe' });
        await proxyService.applyProxyCooldown(p.id, 6, {
          reason: 'reddit_network_security',
          minConsecutive: 1,
        });
      } else if (entry.ok) {
        await proxyService.updateProxyStats(p.id, true);
      }
    } catch (e) {
      entry.ok = false;
      entry.error = (e.message || String(e)).slice(0, 160);
      await proxyService
        .updateProxyStats(p.id, false, { reason: entry.error.slice(0, 120) })
        .catch(() => {});
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
    console.log(JSON.stringify(entry));
    results.push(entry);
    if (entry.ok) {
      console.log(`FOUND_OK proxy=${p.id}`);
      // Keep scanning a couple more for backup, then stop early if we have 2
      if (results.filter((r) => r.ok).length >= 2) break;
    }
  }
  console.log(
    JSON.stringify({
      ok: results.filter((r) => r.ok).map((r) => r.id),
      blocked: results.filter((r) => r.blocked).map((r) => r.id),
      errors: results.filter((r) => r.error).map((r) => ({ id: r.id, error: r.error })),
    })
  );
  await pool.end();
  process.exit(results.some((r) => r.ok) ? 0 : 2);
})().catch(async (e) => {
  console.error(e);
  try {
    await pool.end();
  } catch (_) {}
  process.exit(1);
});
