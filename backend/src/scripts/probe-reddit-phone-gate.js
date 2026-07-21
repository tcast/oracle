#!/usr/bin/env node
/**
 * Probe Reddit phone-create gate WITHOUT buying SMS.
 *
 * Flow: /register → phone form → type disposable US 555 number → Continue
 * Classify: ok_register | js_challenge | network_security | tunnel_fail | ui_miss
 *
 * Usage:
 *   node src/scripts/probe-reddit-phone-gate.js [limit=12] [mix=both|proxybase|isp]
 *
 * Writes:
 *   - proxies.metadata.reddit_phone_gate / reddit_phone_gate_at / reddit_register_ok
 *   - backend/data/reddit-phone-proxy-allowlist.json (when run from host)
 *   - /tmp/reddit-phone-gate-allowlist.json (always)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const accountCreationService = require('../services/accountCreationService');
const proxyService = require('../services/proxyService');
const pool = require('../services/db');

const limit = Math.min(Math.max(parseInt(process.argv[2] || '12', 10) || 12, 1), 30);
const mix = String(process.argv[3] || 'both').toLowerCase();
const DUMMY_PHONE = '2025550147'; // US fictional 555 — never buy SMS
const TARGET_CLEAN = Math.max(3, parseInt(process.env.PROBE_TARGET_CLEAN || '3', 10) || 3);
const GOTO_MS = 45000;
const STEP_PAUSE_MS = 1800;

function classifyText(text, url = '', html = '') {
  const blob = `${text || ''} ${url || ''} ${html || ''}`;
  // Prefer explicit network-security copy over generic js_challenge markers in HTML
  if (/blocked by network security|you.?ve been blocked by network security/i.test(blob)) {
    return 'network_security';
  }
  if (/js_challenge/i.test(blob)) return 'js_challenge';
  return null;
}

function classifyError(errMsg) {
  const m = String(errMsg || '');
  if (/network.security|blocked by network/i.test(m)) return 'network_security';
  if (/js_challenge/i.test(m)) return 'js_challenge';
  if (
    /ERR_TUNNEL|ERR_TIMED_OUT|ERR_PROXY|ERR_CONNECTION|tunnel_connection|Timeout|ECONNREFUSED|ENOTFOUND|socket|PROXY_TIMEOUT/i.test(
      m
    )
  ) {
    return 'tunnel_fail';
  }
  return 'tunnel_fail';
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`PROXY_TIMEOUT ${label} after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function pickProxies() {
  const rows = [];
  const half = Math.ceil(limit / 2);
  // Skip already classified this session window (re-probe ok_register only if forced)
  const skipClassified = `AND (
    p.metadata->>'reddit_phone_gate' IS NULL
    OR p.metadata->>'reddit_phone_gate' NOT IN ('ok_register','network_security','js_challenge','tunnel_fail','ui_miss')
    OR (
      p.metadata->>'reddit_phone_gate' = 'ok_register'
      AND COALESCE(p.metadata->>'reddit_phone_gate_at','') < to_char(NOW() - INTERVAL '7 days', 'YYYY-MM-DD')
    )
  )`;

  if (mix === 'both' || mix === 'proxybase') {
    const pbLimit = mix === 'proxybase' ? limit : half;
    const { rows: pb } = await pool.query(
      `SELECT p.* FROM proxies p
       WHERE p.is_active AND p.country = 'US'
         AND p.provider ILIKE '%proxybase%'
         AND (p.cooldown_until IS NULL OR p.cooldown_until <= NOW())
         AND COALESCE(p.consecutive_failures, 0) < 3
         AND COALESCE(p.last_health_ok, true) = true
         AND COALESCE(p.last_error, '') NOT ILIKE '%network_security%'
         ${skipClassified}
       ORDER BY
         CASE WHEN p.name ILIKE '%residential%' THEN 0 ELSE 1 END,
         p.last_used_at ASC NULLS FIRST,
         random()
       LIMIT $1`,
      [pbLimit]
    );
    rows.push(...pb);
  }

  if (mix === 'both' || mix === 'isp') {
    const ispLimit = mix === 'isp' ? limit : Math.max(1, limit - rows.length);
    const { rows: isp } = await pool.query(
      `SELECT p.* FROM proxies p
       WHERE p.is_active AND p.country = 'US'
         AND p.provider ILIKE '%brightdata%'
         AND COALESCE(p.metadata->>'zone','') IN ('isp_proxy3','isp_proxy4')
         AND (p.cooldown_until IS NULL OR p.cooldown_until <= NOW())
         AND COALESCE(p.consecutive_failures, 0) < 3
         AND COALESCE(p.last_health_ok, true) = true
         ${skipClassified}
       ORDER BY
         CASE WHEN COALESCE(p.metadata->>'zone','') = 'isp_proxy4' THEN 0 ELSE 1 END,
         p.last_used_at ASC NULLS FIRST,
         random()
       LIMIT $1`,
      [ispLimit]
    );
    rows.push(...isp);
  }

  // Dedupe by id, cap at limit
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

async function markProxy(proxyId, classification, extra = {}) {
  const ok = classification === 'ok_register';
  const patch = {
    reddit_phone_gate: classification,
    reddit_phone_gate_at: new Date().toISOString(),
    reddit_register_ok: ok ? 'true' : 'false',
    ...extra,
  };
  await pool.query(
    `UPDATE proxies
     SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
         last_used_at = NOW()
     WHERE id = $1`,
    [proxyId, JSON.stringify(patch)]
  );
  if (ok) {
    await proxyService.updateProxyStats(proxyId, true).catch(() => {});
  } else if (classification === 'network_security' || classification === 'js_challenge') {
    await proxyService
      .updateProxyStats(proxyId, false, { reason: `reddit_${classification}_probe` })
      .catch(() => {});
    await proxyService
      .applyProxyCooldown(proxyId, 6, {
        reason: `reddit_${classification}`,
        minConsecutive: 1,
      })
      .catch(() => {});
  } else {
    await proxyService
      .updateProxyStats(proxyId, false, { reason: String(extra.snippet || classification).slice(0, 120) })
      .catch(() => {});
  }
}

async function probeOneInner(p) {
  const cfg = proxyService.formatProxyConfig(p);
  cfg._proxyId = p.id;
  const entry = {
    id: p.id,
    provider: p.provider,
    zone: p.metadata?.zone || null,
    name: p.name,
    session: p.metadata?.session_type || null,
  };
  let browser;
  try {
    const { browser: b, page } = await accountCreationService.createBrowser(cfg);
    browser = b;

    await page.goto('https://www.reddit.com/register/', {
      waitUntil: 'domcontentloaded',
      timeout: GOTO_MS,
    });
    await page.waitForTimeout(STEP_PAUSE_MS);
    await accountCreationService.dismissRedditCookieBanners(page);

    const pageSig = async () =>
      page.evaluate(() => ({
        url: location.href,
        snippet: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 220),
        htmlHint: (document.documentElement?.innerHTML || '').slice(0, 500),
      }));

    let sig = await pageSig();
    let cls = classifyText(sig.snippet, sig.url, sig.htmlHint);
    if (cls) {
      entry.classification = cls;
      entry.stage = 'register';
      entry.snippet = sig.snippet;
      await markProxy(p.id, cls, { snippet: sig.snippet, stage: 'register' });
      return entry;
    }

    // Short ready wait (hard-capped) — don't hang on hydrate
    await accountCreationService.waitForRedditRegisterReady(page, 12000).catch((err) => {
      const c = classifyError(err.message);
      if (c === 'network_security' || c === 'js_challenge') throw err;
    });

    sig = await pageSig();
    cls = classifyText(sig.snippet, sig.url, sig.htmlHint);
    if (cls) {
      entry.classification = cls;
      entry.stage = 'register_ready';
      entry.snippet = sig.snippet;
      await markProxy(p.id, cls, { snippet: sig.snippet, stage: 'register_ready' });
      return entry;
    }

    const clicked = await accountCreationService.clickRedditSignupMethod(page, 'phone');
    await page.waitForTimeout(STEP_PAUSE_MS);

    sig = await pageSig();
    cls = classifyText(sig.snippet, sig.url, sig.htmlHint);
    if (cls) {
      entry.classification = cls;
      entry.stage = 'after_phone_click';
      entry.snippet = sig.snippet;
      await markProxy(p.id, cls, { snippet: sig.snippet, stage: 'after_phone_click' });
      return entry;
    }

    let phoneLocator = page
      .locator(
        'faceplate-text-input[name="phone"] input, faceplate-text-input[name="phoneNumber"] input, input[name="phone"], input[name="phoneNumber"], input[type="tel"], input[autocomplete="tel"]'
      )
      .first();
    let phoneVisible = await phoneLocator.isVisible().catch(() => false);
    if (!phoneVisible) {
      if (clicked) await page.waitForTimeout(1000);
      await accountCreationService.clickRedditSignupMethod(page, 'phone');
      phoneLocator = page
        .locator(
          'faceplate-text-input input, auth-flow-modal input[type="tel"], input[type="tel"], input[name="phone"]'
        )
        .first();
      await phoneLocator.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
      phoneVisible = await phoneLocator.isVisible().catch(() => false);
    }

    if (!phoneVisible) {
      sig = await pageSig();
      cls = classifyText(sig.snippet, sig.url, sig.htmlHint) || 'ui_miss';
      entry.classification = cls;
      entry.stage = 'phone_form';
      entry.snippet = sig.snippet;
      await markProxy(p.id, cls, { snippet: sig.snippet, stage: 'phone_form' });
      return entry;
    }

    // Fast fill — do NOT call SMS-Man / slow human typing
    await phoneLocator.click({ timeout: 5000 });
    await phoneLocator.fill('');
    await phoneLocator.fill(DUMMY_PHONE);
    await page.waitForTimeout(400);

    const btn = page.locator('button:has-text("Continue"):not([disabled])').last();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 8000 });
    } else {
      await page.locator('button:has-text("Continue")').last().click({ force: true }).catch(() => {});
    }
    await page.waitForTimeout(2200);

    sig = await pageSig();
    cls = classifyText(sig.snippet, sig.url, sig.htmlHint);
    if (cls) {
      entry.classification = cls;
      entry.stage = 'after_continue';
      entry.snippet = sig.snippet;
      await markProxy(p.id, cls, { snippet: sig.snippet, stage: 'after_continue' });
      return entry;
    }

    // Cleared network gate (dummy phone rejection still counts).
    entry.classification = 'ok_register';
    entry.stage = 'after_continue';
    entry.snippet = sig.snippet;
    entry.phone_rejected = /try a different number|invalid phone|not able to verify|couldn't verify|please enter a valid/i.test(
      sig.snippet
    );
    entry.otp_hint = /verification code|enter the code|6-digit|texted you|sent you a code/i.test(
      sig.snippet
    );
    entry.still_on_phone_form = /phone number/i.test(sig.snippet) && !entry.otp_hint;
    await markProxy(p.id, 'ok_register', {
      snippet: entry.snippet,
      stage: 'after_continue',
      dummy_phone: DUMMY_PHONE,
    });
    return entry;
  } catch (e) {
    const msg = e.message || String(e);
    const cls = classifyError(msg);
    entry.classification = cls;
    entry.stage = 'exception';
    entry.error = msg.slice(0, 200);
    await markProxy(p.id, cls, { snippet: msg.slice(0, 160), stage: 'exception' }).catch(() => {});
    return entry;
  } finally {
    if (browser) {
      await Promise.race([
        browser.close().catch(() => {}),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    }
  }
}

async function probeOne(p) {
  try {
    return await withTimeout(probeOneInner(p), 70000, `proxy ${p.id}`);
  } catch (e) {
    const msg = e.message || String(e);
    const cls = classifyError(msg);
    const entry = {
      id: p.id,
      provider: p.provider,
      zone: p.metadata?.zone || null,
      name: p.name,
      classification: cls,
      stage: 'timeout',
      error: msg.slice(0, 200),
    };
    await markProxy(p.id, cls, { snippet: msg.slice(0, 160), stage: 'timeout' }).catch(() => {});
    return entry;
  }
}

// Swallow late Playwright CDP errors after forced close / timeout
process.on('uncaughtException', (err) => {
  const msg = err?.message || String(err);
  if (/has been closed|Target closed|Protocol error|cdpSession/i.test(msg)) {
    console.warn(`uncaught_swallowed ${msg.slice(0, 120)}`);
    return;
  }
  console.error('FATAL_UNCAUGHT', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  const msg = err?.message || String(err);
  if (/has been closed|Target closed|Protocol error|cdpSession/i.test(msg)) {
    console.warn(`rejection_swallowed ${msg.slice(0, 120)}`);
    return;
  }
  console.error('FATAL_REJECTION', err);
  process.exit(1);
});


function writeAllowlist(cleanIds, results) {
  const payload = {
    updated_at: new Date().toISOString(),
    dummy_phone: DUMMY_PHONE,
    clean_proxy_ids: cleanIds,
    results: results.map((r) => ({
      id: r.id,
      provider: r.provider,
      zone: r.zone,
      classification: r.classification,
      stage: r.stage,
    })),
  };
  const tmpPath = '/tmp/reddit-phone-gate-allowlist.json';
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
  console.log(`wrote ${tmpPath}`);

  // Prefer repo data path when writable
  const candidates = [
    path.join(__dirname, '../../data/reddit-phone-proxy-allowlist.json'),
    '/app/data/reddit-phone-proxy-allowlist.json',
    '/home/tcast/Sites/whisper/backend/data/reddit-phone-proxy-allowlist.json',
  ];
  for (const dest of candidates) {
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, JSON.stringify(payload, null, 2));
      console.log(`wrote ${dest}`);
      break;
    } catch (_) {
      /* try next */
    }
  }
  return payload;
}

(async () => {
  const existingClean = (
    await pool.query(
      `SELECT id FROM proxies
       WHERE COALESCE(metadata->>'reddit_phone_gate','') = 'ok_register'
         AND is_active = true
         AND (cooldown_until IS NULL OR cooldown_until <= NOW())`
    )
  ).rows.map((r) => r.id);
  console.log(JSON.stringify({ existing_clean: existingClean }));

  const need = Math.max(0, TARGET_CLEAN - existingClean.length);
  if (need === 0) {
    console.log('ALREADY_HAVE_TARGET');
    writeAllowlist(existingClean, existingClean.map((id) => ({ id, classification: 'ok_register' })));
    await pool.end().catch(() => {});
    process.exit(0);
  }

  const proxies = await pickProxies();
  console.log(
    JSON.stringify({
      probing: proxies.length,
      mix,
      target_clean: TARGET_CLEAN,
      need_more: need,
      ids: proxies.map((p) => p.id),
      providers: proxies.map((p) => `${p.id}:${p.provider}`),
    })
  );

  const results = [];
  for (const p of proxies) {
    const entry = await probeOne(p);
    console.log(JSON.stringify(entry));
    results.push(entry);
    const cleanCount =
      existingClean.length + results.filter((r) => r.classification === 'ok_register').length;
    if (cleanCount >= TARGET_CLEAN) {
      console.log(`TARGET_CLEAN_MET count=${cleanCount}`);
      break;
    }
  }

  const cleanNew = results.filter((r) => r.classification === 'ok_register').map((r) => r.id);
  const cleanAll = [...new Set([...existingClean, ...cleanNew])];
  const summary = {
    probed: results.length,
    clean: cleanAll,
    clean_new: cleanNew,
    by_class: results.reduce((acc, r) => {
      acc[r.classification] = (acc[r.classification] || 0) + 1;
      return acc;
    }, {}),
  };
  writeAllowlist(cleanAll, results);
  console.log(JSON.stringify(summary));
  await pool.end().catch(() => {});
  process.exit(cleanAll.length >= 3 ? 0 : cleanAll.length > 0 ? 2 : 3);
})().catch(async (e) => {
  console.error('FATAL', e);
  try {
    await pool.end();
  } catch (_) {}
  process.exit(1);
});
