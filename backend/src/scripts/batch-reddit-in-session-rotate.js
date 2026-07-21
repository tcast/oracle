#!/usr/bin/env node
/**
 * Batch in-session Reddit password rotates (persist immediately; BrightData verify).
 *
 * Usage:
 *   DRY_RUN=1 node src/scripts/batch-reddit-in-session-rotate.js
 *   LIMIT=5 node src/scripts/batch-reddit-in-session-rotate.js
 *   node src/scripts/batch-reddit-in-session-rotate.js 40 41 42
 */
require('dotenv').config();
const pool = require('../services/db');
const redditPasswordResetService = require('../services/redditPasswordResetService');

function parseCreds(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw;
}

async function main() {
  const ids = process.argv.slice(2).map(Number).filter(Boolean);
  const limit = Math.min(Number(process.env.LIMIT || 5), 10);
  const dryRun = process.env.DRY_RUN === '1';
  const force = process.env.FORCE !== '0';

  let accounts;
  if (ids.length) {
    const { rows } = await pool.query(
      `SELECT * FROM social_accounts WHERE id = ANY($1::int[]) AND platform = 'reddit' ORDER BY id`,
      [ids]
    );
    accounts = rows.slice(0, limit);
  } else {
    accounts = (await redditPasswordResetService.listInSessionEligibleAccounts())
      .filter((a) => {
        const c = parseCreds(a.credentials);
        return !c.password_rotated_at && c.password_locked !== 'true';
      })
      .slice(0, limit);
  }

  console.log(
    JSON.stringify(
      {
        dryRun,
        force,
        count: accounts.length,
        ids: accounts.map((a) => a.id),
        usernames: accounts.map((a) => a.username),
      },
      null,
      2
    )
  );

  const results = [];
  for (const account of accounts) {
    console.log(`\n--- rotate #${account.id} ${account.username} ---`);
    const result = await redditPasswordResetService.runInSessionRotateForAccount(account, {
      dryRun,
      force,
    });
    console.log(JSON.stringify(result, null, 2));
    results.push(result);
    await new Promise((r) => setTimeout(r, 15000));
  }

  const verified = results.filter((r) => r.success && r.loginOk).length;
  const persisted = results.filter((r) => r.success).length;
  console.log('\nSUMMARY', JSON.stringify({ persisted, verified, results }, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
