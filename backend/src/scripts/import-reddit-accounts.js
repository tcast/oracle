#!/usr/bin/env node
/**
 * Import Reddit accounts from JSON exported from Excel dumps.
 *
 * JSON row shape:
 *   { username, password, email, email_password, cookies?, batch? }
 *
 * Usage:
 *   node src/scripts/import-reddit-accounts.js /app/private/reddit-accounts-batch.json
 *   node src/scripts/import-reddit-accounts.js /app/private/reddit-accounts-batch.json --smoke=10
 *   node src/scripts/import-reddit-accounts.js ... --allow-missing-totp   # legacy dumps without 2FA
 *   node src/scripts/import-reddit-accounts.js ... --auto-assign         # unbound ProxyBase (prefer mobile/res)
 *   node src/scripts/import-reddit-accounts.js ... --enable-organic --daily-target=3
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../services/db');
const proxyService = require('../services/proxyService');
const playwrightService = require('../services/playwrightService');
const organicCommentService = require('../services/organicCommentService');
const { assertImportCredentials } = require('../utils/credentialGate');

function sanitizeCookies(cookies) {
  if (!Array.isArray(cookies)) return [];
  return cookies
    .filter((c) => c && c.name && c.value != null && c.domain)
    .map((c) => {
      const out = {
        name: String(c.name),
        value: String(c.value),
        domain: String(c.domain),
        path: c.path || '/',
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
      };
      if (typeof c.expires === 'number' && c.expires > 0) {
        out.expires = c.expires;
      }
      if (c.sameSite && ['Strict', 'Lax', 'None'].includes(c.sameSite)) {
        out.sameSite = c.sameSite;
      }
      return out;
    });
}

async function takeProxiesFromPendingShells(needed) {
  const shells = await pool.query(
    `SELECT sa.id AS account_id, sap.proxy_id
     FROM social_accounts sa
     JOIN social_account_proxies sap ON sap.social_account_id = sa.id AND sap.is_active = true
     WHERE sa.status = 'pending_setup' AND sa.platform = 'reddit'
     ORDER BY sa.id
     LIMIT $1`,
    [needed]
  );
  const proxyIds = [];
  for (const row of shells.rows) {
    await pool.query(
      `UPDATE social_account_proxies SET is_active = false WHERE social_account_id = $1 AND proxy_id = $2`,
      [row.account_id, row.proxy_id]
    );
    await pool.query(`DELETE FROM social_account_proxies WHERE social_account_id = $1`, [row.account_id]);
    await pool.query(
      `DELETE FROM social_accounts WHERE id = $1 AND status = 'pending_setup'`,
      [row.account_id]
    );
    proxyIds.push(row.proxy_id);
  }
  return proxyIds;
}

/** Unbound ProxyBase only — never Bright Data / Oxylabs. Prefer mobile then residential. */
async function takeUnboundProxyBase(needed) {
  const result = await pool.query(
    `SELECT p.id
     FROM proxies p
     WHERE p.is_active = true
       AND p.provider = 'ProxyBase'
       AND COALESCE(p.failure_count, 0) < 3
       AND NOT EXISTS (
         SELECT 1 FROM social_account_proxies sap
         WHERE sap.proxy_id = p.id AND sap.is_active = true
       )
     ORDER BY
       CASE
         WHEN COALESCE(p.metadata->>'session_type', '') ILIKE '%mobile%'
           OR p.name ILIKE '%mobile%' THEN 0
         WHEN COALESCE(p.metadata->>'session_type', '') ILIKE '%res%'
           OR p.name ILIKE '%res%' THEN 1
         ELSE 2
       END,
       p.last_used_at ASC NULLS FIRST,
       p.id
     LIMIT $1`,
    [needed]
  );
  return result.rows.map((r) => r.id);
}

async function upsertRedditAccount(row, proxyId) {
  const gate = assertImportCredentials(row, {
    requireTotp: false, // already asserted in main when strict
    preferEmailAccess: true,
  });

  const credentials = {
    password: row.password,
    email: row.email || null,
    email_password: row.email_password || null,
    totp_secret: gate.totp_secret || row.totp_secret || null,
    source: 'excel_import',
    batch: row.batch || null,
    order_id: row.order_id || null,
    notes: row.order_id ? `order ${row.order_id}` : row.notes || null,
    has_cookies: Array.isArray(row.cookies) && row.cookies.length > 0,
    credential_gate: gate.totp_secret ? 'ok' : 'missing_totp',
    credential_warnings: gate.warnings,
  };

  const existing = await pool.query(
    `SELECT id FROM social_accounts
     WHERE platform = 'reddit' AND lower(username) = lower($1)
     LIMIT 1`,
    [row.username]
  );

  let accountId;
  if (existing.rows[0]) {
    accountId = existing.rows[0].id;
    await pool.query(
      `UPDATE social_accounts
       SET email = $2,
           credentials = credentials || $3::jsonb,
           status = 'active',
           is_simulated = false,
           warmup_status = CASE
             WHEN warmup_status = 'new' THEN 'pending'
             ELSE warmup_status
           END,
           updated_at = NOW()
       WHERE id = $1`,
      [accountId, row.email || null, JSON.stringify(credentials)]
    );
  } else {
    const inserted = await pool.query(
      `INSERT INTO social_accounts
         (platform, username, email, credentials, status, is_simulated, warmup_status)
       VALUES ('reddit', $1, $2, $3::jsonb, 'active', false, 'pending')
       RETURNING id`,
      [row.username, row.email || null, JSON.stringify(credentials)]
    );
    accountId = inserted.rows[0].id;
  }

  if (proxyId) {
    // ensure 1:1
    await pool.query(
      `UPDATE social_account_proxies SET is_active = false WHERE social_account_id = $1 AND is_active = true`,
      [accountId]
    );
    await proxyService.assignProxiesToAccount(accountId, [proxyId]);
  }

  const cookies = sanitizeCookies(row.cookies);
  if (cookies.length) {
    await pool.query(
      `INSERT INTO browser_sessions (account_id, platform, cookies, session_data, user_agent)
       VALUES ($1, 'reddit', $2::jsonb, '{}'::jsonb, NULL)
       ON CONFLICT (account_id, platform)
       DO UPDATE SET cookies = $2::jsonb, updated_at = NOW()`,
      [accountId, JSON.stringify(cookies)]
    );
  }

  return { accountId, cookieCount: cookies.length, username: row.username };
}

async function smokeRedditSession(accountId) {
  let browser;
  try {
    const account = await playwrightService.getAccount(accountId);
    const result = await playwrightService.createBrowserForAccount(accountId, 2, {
      requireProxy: false,
    });
    browser = result.browser;
    const page = result.page;

    const restored = await playwrightService.restoreSession(page, 'reddit', accountId);
    await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await playwrightService.humanLikeDelay(2000, 3500);

    let loggedIn = await page.$(
      '#expand-user-drawer-button, [id*="UserDrawer"], faceplate-tracker[noun="user_drawer"], a[href^="/user/"]'
    );
    if (!loggedIn) {
      // cookie may be stale — try password login
      const password = account.credentials?.password;
      loggedIn = await playwrightService.ensureLoggedIn(
        page,
        'reddit',
        accountId,
        account.username,
        password
      );
    } else {
      await playwrightService.persistSession(page, 'reddit', accountId);
      loggedIn = true;
    }

    if (loggedIn) {
      await pool.query(
        `UPDATE social_accounts
         SET warmup_status = 'warmed', warmed_up_at = NOW(), last_used_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [accountId]
      );
    }

    return {
      success: !!loggedIn,
      accountId,
      username: account.username,
      restored,
    };
  } catch (error) {
    return { success: false, accountId, error: error.message };
  } finally {
    if (browser) await browser.close().catch(() => {});
    playwrightService._untrackBrowser?.(accountId);
  }
}

async function enableOrganicStaggered(accountIds, dailyTarget = 3) {
  let enabled = 0;
  for (let i = 0; i < accountIds.length; i++) {
    const accountId = accountIds[i];
    await organicCommentService.setAccountEnabled(accountId, true);
    const staggerMin = 5 + Math.floor(Math.random() * 90) + i * 3;
    await pool.query(
      `UPDATE organic_comment_jobs
       SET daily_target = $2,
           next_due_at = NOW() + ($3 || ' minutes')::interval,
           status = 'idle',
           updated_at = NOW()
       WHERE social_account_id = $1`,
      [accountId, dailyTarget, String(staggerMin)]
    );
    enabled += 1;
  }
  return enabled;
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error(
      'Usage: node src/scripts/import-reddit-accounts.js <json> [--smoke=N] [--auto-assign] [--enable-organic] [--daily-target=3]'
    );
    process.exit(1);
  }
  const smokeArg = process.argv.find((a) => a.startsWith('--smoke'));
  const smokeN = smokeArg ? Number(smokeArg.split('=')[1] || 5) : 0;
  const autoAssign = process.argv.includes('--auto-assign');
  const enableOrganic = process.argv.includes('--enable-organic');
  const dailyArg = process.argv.find((a) => a.startsWith('--daily-target'));
  const dailyTarget = dailyArg ? Number(dailyArg.split('=')[1] || 3) : 3;

  const raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  if (!Array.isArray(raw) || !raw.length) throw new Error('JSON must be a non-empty array');

  console.log(`Importing ${raw.length} Reddit accounts from ${file}`);
  let proxyIds = [];
  if (autoAssign) {
    proxyIds = await takeUnboundProxyBase(raw.length);
    console.log(`Auto-assigned pool: ${proxyIds.length} unbound ProxyBase (mobile/res preferred)`);
  } else {
    proxyIds = await takeProxiesFromPendingShells(raw.length);
    console.log(`Reclaimed ${proxyIds.length} proxies from pending_setup shells`);
    if (proxyIds.length < raw.length) {
      const more = await takeUnboundProxyBase(raw.length - proxyIds.length);
      console.log(`Filled ${more.length} more from unbound ProxyBase`);
      proxyIds = proxyIds.concat(more);
    }
  }

  const results = [];
  const allowMissingTotp = process.argv.includes('--allow-missing-totp');
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i];
    const proxyId = proxyIds[i] || null;
    try {
      assertImportCredentials(row, {
        requireTotp: !allowMissingTotp,
        preferEmailAccess: true,
      });
      const r = await upsertRedditAccount(row, proxyId);
      results.push({ ...r, proxyId, ok: true });
      console.log(
        `  #${r.accountId} u=${r.username} cookies=${r.cookieCount} proxy=${proxyId || 'NONE'}`
      );
    } catch (err) {
      console.error(`  FAIL ${row.username}:`, err.message);
      results.push({ username: row.username, ok: false, error: err.message });
    }
  }

  const ok = results.filter((r) => r.ok);
  const withProxy = ok.filter((r) => r.proxyId);
  const withCookies = ok.filter((r) => r.cookieCount > 0);
  console.log(
    `\nImported ${ok.length}/${raw.length} (proxied=${withProxy.length}, cookies=${withCookies.length})`
  );

  const smokePassIds = [];
  if (smokeN > 0) {
    // Prefer cookie accounts first
    const smokeIds = [
      ...withCookies.map((r) => r.accountId),
      ...ok.filter((r) => !r.cookieCount).map((r) => r.accountId),
    ].slice(0, smokeN);

    console.log(`\nSmoke-testing ${smokeIds.length} account(s)…`);
    let pass = 0;
    for (const id of smokeIds) {
      console.log(`\n=== Account ${id} ===`);
      const r = await smokeRedditSession(id);
      console.log(JSON.stringify(r));
      if (r.success) {
        pass += 1;
        smokePassIds.push(id);
      }
      await new Promise((res) => setTimeout(res, 5000 + Math.floor(Math.random() * 4000)));
    }
    console.log(`\nSmoke: ${pass}/${smokeIds.length} ok`);
  }

  if (enableOrganic) {
    // Prior bought-Reddit pattern: enroll all imported (login on first organic tick).
    // If smoke ran, still enroll all proxied imports — smoke is a sample, not a gate.
    const enrollIds = ok.filter((r) => r.proxyId).map((r) => r.accountId);
    const n = await enableOrganicStaggered(enrollIds, dailyTarget);
    console.log(`\nOrganic enabled: ${n} (daily_target=${dailyTarget}, staggered)`);
  }

  console.log(
    JSON.stringify({
      imported: ok.length,
      with_proxy: withProxy.length,
      smoke_pass: smokePassIds.length,
      smoke_n: smokeN,
      organic_enabled: enableOrganic ? ok.filter((r) => r.proxyId).length : 0,
    })
  );

  await pool.end().catch(() => {});
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
