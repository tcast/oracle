#!/usr/bin/env node
/**
 * Import X (Twitter) accounts from AccsMarket-style dumps.
 *
 * Line format (---- outer, | inside the email/token block):
 *   username----password----email|email_password|auth_token|batch_uuid----totp_secret----ct0
 *
 * Persists auth_token + ct0 into browser_sessions as .x.com cookies.
 * Reclaims proxies from pending_setup shells when available.
 *
 * Usage (in container):
 *   node src/scripts/import-x-accounts.js /app/private/x-accounts-order-206264.txt
 *   node src/scripts/import-x-accounts.js /app/private/x-accounts-order-206264.txt --smoke=1
 *
 * Smoke is cookie-restore only (allowLogin=false). Default: no smoke.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../services/db');
const proxyService = require('../services/proxyService');
const playwrightService = require('../services/playwrightService');
const { assertImportCredentials } = require('../utils/credentialGate');

function parseLine(line) {
  const raw = String(line || '').trim();
  if (!raw || raw.startsWith('#')) return null;

  const dash = raw.split('----');
  if (dash.length !== 5) {
    throw new Error(`Expected 5 ---- fields, got ${dash.length}`);
  }

  const username = dash[0].trim();
  const password = dash[1].trim();
  const mid = dash[2].split('|');
  if (mid.length !== 4) {
    throw new Error(`Expected email|email_pass|auth_token|batch_uuid, got ${mid.length} pipe fields`);
  }

  const email = mid[0].trim();
  const email_password = mid[1].trim();
  const auth_token = mid[2].trim();
  const batch_uuid = mid[3].trim();
  const totp_secret = dash[3].trim();
  const ct0 = dash[4].trim();

  if (!username || !password) throw new Error('Missing username/password');
  if (!/@/.test(email)) throw new Error(`Invalid email: ${email}`);
  if (!auth_token.startsWith('M.')) throw new Error('auth_token does not look like X cookie');
  if (!/^[0-9a-f]{40}$/i.test(ct0)) throw new Error(`ct0 must be 40-hex, got len=${ct0.length}`);

  const row = {
    username,
    password,
    email,
    email_password,
    auth_token,
    batch_uuid,
    totp_secret,
    ct0,
  };
  assertImportCredentials(row, { requireTotp: true, preferEmailAccess: true });
  return row;
}

function buildXCookies(authToken, ct0) {
  const base = { path: '/', secure: true };
  return [
    {
      ...base,
      name: 'auth_token',
      value: authToken,
      domain: '.x.com',
      httpOnly: true,
      sameSite: 'None',
    },
    {
      ...base,
      name: 'ct0',
      value: ct0,
      domain: '.x.com',
      httpOnly: false,
      sameSite: 'Lax',
    },
  ];
}

async function takeProxiesFromPendingShells(needed) {
  const shells = await pool.query(
    `SELECT sa.id AS account_id, sap.proxy_id
     FROM social_accounts sa
     JOIN social_account_proxies sap ON sap.social_account_id = sa.id AND sap.is_active = true
     WHERE sa.status = 'pending_setup'
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

async function upsertXAccount(row, proxyId) {
  const credentials = {
    password: row.password,
    email: row.email,
    email_password: row.email_password,
    totp_secret: row.totp_secret,
    auth_token: row.auth_token,
    ct0: row.ct0,
    batch_uuid: row.batch_uuid,
    source: 'manual_import',
    order: '206264',
    has_cookies: true,
  };

  const existing = await pool.query(
    `SELECT id FROM social_accounts
     WHERE platform = 'x' AND lower(username) = lower($1)
     LIMIT 1`,
    [row.username]
  );

  let accountId;
  if (existing.rows[0]) {
    accountId = existing.rows[0].id;
    await pool.query(
      `UPDATE social_accounts
       SET email = $2,
           credentials = $3::jsonb,
           status = 'active',
           is_simulated = false,
           warmup_status = CASE
             WHEN warmup_status IN ('new', 'failed') THEN 'pending'
             ELSE warmup_status
           END,
           updated_at = NOW()
       WHERE id = $1`,
      [accountId, row.email, JSON.stringify(credentials)]
    );
  } else {
    const inserted = await pool.query(
      `INSERT INTO social_accounts
         (platform, username, email, credentials, status, is_simulated, warmup_status)
       VALUES ('x', $1, $2, $3::jsonb, 'active', false, 'pending')
       RETURNING id`,
      [row.username, row.email, JSON.stringify(credentials)]
    );
    accountId = inserted.rows[0].id;
  }

  if (proxyId) {
    await pool.query(
      `UPDATE social_account_proxies SET is_active = false WHERE social_account_id = $1 AND is_active = true`,
      [accountId]
    );
    await proxyService.assignProxiesToAccount(accountId, [proxyId]);
  }

  const cookies = buildXCookies(row.auth_token, row.ct0);
  await pool.query(
    `INSERT INTO browser_sessions (account_id, platform, cookies, session_data, user_agent)
     VALUES ($1, 'x', $2::jsonb, '{}'::jsonb, NULL)
     ON CONFLICT (account_id, platform)
     DO UPDATE SET cookies = $2::jsonb, updated_at = NOW()`,
    [accountId, JSON.stringify(cookies)]
  );

  return { accountId, cookieCount: cookies.length, username: row.username };
}

async function smokeXCookieSession(accountId) {
  let browser;
  try {
    const account = await playwrightService.getAccount(accountId);
    const result = await playwrightService.createBrowserForAccount(accountId, 2, {
      requireProxy: false,
      skipProxy: true,
    });
    browser = result.browser;
    const page = result.page;

    const loggedIn = await playwrightService.ensureLoggedIn(
      page,
      'x',
      accountId,
      account.username,
      account.credentials?.password,
      { allowLogin: false }
    );

    if (loggedIn) {
      await playwrightService.persistSession(page, 'x', accountId);
      await pool.query(
        `UPDATE social_accounts
         SET warmup_status = 'warmed', warmed_up_at = NOW(), last_used_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [accountId]
      );
    }

    return { success: !!loggedIn, accountId, username: account.username, mode: 'cookie_only' };
  } catch (error) {
    return { success: false, accountId, error: error.message, mode: 'cookie_only' };
  } finally {
    if (browser) await browser.close().catch(() => {});
    playwrightService._untrackBrowser?.(accountId);
  }
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node src/scripts/import-x-accounts.js <txt> [--smoke=N]');
    process.exit(1);
  }
  const smokeArg = process.argv.find((a) => a.startsWith('--smoke'));
  const smokeN = smokeArg ? Number(smokeArg.split('=')[1] || 1) : 0;

  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(path.resolve(file), 'utf8').split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    const parsed = parseLine(line);
    if (parsed) rows.push(parsed);
  }
  if (!rows.length) {
    console.error('No accounts parsed');
    process.exit(1);
  }

  console.log(`Importing ${rows.length} X accounts from ${file}`);
  const proxyIds = await takeProxiesFromPendingShells(rows.length);
  console.log(`Reclaimed ${proxyIds.length} proxies from pending_setup shells`);
  if (proxyIds.length < rows.length) {
    console.warn(
      `PROXY GAP: need ${rows.length}, have ${proxyIds.length} → ${rows.length - proxyIds.length} accounts will have no proxy`
    );
  }

  const results = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const proxyId = proxyIds[i] || null;
    try {
      const r = await upsertXAccount(row, proxyId);
      results.push({ ...r, proxyId, ok: true });
      console.log(
        `  #${r.accountId} @${r.username} cookies=${r.cookieCount} proxy=${proxyId || 'NONE'}`
      );
    } catch (err) {
      console.error(`  FAIL ${row.username}:`, err.message);
      results.push({ username: row.username, ok: false, error: err.message });
    }
  }

  const ok = results.filter((r) => r.ok);
  const withProxy = ok.filter((r) => r.proxyId);
  const withCookies = ok.filter((r) => r.cookieCount > 0);
  const ids = ok.map((r) => r.accountId).sort((a, b) => a - b);
  console.log(
    `\nImported ${ok.length}/${rows.length} (proxied=${withProxy.length}, cookies=${withCookies.length})`
  );
  if (ids.length) {
    console.log(`ID range: ${ids[0]}..${ids[ids.length - 1]}`);
  }

  const campaign = await pool.query(`SELECT enabled FROM x_follow_settings LIMIT 1`);
  console.log(`X follow campaign enabled: ${campaign.rows[0]?.enabled === true}`);

  if (smokeN > 0) {
    const smokeIds = withCookies.map((r) => r.accountId).slice(0, smokeN);
    console.log(`\nCookie-only smoke of ${smokeIds.length} account(s) (no password login)…`);
    let pass = 0;
    for (const id of smokeIds) {
      console.log(`\n=== Account ${id} ===`);
      const r = await smokeXCookieSession(id);
      console.log(JSON.stringify(r));
      if (r.success) pass += 1;
      await new Promise((res) => setTimeout(res, 4000 + Math.floor(Math.random() * 3000)));
    }
    console.log(`\nSmoke: ${pass}/${smokeIds.length} ok`);
  } else {
    console.log('\nSmoke skipped (default). Pass --smoke=1 for cookie-only check.');
  }

  await pool.end().catch(() => {});
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
