#!/usr/bin/env node
/**
 * Import Bright Data dedicated ISP proxies (zone sticky session or -ip- targeting)
 * and assign to live accounts missing proxies.
 *
 * Assignment rule: one account per platform per proxy (Reddit/IG/TikTok/X may share
 * a proxy with each other, but never two of the same platform).
 *
 * Credentials via env (never commit passwords):
 *   BRIGHTDATA_ZONE_PASSWORD
 *   BRIGHTDATA_CUSTOMER_ID   (default hl_3723b9dc)
 *   BRIGHTDATA_ZONE          (default isp_proxy3)
 *   BRIGHTDATA_HOST          (default brd.superproxy.io)
 *   BRIGHTDATA_PORT          (default 33335)
 *
 * List file: JSONL lines { username, ip?, session?, kind? }
 *   or plain IPs (one per line) → builds -ip- usernames
 *
 * Usage:
 *   BRIGHTDATA_ZONE_PASSWORD=... node src/scripts/import-brightdata-isp-proxies.js /path/to/list.jsonl
 *   BRIGHTDATA_ZONE_PASSWORD=... node src/scripts/import-brightdata-isp-proxies.js /path/to/list.jsonl --auto-assign
 *   BRIGHTDATA_ZONE_PASSWORD=... node src/scripts/import-brightdata-isp-proxies.js /path/to/ips.txt --auto-assign
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../services/db');

const PROVIDER = 'BrightData';
const SHARE_PLATFORMS = new Set(['reddit', 'instagram', 'tiktok', 'x']);

function envOrThrow(key) {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env ${key}`);
  return v;
}

function buildUsernameFromIp(ip) {
  const customer = process.env.BRIGHTDATA_CUSTOMER_ID || 'hl_3723b9dc';
  const zone = process.env.BRIGHTDATA_ZONE || 'isp_proxy3';
  return `brd-customer-${customer}-zone-${zone}-ip-${ip}`;
}

function parseListFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const password = envOrThrow('BRIGHTDATA_ZONE_PASSWORD');
  const host = process.env.BRIGHTDATA_HOST || 'brd.superproxy.io';
  const port = Number(process.env.BRIGHTDATA_PORT || 33335);
  const server = `${host}:${port}`;

  return lines.map((line, idx) => {
    let row;
    if (line.startsWith('{')) {
      row = JSON.parse(line);
    } else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(line)) {
      row = { kind: 'ip', ip: line, username: buildUsernameFromIp(line) };
    } else {
      throw new Error(`Unrecognized list line ${idx + 1}: ${line.slice(0, 80)}`);
    }

    const username = row.username || (row.ip ? buildUsernameFromIp(row.ip) : null);
    if (!username) throw new Error(`Line ${idx + 1}: missing username/ip`);

    const n = row.n || idx + 1;
    const ip = row.ip || null;
    return {
      name: ip ? `BrightData ISP ${ip}` : `BrightData ISP session ${row.session || n}`,
      type: 'http',
      server,
      username,
      password,
      country: 'US',
      city: null,
      provider: PROVIDER,
      is_residential: true,
      metadata: {
        provider: PROVIDER,
        product: 'isp',
        zone: process.env.BRIGHTDATA_ZONE || 'isp_proxy3',
        kind: row.kind || (ip ? 'ip' : 'session'),
        ip,
        session: row.session || null,
        host,
        port,
      },
    };
  });
}

async function upsertProxy(config) {
  const existing = await pool.query(
    `SELECT id FROM proxies
     WHERE provider = $1 AND username = $2 AND server = $3
     LIMIT 1`,
    [PROVIDER, config.username, config.server]
  );

  if (existing.rows[0]) {
    const upd = await pool.query(
      `UPDATE proxies SET
         name = $1,
         type = $2,
         password = $3,
         country = $4,
         is_residential = $5,
         metadata = $6::jsonb,
         is_active = true,
         updated_at = NOW()
       WHERE id = $7
       RETURNING *`,
      [
        config.name,
        config.type,
        config.password,
        config.country,
        config.is_residential,
        JSON.stringify(config.metadata || {}),
        existing.rows[0].id,
      ]
    );
    return { proxy: upd.rows[0], updated: true };
  }

  const ins = await pool.query(
    `INSERT INTO proxies
       (name, type, server, username, password, country, city, provider, is_residential, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
     RETURNING *`,
    [
      config.name,
      config.type,
      config.server,
      config.username,
      config.password,
      config.country,
      config.city,
      config.provider,
      config.is_residential,
      JSON.stringify(config.metadata || {}),
    ]
  );
  return { proxy: ins.rows[0], updated: false };
}

/**
 * Assign proxy allowing cross-platform share, but never two accounts of the same platform.
 */
async function assignSharedAcrossPlatforms(accountId, platform, proxyId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const conflict = await client.query(
      `SELECT sa.id, sa.username
       FROM social_account_proxies sap
       JOIN social_accounts sa ON sa.id = sap.social_account_id
       WHERE sap.proxy_id = $1
         AND sap.is_active = true
         AND sa.platform = $2
         AND sa.id <> $3
       LIMIT 1`,
      [proxyId, platform, accountId]
    );
    if (conflict.rows[0]) {
      await client.query('ROLLBACK');
      return { ok: false, reason: `same-platform conflict with ${conflict.rows[0].username}` };
    }

    await client.query(
      `UPDATE social_account_proxies SET is_active = false WHERE social_account_id = $1`,
      [accountId]
    );

    const existing = await client.query(
      `SELECT id FROM social_account_proxies
       WHERE social_account_id = $1 AND proxy_id = $2 LIMIT 1`,
      [accountId, proxyId]
    );

    if (existing.rows[0]) {
      await client.query(
        `UPDATE social_account_proxies
         SET priority = 1, is_active = true, assigned_at = NOW()
         WHERE id = $1`,
        [existing.rows[0].id]
      );
    } else {
      await client.query(
        `INSERT INTO social_account_proxies (social_account_id, proxy_id, priority, is_active)
         VALUES ($1, $2, 1, true)`,
        [accountId, proxyId]
      );
    }

    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function autoAssignGaps() {
  const accounts = await pool.query(
    `SELECT sa.id, sa.username, sa.platform
     FROM social_accounts sa
     WHERE COALESCE(sa.is_simulated, false) = false
       AND sa.status = 'active'
       AND sa.platform = ANY($1::text[])
       AND NOT EXISTS (
         SELECT 1 FROM social_account_proxies sap
         JOIN proxies p ON p.id = sap.proxy_id
         WHERE sap.social_account_id = sa.id
           AND sap.is_active = true
           AND p.is_active = true
       )
     ORDER BY
       CASE sa.platform
         WHEN 'x' THEN 0
         WHEN 'reddit' THEN 1
         WHEN 'instagram' THEN 2
         WHEN 'tiktok' THEN 3
         ELSE 9
       END,
       sa.id`,
    [[...SHARE_PLATFORMS]]
  );

  const proxies = await pool.query(
    `SELECT p.id, p.name, p.metadata
     FROM proxies p
     WHERE p.is_active = true AND p.provider = $1
     ORDER BY p.id`,
    [PROVIDER]
  );

  const platformOnProxy = new Map(); // proxyId -> Set(platform)
  const existing = await pool.query(
    `SELECT sap.proxy_id, sa.platform
     FROM social_account_proxies sap
     JOIN social_accounts sa ON sa.id = sap.social_account_id
     JOIN proxies p ON p.id = sap.proxy_id
     WHERE sap.is_active = true AND p.provider = $1 AND p.is_active = true`,
    [PROVIDER]
  );
  for (const row of existing.rows) {
    if (!platformOnProxy.has(row.proxy_id)) platformOnProxy.set(row.proxy_id, new Set());
    platformOnProxy.get(row.proxy_id).add(row.platform);
  }

  const summary = { assigned: 0, skipped: 0, byPlatform: {} };
  let proxyIdx = 0;

  for (const account of accounts.rows) {
    summary.byPlatform[account.platform] = summary.byPlatform[account.platform] || {
      assigned: 0,
      skipped: 0,
    };

    let chosen = null;
    for (let i = 0; i < proxies.rows.length; i++) {
      const idx = (proxyIdx + i) % proxies.rows.length;
      const proxy = proxies.rows[idx];
      const used = platformOnProxy.get(proxy.id) || new Set();
      if (!used.has(account.platform)) {
        chosen = proxy;
        proxyIdx = idx + 1;
        break;
      }
    }

    if (!chosen) {
      summary.skipped++;
      summary.byPlatform[account.platform].skipped++;
      console.warn(`No free BrightData slot for ${account.platform}:${account.username}`);
      continue;
    }

    const result = await assignSharedAcrossPlatforms(account.id, account.platform, chosen.id);
    if (!result.ok) {
      summary.skipped++;
      summary.byPlatform[account.platform].skipped++;
      console.warn(`Skip ${account.platform}:${account.username}: ${result.reason}`);
      continue;
    }

    if (!platformOnProxy.has(chosen.id)) platformOnProxy.set(chosen.id, new Set());
    platformOnProxy.get(chosen.id).add(account.platform);

    summary.assigned++;
    summary.byPlatform[account.platform].assigned++;
    console.log(`Assigned ${chosen.name} → ${account.platform}:${account.username}`);
  }

  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  const listPath = args.find((a) => !a.startsWith('--'));
  const autoAssign = args.includes('--auto-assign');

  if (!listPath) {
    console.error(
      'Usage: BRIGHTDATA_ZONE_PASSWORD=... node src/scripts/import-brightdata-isp-proxies.js <list> [--auto-assign]'
    );
    process.exit(1);
  }

  const abs = path.resolve(listPath);
  if (!fs.existsSync(abs)) {
    console.error(`File not found: ${abs}`);
    process.exit(1);
  }

  const configs = parseListFile(abs);
  console.log(`Parsed ${configs.length} BrightData ISP proxies from ${abs}`);

  let created = 0;
  let updated = 0;
  for (const config of configs) {
    const { proxy, updated: wasUpdate } = await upsertProxy(config);
    if (wasUpdate) updated++;
    else created++;
    console.log(`${wasUpdate ? 'Updated' : 'Created'} ${proxy.name} (id=${proxy.id})`);
  }
  console.log(`Import done: created=${created} updated=${updated}`);

  if (autoAssign) {
    const summary = await autoAssignGaps();
    console.log('Assignment summary:', JSON.stringify(summary, null, 2));
  }

  const stats = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE is_active AND provider = $1) AS brightdata_active,
       (SELECT COUNT(*) FROM social_account_proxies sap
          JOIN proxies p ON p.id = sap.proxy_id
         WHERE sap.is_active AND p.provider = $1) AS brightdata_assignments
     FROM proxies`,
    [PROVIDER]
  );
  console.log('Stats:', stats.rows[0]);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
