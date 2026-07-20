#!/usr/bin/env node
/**
 * Mark clearly banned/deleted Reddit accounts from stats-audit signals.
 *
 * Signals (from accountStatsService scrapeRedditStats):
 *   - about.json failed HTTP 403 → suspended/banned profile
 *   - about.json failed HTTP 404 → deleted/missing profile
 *
 * Sets social_accounts.status = 'banned' (organic queue already requires status='active').
 * Disables organic_comment_jobs for those accounts.
 *
 * Usage:
 *   node src/scripts/mark-banned-reddit-accounts.js
 *   node src/scripts/mark-banned-reddit-accounts.js --dry-run
 */
require('dotenv').config();
const pool = require('../services/db');

const DRY = process.argv.includes('--dry-run');

async function main() {
  const candidates = await pool.query(
    `SELECT id, username, status, total_karma, left(stats_audit_error, 120) AS err
     FROM social_accounts
     WHERE platform = 'reddit'
       AND COALESCE(is_simulated, false) = false
       AND status <> 'banned'
       AND (
         stats_audit_error ILIKE '%about.json failed HTTP 403%'
         OR stats_audit_error ILIKE '%about.json failed HTTP 404%'
       )
     ORDER BY id`
  );

  console.log(`Candidates: ${candidates.rows.length}`);
  const bySignal = { '403': 0, '404': 0 };
  for (const row of candidates.rows) {
    if (/HTTP 403/i.test(row.err || '')) bySignal['403']++;
    if (/HTTP 404/i.test(row.err || '')) bySignal['404']++;
    console.log(`  #${row.id} ${row.username} [${row.status}] karma=${row.total_karma ?? 'null'} — ${row.err}`);
  }
  console.log('By signal:', bySignal);

  if (DRY) {
    console.log('Dry run — no changes');
    return;
  }

  const ids = candidates.rows.map((r) => r.id);
  if (!ids.length) {
    console.log('Nothing to update');
    return;
  }

  const upd = await pool.query(
    `UPDATE social_accounts
     SET status = 'banned',
         updated_at = NOW()
     WHERE id = ANY($1::int[])
     RETURNING id, username`,
    [ids]
  );

  const jobs = await pool.query(
    `UPDATE organic_comment_jobs
     SET enabled = false,
         status = 'error',
         failure_class = 'banned',
         last_error = COALESCE(last_error, 'Account marked banned'),
         updated_at = NOW()
     WHERE social_account_id = ANY($1::int[])
     RETURNING social_account_id`,
    [ids]
  );

  console.log(`Marked banned: ${upd.rowCount}`);
  console.log(`Organic jobs disabled: ${jobs.rowCount}`);
  console.log('Sample:', upd.rows.slice(0, 10).map((r) => r.username).join(', '));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
