#!/usr/bin/env node
/**
 * Refresh credentials.x_persona.desired_username with human-style handles
 * (First_last## / nickname_## / topic_word / leading-trailing _).
 *
 * Usage:
 *   node src/scripts/refresh-x-desired-handles.js --pending
 *   node src/scripts/refresh-x-desired-handles.js --accounts 603,620
 *   node src/scripts/refresh-x-desired-handles.js --pending --dry-run
 */
require('dotenv').config();
const pool = require('../services/db');
const {
  allocateDesiredUsername,
  looksFakeUsername,
  needsHumanHandle,
} = require('../services/xPersonas');

function arg(name, def = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return def;
  const v = process.argv[idx + 1];
  return v && !v.startsWith('--') ? v : true;
}

function parseJson(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function isStaleDesired(desired) {
  if (!desired) return true;
  const d = String(desired);
  // Prefer variety with _ / style — plain firstlast## is OK-ish but refresh
  if (!d.includes('_') && /^[a-z]+\d+$/i.test(d)) return true;
  if (looksFakeUsername(d)) return true;
  return false;
}

async function resolveIds() {
  if (process.argv.includes('--pending')) {
    const { rows } = await pool.query(
      `SELECT id, username, credentials
       FROM social_accounts
       WHERE platform = 'x'
         AND status = 'active'
         AND COALESCE(warmup_status, 'new') = 'warmed'
       ORDER BY id ASC`
    );
    return rows
      .filter((r) => {
        const xp = parseJson(r.credentials, {}).x_persona || {};
        const desired = xp.desired_username || xp.username;
        return needsHumanHandle(r.username, xp) || isStaleDesired(desired);
      })
      .map((r) => r.id);
  }
  const accounts = arg('--accounts');
  if (typeof accounts === 'string') {
    return accounts
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  }
  throw new Error('Provide --pending or --accounts <ids>');
}

async function refreshOne(accountId, { dryRun }) {
  const { rows } = await pool.query(
    `SELECT id, username, credentials FROM social_accounts WHERE id = $1 AND platform = 'x'`,
    [accountId]
  );
  if (!rows.length) return { accountId, success: false, error: 'not found' };
  const row = rows[0];
  const creds = parseJson(row.credentials, {});
  const xp = creds.x_persona && typeof creds.x_persona === 'object' ? { ...creds.x_persona } : {};
  const prev = xp.desired_username || xp.username || null;
  const desired = await allocateDesiredUsername(pool, accountId);
  if (dryRun) {
    return {
      accountId,
      success: true,
      dryRun: true,
      live: row.username,
      prev,
      desired,
    };
  }
  const nextPersona = {
    ...xp,
    username: desired,
    desired_username: desired,
    rename_handle: true,
    username_applied: false,
    updated_at: new Date().toISOString(),
  };
  delete nextPersona.rename_needs_password;
  delete nextPersona.rename_skipped_at;
  await pool.query(
    `UPDATE social_accounts
     SET credentials = jsonb_set(COALESCE(credentials, '{}'::jsonb), '{x_persona}', $2::jsonb),
         updated_at = NOW()
     WHERE id = $1`,
    [accountId, JSON.stringify(nextPersona)]
  );
  return {
    accountId,
    success: true,
    live: row.username,
    prev,
    desired,
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const ids = await resolveIds();
  console.log(
    `${dryRun ? 'DRY RUN — ' : ''}Refreshing desired handles for ${ids.length} account(s)\n`
  );
  const samples = [];
  for (const id of ids) {
    const r = await refreshOne(id, { dryRun });
    if (r.success) {
      console.log(`#${id} @${r.live}  ${r.prev || '(none)'} → ${r.desired}`);
      samples.push(r.desired);
    } else {
      console.log(`#${id} FAIL: ${r.error}`);
    }
  }
  console.log('\nSample new handles:', samples.slice(0, 12).join(', '));
  await pool.end().catch(() => {});
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
