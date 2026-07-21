#!/usr/bin/env node
/**
 * Import Oxylabs residential/mobile proxies as per-account sticky sessions.
 *
 * Oxylabs gateway: pr.oxylabs.io:7777 (HTTP). Real US carrier/home ASNs
 * (AT&T, T-Mobile, Verizon, Frontier). Sticky IP is held per session via
 * username params: customer-<user>-cc-US-sessid-<id>-sesstime-<minutes>.
 *
 * One proxy row per account => each account keeps a stable carrier IP
 * (platforms distrust session IP hopping).
 *
 * Credentials via env (never commit):
 *   OXYLABS_USERNAME   e.g. customer-whisper_1gCLR   (or bare whisper_1gCLR)
 *   OXYLABS_PASSWORD
 *   OXYLABS_HOST       default pr.oxylabs.io
 *   OXYLABS_PORT       default 7777
 *   OXYLABS_COUNTRY    default US
 *   OXYLABS_SESSTIME   default 30 (minutes the sticky IP is held)
 *
 * Usage:
 *   OXYLABS_USERNAME=... OXYLABS_PASSWORD=... \
 *     node src/scripts/import-oxylabs-proxies.js --accounts 588,589,590 [--platform x] [--replace]
 *   ... --accounts-platform x   (bind one sticky session to every active X account)
 */
require('dotenv').config();
const pool = require('../services/db');
const proxyService = require('../services/proxyService');

const PROVIDER = 'Oxylabs';

function arg(name, def = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return def;
  const v = process.argv[idx + 1];
  return v && !v.startsWith('--') ? v : true;
}

function buildUsername(base, country, sessid, sesstime) {
  const b = base.startsWith('customer-') ? base : `customer-${base}`;
  return `${b}-cc-${country}-sessid-${sessid}-sesstime-${sesstime}`;
}

async function resolveAccountIds() {
  const explicit = arg('--accounts');
  if (typeof explicit === 'string') {
    return explicit.split(',').map((s) => Number(s.trim())).filter(Boolean);
  }
  const plat = arg('--accounts-platform') || arg('--platform');
  if (typeof plat === 'string') {
    const { rows } = await pool.query(
      `SELECT id FROM social_accounts
       WHERE platform = $1 AND COALESCE(is_simulated,false) = false
       ORDER BY id ASC`,
      [plat]
    );
    return rows.map((r) => r.id);
  }
  throw new Error('Provide --accounts <ids> or --accounts-platform <platform>');
}

async function main() {
  const username = process.env.OXYLABS_USERNAME;
  const password = process.env.OXYLABS_PASSWORD;
  if (!username || !password) throw new Error('Missing OXYLABS_USERNAME / OXYLABS_PASSWORD');

  const host = process.env.OXYLABS_HOST || 'pr.oxylabs.io';
  const port = Number(process.env.OXYLABS_PORT || 7777);
  const country = process.env.OXYLABS_COUNTRY || 'US';
  const sesstime = Number(process.env.OXYLABS_SESSTIME || 30);
  const server = `${host}:${port}`;
  const replace = process.argv.includes('--replace');

  const accountIds = await resolveAccountIds();
  console.log(`Binding ${accountIds.length} account(s) to Oxylabs sticky sessions @ ${server} (cc=${country}, sesstime=${sesstime}m)`);

  let created = 0;
  let updated = 0;
  let assigned = 0;

  for (const accountId of accountIds) {
    const acct = await pool.query(
      `SELECT id, username, platform FROM social_accounts WHERE id = $1`,
      [accountId]
    );
    if (!acct.rows[0]) {
      console.warn(`  account ${accountId} not found, skipping`);
      continue;
    }
    const { username: acctName, platform } = acct.rows[0];

    // Stable sessid keyed to account so the same IP returns across restarts.
    const sessid = `acct${accountId}`;
    const proxyUsername = buildUsername(username, country, sessid, sesstime);
    const name = `Oxylabs ${country} sticky ${sessid}`;

    const existing = await pool.query(
      `SELECT id FROM proxies WHERE provider = $1 AND username = $2 AND server = $3 LIMIT 1`,
      [PROVIDER, proxyUsername, server]
    );

    let proxyId;
    const metadata = {
      provider: PROVIDER,
      product: 'residential',
      sticky: true,
      sessid,
      sesstime_min: sesstime,
      country,
      host,
      port,
      bound_account_id: accountId,
      bound_platform: platform,
    };

    if (existing.rows[0]) {
      proxyId = existing.rows[0].id;
      await pool.query(
        `UPDATE proxies SET name=$1, type='http', password=$2, country=$3,
           is_residential=true, metadata=$4::jsonb, is_active=true,
           cooldown_until=NULL, consecutive_failures=0, last_health_ok=NULL,
           updated_at=NOW()
         WHERE id=$5`,
        [name, password, country, JSON.stringify(metadata), proxyId]
      );
      updated++;
    } else {
      const proxy = await proxyService.createProxy({
        name,
        type: 'http',
        server,
        username: proxyUsername,
        password,
        country,
        city: null,
        provider: PROVIDER,
        is_residential: true,
        metadata,
      });
      proxyId = proxy.id;
      created++;
    }

    // Bind to account (deactivate its other proxies if replace).
    if (replace) {
      await pool.query(
        `UPDATE social_account_proxies SET is_active=false WHERE social_account_id=$1`,
        [accountId]
      );
    }
    await proxyService.assignProxiesToAccount(accountId, [proxyId]);
    assigned++;
    console.log(`  ${platform}:${acctName} (#${accountId}) -> proxy #${proxyId} ${name}`);
  }

  console.log(`Done. created=${created} updated=${updated} assigned=${assigned}`);

  const stats = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE is_active AND provider=$1) AS oxylabs_active FROM proxies`,
    [PROVIDER]
  );
  console.log('Oxylabs active proxies:', stats.rows[0].oxylabs_active);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(async () => { await pool.end().catch(() => {}); });
