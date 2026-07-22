#!/usr/bin/env node
/**
 * Import a batch of FRESH LinkedIn accounts and bind one dedicated proxy each.
 *
 * This step is SAFE: it only writes to the DB and assigns proxies. It does NOT
 * open a browser, log in, or touch LinkedIn in any way. First login is handled
 * separately, gently, by build-linkedin-fresh.js.
 *
 * Line format (colon-separated):
 *   email:password:totp_secret
 * (password may itself contain ':'; email is the first field, totp the last.)
 *
 * Proxies: bound 1:1 from the same pool existing LinkedIn accounts already use
 * (ProxyBase residential US) — never the X Oxylabs pool. Only fresh, unassigned,
 * healthy proxies are used; burned accounts' proxies are left alone.
 *
 * Usage (in container):
 *   node src/scripts/import-linkedin-fresh-batch.js /app/private/linkedin-accounts-2026-07-22.txt
 */
require('dotenv').config();
const fs = require('fs');
const pool = require('../services/db');
const proxyService = require('../services/proxyService');
const { assertImportCredentials } = require('../utils/credentialGate');

const PROXY_PROVIDER = process.env.LINKEDIN_PROXY_PROVIDER || 'ProxyBase';
const BATCH_TAG = process.env.LINKEDIN_IMPORT_BATCH || '2026-07-22';

function parseLine(line) {
  const raw = String(line || '').trim();
  if (!raw || raw.startsWith('#')) return null;
  const parts = raw.split(':');
  if (parts.length < 3) {
    throw new Error(`Expected email:password:totp_secret, got ${parts.length} fields`);
  }
  const email = parts[0].trim();
  const totp_secret = parts[parts.length - 1].trim();
  const password = parts.slice(1, parts.length - 1).join(':');
  if (!/@/.test(email)) throw new Error(`Invalid email: ${email}`);
  const row = { email, password, totp_secret };
  const gate = assertImportCredentials(row, { requireTotp: true, preferEmailAccess: true });
  row.totp_secret = gate.totp_secret; // normalized base32
  return row;
}

async function pickFreshProxyId(client) {
  // One healthy, unassigned proxy from the LinkedIn pool. Locked to avoid
  // two concurrent binds grabbing the same row.
  const { rows } = await client.query(
    `SELECT p.id
     FROM proxies p
     WHERE p.is_active = true
       AND lower(p.provider) = lower($1)
       AND (p.cooldown_until IS NULL OR p.cooldown_until <= NOW())
       AND COALESCE(p.consecutive_failures, 0) < 3
       AND COALESCE(p.last_health_ok, true) = true
       AND NOT EXISTS (
         SELECT 1 FROM social_account_proxies sap
         WHERE sap.proxy_id = p.id AND sap.is_active = true
       )
     ORDER BY p.failure_count ASC, p.last_used_at ASC NULLS FIRST, p.id ASC
     FOR UPDATE SKIP LOCKED
     LIMIT 1`,
    [PROXY_PROVIDER]
  );
  return rows[0] ? rows[0].id : null;
}

async function upsertAccount(row) {
  const username = row.email.split('@')[0];
  const credentials = {
    password: row.password,
    email: row.email,
    totp_secret: row.totp_secret,
    source: 'manual_import',
    import_batch: BATCH_TAG,
  };

  const existing = await pool.query(
    `SELECT id, credentials FROM social_accounts
     WHERE platform = 'linkedin' AND (email = $1 OR username = $2)
     LIMIT 1`,
    [row.email, username]
  );

  if (existing.rows[0]) {
    const id = existing.rows[0].id;
    const prev = typeof existing.rows[0].credentials === 'string'
      ? JSON.parse(existing.rows[0].credentials)
      : (existing.rows[0].credentials || {});
    // Preserve anything already learned (session/persona); refresh core creds.
    const merged = { ...prev, ...credentials };
    await pool.query(
      `UPDATE social_accounts
       SET username = $2, email = $3, credentials = $4::jsonb,
           is_simulated = false, updated_at = NOW()
       WHERE id = $1`,
      [id, username, row.email, JSON.stringify(merged)]
    );
    return { id, created: false };
  }

  const inserted = await pool.query(
    `INSERT INTO social_accounts
       (platform, username, email, credentials, status, is_simulated, warmup_status)
     VALUES ('linkedin', $1, $2, $3::jsonb, 'active', false, 'pending')
     RETURNING id`,
    [username, row.email, JSON.stringify(credentials)]
  );
  return { id: inserted.rows[0].id, created: true };
}

async function bindProxyIfMissing(accountId) {
  const has = await pool.query(
    `SELECT 1 FROM social_account_proxies
     WHERE social_account_id = $1 AND is_active = true LIMIT 1`,
    [accountId]
  );
  if (has.rows.length) return { proxyId: null, already: true };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const proxyId = await pickFreshProxyId(client);
    if (!proxyId) {
      await client.query('ROLLBACK');
      return { proxyId: null, already: false, exhausted: true };
    }
    // Reserve within the same tx so SKIP LOCKED peers won't reuse it.
    // (social_account_proxies has no unique (account,proxy) constraint, so
    // reuse an existing row for this exact pair if present, else insert.)
    const existingPair = await client.query(
      `SELECT id FROM social_account_proxies
       WHERE social_account_id = $1 AND proxy_id = $2 LIMIT 1`,
      [accountId, proxyId]
    );
    if (existingPair.rows[0]) {
      await client.query(
        `UPDATE social_account_proxies
         SET is_active = true, priority = 1, assigned_at = NOW()
         WHERE id = $1`,
        [existingPair.rows[0].id]
      );
    } else {
      await client.query(
        `INSERT INTO social_account_proxies (social_account_id, proxy_id, priority, is_active)
         VALUES ($1, $2, 1, true)`,
        [accountId, proxyId]
      );
    }
    await client.query('COMMIT');
    return { proxyId, already: false };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function main() {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.error(`File not found: ${file || '(none given)'}`);
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

  console.log(`Parsed ${rows.length} LinkedIn accounts. Importing + binding ${PROXY_PROVIDER} proxies…`);
  let created = 0;
  let updated = 0;
  let bound = 0;
  let boundAlready = 0;
  let exhausted = 0;
  const summary = [];

  for (const row of rows) {
    const { id, created: wasCreated } = await upsertAccount(row);
    if (wasCreated) created++; else updated++;

    const bind = await bindProxyIfMissing(id);
    if (bind.already) boundAlready++;
    else if (bind.proxyId) bound++;
    else if (bind.exhausted) exhausted++;

    summary.push({
      id,
      email: row.email,
      created: wasCreated,
      proxy: bind.proxyId || (bind.already ? 'existing' : 'NONE'),
    });
    console.log(`  #${id} ${row.email} ${wasCreated ? 'new' : 'upd'} proxy=${bind.proxyId || (bind.already ? 'existing' : 'NONE')}`);
  }

  console.log('\n===== IMPORT SUMMARY =====');
  console.log(JSON.stringify({
    total: rows.length,
    created,
    updated,
    proxies_bound_new: bound,
    proxies_already_bound: boundAlready,
    proxy_pool_exhausted: exhausted,
  }, null, 2));

  if (exhausted) {
    console.warn(`\nWARNING: ${exhausted} account(s) could not get a proxy (pool exhausted). They are imported but UNBOUND — do not log them in until a proxy is bound.`);
  }

  await pool.end().catch(() => {});
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
