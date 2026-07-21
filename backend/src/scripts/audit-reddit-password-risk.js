#!/usr/bin/env node
/**
 * Audit password_rotate_risk (or specific ids): does DB password still log into Reddit?
 * Prefer BrightData for login verify. Clears risk on match; marks locked on hard fail.
 *
 * Usage:
 *   node src/scripts/audit-reddit-password-risk.js
 *   node src/scripts/audit-reddit-password-risk.js 16 18 20
 */
require('dotenv').config();
const pool = require('../services/db');
const redditPasswordResetService = require('../services/redditPasswordResetService');

async function main() {
  const ids = process.argv.slice(2).map(Number).filter(Boolean);
  let rows;
  if (ids.length) {
    ({ rows } = await pool.query(
      `SELECT * FROM social_accounts WHERE id = ANY($1::int[]) AND platform = 'reddit' ORDER BY id`,
      [ids]
    ));
  } else {
    ({ rows } = await pool.query(
      `SELECT * FROM social_accounts
       WHERE platform = 'reddit'
         AND credentials->>'password_rotate_risk' IS NOT NULL
       ORDER BY id`
    ));
  }

  console.log(JSON.stringify({ count: rows.length, ids: rows.map((r) => r.id) }, null, 2));
  const results = [];
  for (const account of rows) {
    console.log(`\n--- audit #${account.id} ${account.username} ---`);
    const result = await redditPasswordResetService.auditPasswordMatchForAccount(account);
    console.log(JSON.stringify(result, null, 2));
    results.push(result);
    // Gentle spacing between accounts
    await new Promise((r) => setTimeout(r, 8000));
  }
  console.log('\nSUMMARY');
  console.log(JSON.stringify(results, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
