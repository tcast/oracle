#!/usr/bin/env node
/**
 * Import ProxyBase sticky proxy URLs and optionally assign one per live account.
 *
 * Usage:
 *   node src/scripts/import-proxybase-proxies.js /path/to/list.txt
 *   node src/scripts/import-proxybase-proxies.js /path/to/list.txt --auto-assign
 *   node src/scripts/import-proxybase-proxies.js /path/to/list.txt --auto-assign --replace
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const proxyService = require('../services/proxyService');
const { parseProxyList } = require('../services/proxybaseProxyFormatter');
const pool = require('../services/db');

async function deactivateOtherProviders(keepProvider = 'ProxyBase') {
  const { rowCount } = await pool.query(
    `UPDATE proxies
     SET is_active = false, updated_at = NOW()
     WHERE COALESCE(provider, '') <> $1 AND is_active = true`,
    [keepProvider]
  );
  return rowCount;
}

async function importProxies(proxyConfigs) {
  const results = [];
  for (const config of proxyConfigs) {
    try {
      const existing = await pool.query(
        `SELECT id FROM proxies
         WHERE provider = 'ProxyBase'
           AND username = $1
           AND server = $2
         LIMIT 1`,
        [config.username, config.server]
      );

      let proxy;
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
            config.country || null,
            config.is_residential,
            JSON.stringify(config.metadata || {}),
            existing.rows[0].id,
          ]
        );
        proxy = upd.rows[0];
        results.push({ success: true, updated: true, proxy });
      } else {
        proxy = await proxyService.createProxy(config);
        results.push({ success: true, updated: false, proxy });
      }
    } catch (err) {
      results.push({ success: false, error: err.message, data: config });
    }
  }
  return results;
}

async function autoAssignOnePerAccount({ replace = false } = {}) {
  const accounts = await pool.query(
    `SELECT id, username, platform
     FROM social_accounts
     WHERE COALESCE(is_simulated, false) = false
     ORDER BY id ASC`
  );

  const proxies = await pool.query(
    `SELECT id, name, metadata
     FROM proxies
     WHERE is_active = true AND provider = 'ProxyBase'
     ORDER BY id ASC`
  );

  const accountRows = accounts.rows;
  const proxyRows = proxies.rows;

  if (!proxyRows.length) {
    throw new Error('No active ProxyBase proxies to assign');
  }

  console.log(`Accounts needing proxies: ${accountRows.length}`);
  console.log(`ProxyBase proxies available: ${proxyRows.length}`);

  let assigned = 0;
  let skipped = 0;

  for (let i = 0; i < accountRows.length; i++) {
    const account = accountRows[i];
    const proxy = proxyRows[i];
    if (!proxy) {
      console.warn(`No spare proxy for account ${account.id} (${account.username})`);
      skipped++;
      continue;
    }

    if (!replace) {
      const existing = await pool.query(
        `SELECT 1 FROM social_account_proxies
         WHERE social_account_id = $1 AND is_active = true
         LIMIT 1`,
        [account.id]
      );
      if (existing.rows.length) {
        skipped++;
        continue;
      }
    }

    await proxyService.assignProxiesToAccount(account.id, [proxy.id]);
    assigned++;
    console.log(`Assigned ${proxy.name} → ${account.platform}:${account.username}`);
  }

  return { assigned, skipped, spare: Math.max(proxyRows.length - accountRows.length, 0) };
}

async function main() {
  const args = process.argv.slice(2);
  const listPath = args.find((a) => !a.startsWith('--'));
  const autoAssign = args.includes('--auto-assign');
  const replace = args.includes('--replace');
  const deactivateOthers = args.includes('--deactivate-others');

  if (!listPath) {
    console.error('Usage: node src/scripts/import-proxybase-proxies.js <list.txt> [--auto-assign] [--replace] [--deactivate-others]');
    process.exit(1);
  }

  const abs = path.resolve(listPath);
  if (!fs.existsSync(abs)) {
    console.error(`File not found: ${abs}`);
    process.exit(1);
  }

  const configs = parseProxyList(fs.readFileSync(abs, 'utf8'));
  console.log(`Parsed ${configs.length} ProxyBase proxies from ${abs}`);

  if (deactivateOthers) {
    const n = await deactivateOtherProviders('ProxyBase');
    console.log(`Deactivated ${n} non-ProxyBase proxies`);
  }

  const results = await importProxies(configs);
  const ok = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);
  console.log(`Imported/updated: ${ok.length}; failed: ${failed.length}`);
  failed.forEach((f) => console.error(`  - ${f.data?.name}: ${f.error}`));

  if (autoAssign) {
    const summary = await autoAssignOnePerAccount({ replace });
    console.log(`Assignment complete: ${summary.assigned} assigned, ${summary.skipped} skipped, ${summary.spare} spare proxies`);
  }

  const stats = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE is_active) AS active_proxies,
       COUNT(*) FILTER (WHERE is_active AND provider = 'ProxyBase') AS proxybase,
       (SELECT COUNT(*) FROM social_account_proxies WHERE is_active) AS active_assignments
     FROM proxies`
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
