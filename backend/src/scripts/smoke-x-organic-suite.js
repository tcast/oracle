#!/usr/bin/env node
/**
 * Smoke the complete X organic suite (cookie-only):
 *   1) search → comment
 *   2) accept follow requests (or empty-state screenshot)
 *   3) people search → follow one
 *
 * Usage:
 *   node src/scripts/smoke-x-organic-suite.js [accountId]
 *   ACCOUNT_ID=614 node src/scripts/smoke-x-organic-suite.js
 */
require('dotenv').config();
const pool = require('../services/db');
const playwrightService = require('../services/playwrightService');
const xFollowService = require('../services/xFollowService');

async function pickAccount(preferredId) {
  if (preferredId) {
    const r = await pool.query(
      `SELECT sa.* FROM social_accounts sa
       WHERE sa.id = $1 AND lower(sa.platform) IN ('x','twitter') AND sa.status = 'active'`,
      [preferredId]
    );
    if (!r.rows[0]) throw new Error(`Account ${preferredId} not found / not active X`);
    return r.rows[0];
  }
  const r = await pool.query(
    `SELECT sa.*
     FROM social_accounts sa
     JOIN browser_sessions bs ON bs.account_id = sa.id AND bs.platform = 'x'
     WHERE lower(sa.platform) IN ('x','twitter')
       AND sa.status = 'active'
       AND COALESCE(sa.is_simulated, false) = false
       AND bs.cookies IS NOT NULL
       AND jsonb_array_length(bs.cookies) > 0
       AND bs.updated_at > NOW() - INTERVAL '72 hours'
       AND EXISTS (
         SELECT 1 FROM social_account_proxies sap
         JOIN proxies p ON p.id = sap.proxy_id
         WHERE sap.social_account_id = sa.id AND sap.is_active AND p.is_active
       )
     ORDER BY bs.updated_at DESC
     LIMIT 1`
  );
  if (!r.rows[0]) throw new Error('No X account with fresh cookies + proxy');
  return r.rows[0];
}

async function main() {
  const preferred = Number(process.argv[2] || process.env.ACCOUNT_ID || 0) || null;
  const account = await pickAccount(preferred);
  console.log(`Smoke account #${account.id} @${account.username}`);

  const results = {};

  console.log('\n=== 1) search → comment ===');
  results.search_comment = await playwrightService.smokeTestXSearchComment(account.id, {
    query: 'NBA',
    requireProxy: true,
  });
  console.log(JSON.stringify(results.search_comment, null, 2));

  console.log('\n=== 2) accept follow requests ===');
  try {
    results.accept_follows = await xFollowService.acceptFollowsForAccount(account, {
      maxAccept: 3,
      dailyCap: 10,
    });
  } catch (err) {
    results.accept_follows = { success: false, error: err.message };
  }
  console.log(JSON.stringify(results.accept_follows, null, 2));

  console.log('\n=== 3) people search → follow ===');
  results.search_follow = await playwrightService.smokeTestXSearchFollow(account.id, {
    query: 'fantasy football',
    requireProxy: true,
  });
  console.log(JSON.stringify(results.search_follow, null, 2));

  console.log('\n=== 4) discover targets (bonus) ===');
  try {
    results.discover = await xFollowService.discoverTargetsForAccount(account, { limit: 8 });
  } catch (err) {
    results.discover = { success: false, error: err.message };
  }
  console.log(JSON.stringify(results.discover, null, 2));

  const ok =
    results.search_comment?.success &&
    (results.accept_follows?.success || results.accept_follows?.empty) &&
    results.search_follow?.success;

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({
    accountId: account.id,
    username: account.username,
    ok: !!ok,
    search_comment: !!results.search_comment?.success,
    accept_follows: results.accept_follows?.accepted ?? results.accept_follows?.error,
    empty_requests: !!results.accept_follows?.empty,
    search_follow: results.search_follow?.handle || results.search_follow?.error,
    discover_inserted: results.discover?.inserted,
  }, null, 2));

  await pool.end().catch(() => {});
  process.exit(ok ? 0 : 1);
}

main().catch(async (err) => {
  console.error('FATAL', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
