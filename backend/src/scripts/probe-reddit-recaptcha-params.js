#!/usr/bin/env node
/**
 * Capture Reddit phone-verify reCAPTCHA Enterprise params WITHOUT buying SMS.
 * Does NOT solve captcha — lets native grecaptcha.enterprise.execute run so we can
 * compare native token outcome vs solver tokens (56a391).
 *
 * Usage:
 *   PILOT_PROXY_IDS=118,81 node src/scripts/probe-reddit-recaptcha-params.js
 */
require('dotenv').config();
const fs = require('fs');
const accountCreationService = require('../services/accountCreationService');
const proxyService = require('../services/proxyService');
const pool = require('../services/db');

const LOG = process.env.PILOT_LOG || '/tmp/reddit-recaptcha-params.log';
const DUMMY_PHONE = process.env.DUMMY_PHONE || '2025550147';
const proxyIds = String(process.env.PILOT_PROXY_IDS || '118,81,107')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0);

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG, `${line}\n`);
  } catch (_) {
    /* ignore */
  }
}

async function installHooks(page) {
  await page.addInitScript(() => {
    window.__oracleRecaptchaProbe = {
      executeCalls: [],
      renderCalls: [],
      siteKeys: [],
      tokenHeads: [],
      errors: [],
    };
    const wrap = () => {
      try {
        const g = window.grecaptcha;
        if (!g?.enterprise || g.enterprise.__oracleProbed) return !!g?.enterprise;
        g.enterprise.__oracleProbed = true;
        const origExec = g.enterprise.execute?.bind(g.enterprise);
        const origRender = g.enterprise.render?.bind(g.enterprise);
        if (origExec) {
          g.enterprise.execute = async (...args) => {
            const [siteKey, opts] = args;
            const entry = {
              siteKey,
              opts: null,
              at: Date.now(),
              href: location.href,
            };
            try {
              entry.opts = opts ? JSON.parse(JSON.stringify(opts)) : null;
            } catch (_) {
              entry.opts = { raw: String(opts) };
            }
            window.__oracleRecaptchaProbe.executeCalls.push(entry);
            if (siteKey) window.__oracleRecaptchaProbe.siteKeys.push(siteKey);
            const token = await origExec(...args);
            try {
              window.__oracleRecaptchaProbe.tokenHeads.push({
                len: String(token || '').length,
                head: String(token || '').slice(0, 24),
              });
            } catch (_) {
              /* ignore */
            }
            return token;
          };
        }
        if (origRender) {
          g.enterprise.render = (...args) => {
            const [, params] = args;
            try {
              window.__oracleRecaptchaProbe.renderCalls.push({
                params: params ? JSON.parse(JSON.stringify(params)) : null,
                at: Date.now(),
              });
              if (params?.sitekey) window.__oracleRecaptchaProbe.siteKeys.push(params.sitekey);
            } catch (e) {
              window.__oracleRecaptchaProbe.errors.push(String(e));
            }
            return origRender(...args);
          };
        }
        return true;
      } catch (e) {
        window.__oracleRecaptchaProbe.errors.push(String(e));
        return false;
      }
    };
    wrap();
    const t = setInterval(() => {
      if (wrap()) clearInterval(t);
    }, 150);
    setTimeout(() => clearInterval(t), 90000);
  });
}

async function probeOne(proxyId) {
  const row = (await pool.query('SELECT * FROM proxies WHERE id=$1', [proxyId])).rows[0];
  if (!row) {
    log(`proxy ${proxyId} missing`);
    return null;
  }
  const proxyConfig = proxyService.formatProxyConfig(row);
  proxyConfig._proxyId = proxyId;
  log(`using proxy ${proxyId} provider=${row.provider} server=${proxyConfig?.server || 'none'}`);

  const { browser, page } = await accountCreationService.createBrowser(proxyConfig);
  const netKeys = [];
  const verifyBodies = [];
  const reloadParams = [];
  let verifyStatus = null;

  page.on('request', (req) => {
    const url = req.url();
    if (/recaptcha\/enterprise\/(?:reload|anchor)/i.test(url)) {
      try {
        const u = new URL(url);
        const entry = {
          kind: /anchor/i.test(url) ? 'anchor' : 'reload',
          k: u.searchParams.get('k'),
          size: u.searchParams.get('size'),
          sa: u.searchParams.get('sa'),
        };
        const post = req.postData() || '';
        if (post) {
          entry.postKeys = [...post.matchAll(/([a-zA-Z0-9_]+)=/g)].map((m) => m[1]).slice(0, 40);
          const sMatch = post.match(/(?:^|&)s=([^&]+)/);
          if (sMatch) entry.sLen = decodeURIComponent(sMatch[1]).length;
          const reason = post.match(/(?:^|&)reason=([^&]+)/);
          if (reason) entry.reason = decodeURIComponent(reason[1]);
        }
        reloadParams.push(entry);
        if (entry.k) netKeys.push(entry.k);
      } catch (_) {
        /* ignore */
      }
    }
    if (/verify_phone_by_code_initialize/i.test(url)) {
      const body = req.postData() || '';
      const redacted = body.replace(/"recaptcha_token":"[^"]+"/, (m) => {
        const tok = m.slice('"recaptcha_token":"'.length, -1);
        return `"recaptcha_token":"${tok.slice(0, 28)}…len=${tok.length}"`;
      });
      verifyBodies.push(redacted.slice(0, 900));
    }
  });
  page.on('response', async (resp) => {
    if (/verify_phone_by_code_initialize/i.test(resp.url())) {
      verifyStatus = resp.status();
      try {
        const body = (await resp.text()).replace(/\s+/g, ' ').slice(0, 280);
        verifyBodies.push(`RESP ${resp.status()} ${body}`);
      } catch (_) {
        /* ignore */
      }
    }
  });

  try {
    await installHooks(page);
    await page.goto('https://www.reddit.com/register/', {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await accountCreationService.humanLikeDelay(1500, 2500);
    await accountCreationService.dismissRedditCookieBanners(page).catch(() => {});
    await accountCreationService.waitForRedditRegisterReady(page);
    await accountCreationService.clickRedditSignupMethod(page, 'phone');
    await accountCreationService.humanLikeDelay(2000, 3000);

    const phoneLocator = page
      .locator(
        'faceplate-text-input[name="phone"] input, input[name="phone"], input[type="tel"], input[autocomplete="tel"]'
      )
      .first();
    await phoneLocator.waitFor({ state: 'visible', timeout: 25000 });
    await accountCreationService.typeIntoLocator(page, phoneLocator, DUMMY_PHONE);
    await accountCreationService.humanLikeDelay(1000, 1500);

    const cfgDump = await page.evaluate(() => {
      const out = {
        sitekeys: [],
        actions: [],
        sValues: [],
        enterprise: !!window.grecaptcha?.enterprise,
      };
      const walk = (obj, depth = 0, seen = new WeakSet()) => {
        if (!obj || typeof obj !== 'object' || depth > 8) return;
        if (seen.has(obj)) return;
        try {
          seen.add(obj);
        } catch (_) {
          return;
        }
        for (const [k, v] of Object.entries(obj)) {
          if (k === 'sitekey' && typeof v === 'string') out.sitekeys.push(v);
          if (k === 'action' && typeof v === 'string') out.actions.push(v);
          if ((k === 's' || k === 'data-s') && typeof v === 'string' && v.length > 20) {
            out.sValues.push({ len: v.length, head: v.slice(0, 24) });
          }
          if (v && typeof v === 'object') walk(v, depth + 1, seen);
        }
      };
      try {
        walk(window.___grecaptcha_cfg);
      } catch (_) {
        /* ignore */
      }
      for (const el of document.querySelectorAll('[data-s], [data-sitekey]')) {
        const sk = el.getAttribute('data-sitekey');
        const ds = el.getAttribute('data-s');
        if (sk) out.sitekeys.push(sk);
        if (ds) out.sValues.push({ len: ds.length, head: ds.slice(0, 24) });
      }
      return out;
    });
    log(`cfg_dump ${JSON.stringify(cfgDump)}`);

    await accountCreationService.clickRedditContinue(page);
    // Native execute can take a few seconds
    await accountCreationService.humanLikeDelay(8000, 10000);

    const after = await page.evaluate(() => window.__oracleRecaptchaProbe || null);
    const pageState = await page.evaluate(() => {
      const text = (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 500);
      return { text, hasEnterprise: !!window.grecaptcha?.enterprise, url: location.href };
    });

    const out = {
      proxyId,
      mode: 'native_no_solver',
      dummyPhone: DUMMY_PHONE,
      verifyStatus,
      executeCalls: after?.executeCalls || [],
      renderCalls: after?.renderCalls || [],
      tokenHeads: after?.tokenHeads || [],
      siteKeys: [...new Set([...(after?.siteKeys || []), ...netKeys, ...(cfgDump.sitekeys || [])])],
      actions: [...new Set(cfgDump.actions || [])],
      sHints: cfgDump.sValues || [],
      reloadParams: reloadParams.slice(0, 10),
      verifyBodies,
      pageText: pageState.text,
      url: pageState.url,
      hasEnterprise: pageState.hasEnterprise,
      probeErrors: after?.errors || [],
    };
    log(`RESULT ${JSON.stringify(out, null, 2)}`);
    const snap = `/tmp/reddit-recaptcha-probe-${proxyId}-${Date.now()}.png`;
    await page.screenshot({ path: snap, fullPage: true }).catch(() => {});
    log(`snap ${snap}`);
    return out;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  log(`start proxies=${proxyIds.join(',')} dummy=${DUMMY_PHONE}`);
  for (const id of proxyIds) {
    try {
      const r = await probeOne(id);
      if (r?.executeCalls?.length || r?.verifyBodies?.length) break;
    } catch (err) {
      log(`proxy ${id} failed: ${err.message}`);
    }
  }
  await pool.end().catch(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
