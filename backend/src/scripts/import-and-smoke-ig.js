#!/usr/bin/env node
/**
 * Import Instagram accounts then smoke-test login (username + email + TOTP).
 *
 * Line format:
 *   username:password:totp_secret:email:email_password
 *
 * Usage (in container):
 *   node src/scripts/import-and-smoke-ig.js /app/private/ig-accounts.txt
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
  const parts = raw.split(':');
  if (parts.length < 5) {
    throw new Error(`Expected username:password:totp:email:email_password, got ${parts.length} fields`);
  }
  // email may contain no colons; password fields shouldn't either in this dump
  const [username, password, totp_secret, email, ...rest] = parts;
  const email_password = rest.join(':');
  return { username, password, totp_secret, email, email_password };
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
    proxyIds.push(row.proxy_id);
  }
  return proxyIds;
}

async function upsertIgAccount(row, proxyId) {
  const credentials = {
    password: row.password,
    email: row.email,
    email_password: row.email_password,
    totp_secret: row.totp_secret,
    source: 'manual_import',
  };

  const existing = await pool.query(
    `SELECT id FROM social_accounts WHERE platform = 'instagram' AND username = $1`,
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
       VALUES ('instagram', $1, $2, $3::jsonb, 'active', false, 'pending')
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
  const file = process.argv[2] || '/app/private/ig-accounts.txt';
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

  console.log(`Importing ${rows.length} Instagram accounts…`);
  const proxyIds = await takeProxiesFromPendingShells(rows.length);
  console.log(`Reclaimed ${proxyIds.length} proxies from pending_setup shells`);

  const accountIds = [];
  for (let i = 0; i < rows.length; i++) {
    const proxyId = proxyIds[i] || null;
    const id = await upsertIgAccount(rows[i], proxyId);
    accountIds.push(id);
    console.log(`  #${id} @${rows[i].username} email=${rows[i].email} proxy=${proxyId || 'none'}`);
  }

  console.log('\nSmoke-testing Instagram logins…');
  const results = [];
  for (const accountId of accountIds) {
    console.log(`\n=== Account ${accountId} ===`);
    const result = await playwrightService.smokeTestInstagramLogin(accountId, {
      requireProxy: false, // allow login even if proxy pool is tight
    });
    results.push(result);
    console.log(JSON.stringify(result, null, 2));
    await new Promise((r) => setTimeout(r, 5000 + Math.floor(Math.random() * 5000)));
  }

  const ok = results.filter((r) => r.success).length;
  console.log(`\nDone: ${ok}/${results.length} IG logins succeeded`);
  await pool.end().catch(() => {});
  process.exit(ok > 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
