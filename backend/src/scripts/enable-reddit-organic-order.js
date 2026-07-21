#!/usr/bin/env node
/**
 * Enable organic_comment_jobs for a bought Reddit order batch.
 *
 * Usage:
 *   node src/scripts/enable-reddit-organic-order.js 780736 [--daily-target=3]
 */
require('dotenv').config();
const pool = require('../services/db');
const organicCommentService = require('../services/organicCommentService');

async function main() {
  const orderId = process.argv[2];
  if (!orderId) {
    console.error('Usage: node src/scripts/enable-reddit-organic-order.js <orderId> [--daily-target=3]');
    process.exit(1);
  }
  const dailyArg = process.argv.find((a) => a.startsWith('--daily-target='));
  const dailyTarget = dailyArg ? Number(dailyArg.split('=')[1]) : 3;

  const settings = await pool.query('SELECT enabled FROM organic_comment_settings WHERE id = 1');
  console.log('organic_settings_enabled', settings.rows[0]?.enabled);

  const accts = await pool.query(
    `SELECT id, username, warmup_status
     FROM social_accounts
     WHERE platform = 'reddit'
       AND (credentials->>'order_id' = $1 OR credentials->>'batch' = $1)
     ORDER BY id`,
    [orderId]
  );
  console.log(`order ${orderId} accounts: ${accts.rows.length}`);

  let enabled = 0;
  for (let i = 0; i < accts.rows.length; i++) {
    const a = accts.rows[i];
    await organicCommentService.setAccountEnabled(a.id, true);
    const staggerMin = 5 + Math.floor(Math.random() * 90) + i * 3;
    await pool.query(
      `UPDATE organic_comment_jobs
       SET daily_target = $2,
           next_due_at = NOW() + ($3 || ' minutes')::interval,
           status = 'idle',
           updated_at = NOW()
       WHERE social_account_id = $1`,
      [a.id, dailyTarget, String(staggerMin)]
    );
    enabled += 1;
  }

  const summary = await pool.query(
    `SELECT
       COUNT(*) AS imported,
       COUNT(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM social_account_proxies sap
         JOIN proxies p ON p.id = sap.proxy_id AND p.is_active AND p.provider = 'ProxyBase'
         WHERE sap.social_account_id = sa.id AND sap.is_active
       )) AS with_pb_proxy,
       COUNT(*) FILTER (WHERE sa.warmup_status = 'warmed') AS warmed,
       COUNT(*) FILTER (WHERE COALESCE(sa.credentials->>'session_dead','') = 'true') AS session_dead,
       COUNT(*) FILTER (WHERE j.enabled) AS organic_on,
       COUNT(*) FILTER (WHERE j.enabled AND j.daily_target = $2) AS organic_target_n
     FROM social_accounts sa
     LEFT JOIN organic_comment_jobs j ON j.social_account_id = sa.id
     WHERE sa.platform = 'reddit'
       AND (sa.credentials->>'order_id' = $1 OR sa.credentials->>'batch' = $1)`,
    [orderId, dailyTarget]
  );

  console.log(JSON.stringify({ organic_enabled: enabled, daily_target: dailyTarget, ...summary.rows[0] }, null, 2));
  await pool.end().catch(() => {});
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
