#!/usr/bin/env node
/**
 * Smoke-test X engagement: login → follow → comment.
 *
 * Usage (inside backend container):
 *   node src/scripts/smoke-x-engagement.js [accountId ...] [--target=NASA]
 */
require('dotenv').config();
const pool = require('../services/db');
const playwrightService = require('../services/playwrightService');

async function main() {
  const args = process.argv.slice(2);
  const targetArg = args.find((a) => a.startsWith('--target='));
  const targetUsername = targetArg ? targetArg.split('=')[1] : 'NASA';
  const ids = args.filter((a) => /^\d+$/.test(a)).map(Number);

  let accountIds = ids;
  if (!accountIds.length) {
    const result = await pool.query(
      `SELECT id FROM social_accounts
       WHERE platform = 'x' AND status = 'active'
         AND COALESCE(credentials->>'password', '') NOT IN ('', 'default_password')
       ORDER BY id
       LIMIT 2`
    );
    accountIds = result.rows.map((r) => r.id);
  }

  if (!accountIds.length) {
    console.error('No X accounts found');
    process.exit(1);
  }

  console.log(`X smoke test → @${targetUsername} for accounts: ${accountIds.join(', ')}`);
  const results = [];

  for (const accountId of accountIds) {
    console.log(`\n=== Account ${accountId} ===`);
    const result = await playwrightService.smokeTestXEngagement(accountId, {
      targetUsername,
      requireProxy: true,
    });
    results.push(result);
    console.log(JSON.stringify(result, null, 2));
    // Pause between accounts so we don't look like a bot farm burst
    await new Promise((r) => setTimeout(r, 8000 + Math.floor(Math.random() * 7000)));
  }

  const ok = results.filter((r) => r.success).length;
  console.log(`\nDone: ${ok}/${results.length} succeeded`);
  await pool.end().catch(() => {});
  process.exit(ok === results.length ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
