#!/usr/bin/env node
/**
 * Import TikTok accounts then smoke-test login.
 *
 * Line format (comma-separated):
 *   username,password,email
 *
 * Usage:
 *   node src/scripts/import-and-smoke-tiktok.js /app/private/tiktok-accounts.txt
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../services/db');
const proxyService = require('../services/proxyService');
const playwrightService = require('../services/playwrightService');

function parseLine(line) {
  const raw = String(line || '').trim();
  if (!raw || raw.startsWith('#')) return null;
  const parts = raw.split(',');
  if (parts.length < 2) {
    throw new Error(`Expected username,password[,email], got ${parts.length} fields`);
  }
  const username = parts[0].trim();
  const password = parts[1].trim();
  const email = (parts[2] || '').trim() || null;
  if (!username || !password) throw new Error(`Invalid line: ${raw.slice(0, 40)}`);
  return { username, password, email };
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

async function upsertTikTokAccount(row, proxyId) {
  const credentials = {
    password: row.password,
    email: row.email,
    source: 'manual_import',
  };

  const existing = await pool.query(
    `SELECT id FROM social_accounts WHERE platform = 'tiktok' AND username = $1`,
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
           updated_at = NOW()
       WHERE id = $1`,
      [accountId, row.email, JSON.stringify(credentials)]
    );
  } else {
    const inserted = await pool.query(
      `INSERT INTO social_accounts
         (platform, username, email, credentials, status, is_simulated, warmup_status)
       VALUES ('tiktok', $1, $2, $3::jsonb, 'active', false, 'pending')
       RETURNING id`,
      [row.username, row.email, JSON.stringify(credentials)]
    );
    accountId = inserted.rows[0].id;
  }

  if (proxyId) {
    await proxyService.assignProxiesToAccount(accountId, [proxyId]);
  }

  return accountId;
}

async function main() {
  const file = process.argv[2] || path.join(__dirname, '../../private/tiktok-accounts.txt');
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    const parsed = parseLine(line);
    if (parsed) rows.push(parsed);
  }
  if (!rows.length) {
    console.error('No accounts parsed');
    process.exit(1);
  }

  console.log(`Importing ${rows.length} TikTok accounts…`);
  const proxyIds = await takeProxiesFromPendingShells(rows.length);
  console.log(`Reclaimed ${proxyIds.length} proxies from pending_setup shells`);

  const accountIds = [];
  for (let i = 0; i < rows.length; i++) {
    const proxyId = proxyIds[i] || null;
    const id = await upsertTikTokAccount(rows[i], proxyId);
    accountIds.push(id);
    console.log(`  #${id} @${rows[i].username} email=${rows[i].email || 'n/a'} proxy=${proxyId || 'none'}`);
  }

  console.log('\nSmoke-testing TikTok logins…');
  const results = [];
  for (const accountId of accountIds) {
    console.log(`\n=== Account ${accountId} ===`);
    const result = await playwrightService.smokeTestTikTokLogin(accountId, {
      requireProxy: false,
    });
    results.push(result);
    console.log(JSON.stringify(result, null, 2));
    await new Promise((r) => setTimeout(r, 6000 + Math.floor(Math.random() * 5000)));
  }

  const ok = results.filter((r) => r.success).length;
  console.log(`\nDone: ${ok}/${results.length} TikTok logins succeeded`);
  console.table(
    results.map((r) => ({
      id: r.accountId,
      user: (r.username || '').slice(0, 24),
      ok: !!r.success,
      proxy: !!r.usedProxy,
      err: (r.error || '').slice(0, 40),
    }))
  );
  await pool.end().catch(() => {});
  process.exit(ok > 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
