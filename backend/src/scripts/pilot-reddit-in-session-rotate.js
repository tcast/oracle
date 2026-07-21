#!/usr/bin/env node
/**
 * Pilot logged-in Reddit password change (old.reddit prefs) — no forgot-email.
 *
 * Usage (isolated container recommended — Chromium OOMs the API container):
 *   node src/scripts/pilot-reddit-in-session-rotate.js [accountId]
 *   FORCE=0 node src/scripts/pilot-reddit-in-session-rotate.js 20
 */
require('dotenv').config();
const pool = require('../services/db');
const redditPasswordResetService = require('../services/redditPasswordResetService');

async function main() {
  const accountId = Number(process.argv[2] || 20);
  const dryRun = process.env.DRY_RUN === '1';
  const force = process.env.FORCE !== '0';

  const { rows } = await pool.query(`SELECT * FROM social_accounts WHERE id = $1`, [accountId]);
  const account = rows[0];
  if (!account) throw new Error(`account ${accountId} not found`);
  if (account.platform !== 'reddit') throw new Error('not reddit');

  console.log(
    JSON.stringify(
      {
        accountId,
        username: account.username,
        email: account.email,
        dryRun,
        force,
      },
      null,
      2
    )
  );

  const result = await redditPasswordResetService.runInSessionRotateForAccount(account, {
    dryRun,
    force,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.success && !result.skipped) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
