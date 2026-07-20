#!/usr/bin/env node
/**
 * Import LinkedIn accounts then smoke-test login (email + TOTP).
 *
 * Line format:
 *   email:linkedin_password:email_password:totp_secret:profile_url
 *
 * Usage (in container):
 *   node src/scripts/import-and-smoke-linkedin.js /app/private/linkedin-accounts.txt
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
  const parts = raw.split(':');
  if (parts.length < 5) {
    throw new Error(`Expected email:pass:email_pass:totp:profile_url, got ${parts.length} fields`);
  }
  const email = parts[0];
  const password = parts[1];
  const email_password = parts[2];
  const totp_secret = parts[3];
  const profile_url = parts.slice(4).join(':');
  if (!/@/.test(email)) throw new Error(`Invalid email: ${email}`);
  if (!/linkedin\.com/i.test(profile_url)) throw new Error(`Invalid profile URL: ${profile_url}`);
  const row = { email, password, email_password, totp_secret, profile_url };
  assertImportCredentials(row, { requireTotp: true, preferEmailAccess: true });
  return row;
}

function slugFromProfile(url) {
  const m = String(url).match(/linkedin\.com\/in\/([^\/?#]+)/i);
  return m ? m[1] : null;
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
    // Remove empty shell so mapping stays clean
    await pool.query(`DELETE FROM social_account_proxies WHERE social_account_id = $1`, [row.account_id]);
    await pool.query(
      `DELETE FROM social_accounts WHERE id = $1 AND status = 'pending_setup'`,
      [row.account_id]
    );
    proxyIds.push(row.proxy_id);
  }
  return proxyIds;
}

async function upsertLinkedInAccount(row, proxyId) {
  const slug = slugFromProfile(row.profile_url);
  const username = slug || row.email.split('@')[0];
  const credentials = {
    password: row.password,
    email: row.email,
    email_password: row.email_password,
    totp_secret: row.totp_secret,
    profile_url: row.profile_url,
    source: 'manual_import',
  };

  const existing = await pool.query(
    `SELECT id FROM social_accounts
     WHERE platform = 'linkedin'
       AND (username = $1 OR email = $2 OR credentials->>'profile_url' = $3)
     LIMIT 1`,
    [username, row.email, row.profile_url]
  );

  let accountId;
  if (existing.rows[0]) {
    accountId = existing.rows[0].id;
    await pool.query(
      `UPDATE social_accounts
       SET username = $2,
           email = $3,
           credentials = $4::jsonb,
           status = 'active',
           is_simulated = false,
           updated_at = NOW()
       WHERE id = $1`,
      [accountId, username, row.email, JSON.stringify(credentials)]
    );
  } else {
    const inserted = await pool.query(
      `INSERT INTO social_accounts
         (platform, username, email, credentials, status, is_simulated, warmup_status)
       VALUES ('linkedin', $1, $2, $3::jsonb, 'active', false, 'pending')
       RETURNING id`,
      [username, row.email, JSON.stringify(credentials)]
    );
    accountId = inserted.rows[0].id;
  }

  if (proxyId) {
    await proxyService.assignProxiesToAccount(accountId, [proxyId]);
  }

  return accountId;
}

async function main() {
  const file = process.argv[2] || path.join(__dirname, '../../private/linkedin-accounts.txt');
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

  console.log(`Importing ${rows.length} LinkedIn accounts…`);
  const proxyIds = await takeProxiesFromPendingShells(rows.length);
  console.log(`Reclaimed ${proxyIds.length} proxies from pending_setup shells`);

  const accountIds = [];
  for (let i = 0; i < rows.length; i++) {
    const proxyId = proxyIds[i] || null;
    const id = await upsertLinkedInAccount(rows[i], proxyId);
    accountIds.push(id);
    console.log(
      `  #${id} ${rows[i].email} profile=${rows[i].profile_url} proxy=${proxyId || 'none'}`
    );
  }

  console.log('\nSmoke-testing LinkedIn logins…');
  const results = [];
  for (const accountId of accountIds) {
    console.log(`\n=== Account ${accountId} ===`);
    const result = await playwrightService.smokeTestLinkedInLogin(accountId, {
      requireProxy: false,
    });
    results.push(result);
    console.log(JSON.stringify(result, null, 2));
    await new Promise((r) => setTimeout(r, 6000 + Math.floor(Math.random() * 6000)));
  }

  const ok = results.filter((r) => r.success).length;
  console.log(`\nDone: ${ok}/${results.length} LinkedIn logins succeeded`);
  console.table(
    results.map((r) => ({
      id: r.accountId,
      email: r.email || '',
      success: !!r.success,
      proxy: !!r.usedProxy,
      error: r.error || '',
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
