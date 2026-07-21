#!/usr/bin/env node
/**
 * Smoke-login a list of Reddit account IDs (careful batches).
 *
 * Usage:
 *   node src/scripts/smoke-reddit-batch.js 670,671,672,673,674
 *   node src/scripts/smoke-reddit-batch.js --order=780736 --limit=5 --offset=0
 */
require('dotenv').config();
const pool = require('../services/db');
const playwrightService = require('../services/playwrightService');

async function smokeRedditSession(accountId) {
  let browser;
  try {
    const account = await playwrightService.getAccount(accountId);
    const result = await playwrightService.createBrowserForAccount(accountId, 2, {
      requireProxy: true,
    });
    browser = result.browser;
    const page = result.page;
    const password = account.credentials?.password;
    const loggedIn = await playwrightService.ensureLoggedIn(
      page,
      'reddit',
      accountId,
      account.username,
      password
    );
    if (loggedIn) {
      await pool.query(
        `UPDATE social_accounts
         SET warmup_status = 'warmed', warmed_up_at = NOW(), last_used_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [accountId]
      );
    }
    return { success: !!loggedIn, accountId, username: account.username };
  } catch (error) {
    return { success: false, accountId, error: error.message };
  } finally {
    if (browser) await browser.close().catch(() => {});
    playwrightService._untrackBrowser?.(accountId);
  }
}

async function resolveIds(argv) {
  const csv = argv.find((a) => /^\d+(,\d+)*$/.test(a));
  if (csv) return csv.split(',').map(Number);

  const orderArg = argv.find((a) => a.startsWith('--order='));
  const orderId = orderArg ? orderArg.split('=')[1] : null;
  const limitArg = argv.find((a) => a.startsWith('--limit='));
  const offsetArg = argv.find((a) => a.startsWith('--offset='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : 5;
  const offset = offsetArg ? Number(offsetArg.split('=')[1]) : 0;

  if (!orderId) throw new Error('Provide ids or --order=...');

  const result = await pool.query(
    `SELECT id FROM social_accounts
     WHERE platform = 'reddit'
       AND (credentials->>'order_id' = $1 OR credentials->>'batch' = $1)
     ORDER BY id
     OFFSET $2 LIMIT $3`,
    [orderId, offset, limit]
  );
  return result.rows.map((r) => r.id);
}

async function main() {
  const ids = await resolveIds(process.argv.slice(2));
  if (!ids.length) throw new Error('No account ids');
  console.log(`Smoke-testing ${ids.length}: ${ids.join(',')}`);

  let pass = 0;
  const results = [];
  for (const id of ids) {
    console.log(`\n=== Account ${id} ===`);
    const r = await smokeRedditSession(id);
    console.log(JSON.stringify(r));
    results.push(r);
    if (r.success) pass += 1;
    await new Promise((res) => setTimeout(res, 5000 + Math.floor(Math.random() * 4000)));
  }
  console.log(`\nSmoke: ${pass}/${ids.length} ok`);
  console.log(JSON.stringify({ pass, fail: ids.length - pass, results }, null, 2));
  await pool.end().catch(() => {});
  process.exit(pass === ids.length ? 0 : 2);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
