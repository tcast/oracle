#!/usr/bin/env node
/**
 * Enroll warmed X cookie accounts into organic commenting (3/day).
 * Usage: node src/scripts/enroll-x-organic.js [minId] [maxId]
 */
require('dotenv').config();
const pool = require('../services/db');
const organicCommentService = require('../services/organicCommentService');

async function main() {
  const minId = Number(process.argv[2] || 600);
  const maxId = Number(process.argv[3] || 9999);
  const { rows } = await pool.query(
    `SELECT sa.id, sa.username
     FROM social_accounts sa
     LEFT JOIN organic_comment_jobs j
       ON j.social_account_id = sa.id AND j.enabled = true
     WHERE sa.platform = 'x'
       AND sa.status = 'active'
       AND sa.warmup_status = 'warmed'
       AND sa.id BETWEEN $1 AND $2
       AND j.id IS NULL
     ORDER BY sa.id`,
    [minId, maxId]
  );

  console.log(`Enrolling ${rows.length} warmed X accounts (${minId}-${maxId})`);
  for (let i = 0; i < rows.length; i++) {
    const id = rows[i].id;
    await organicCommentService.setAccountEnabled(id, true);
    const offsetMin = 10 + i * 12;
    await pool.query(
      `UPDATE organic_comment_jobs
       SET daily_target = 3,
           day_key = CURRENT_DATE,
           enabled = true,
           status = 'idle',
           failure_class = NULL,
           cooldown_until = NULL,
           last_error = NULL,
           consecutive_failures = 0,
           next_due_at = NOW() + ($2 * INTERVAL '1 minute'),
           updated_at = NOW()
       WHERE social_account_id = $1`,
      [id, offsetMin]
    );
    console.log(`enabled #${id} @${rows[i].username} due_in_min=${offsetMin}`);
  }

  const stats = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE sa.warmup_status = 'warmed' AND sa.status = 'active' AND j.enabled) AS live_enabled,
       COUNT(*) FILTER (WHERE sa.warmup_status = 'pending') AS pending,
       COUNT(*) FILTER (WHERE sa.status = 'inactive') AS inactive
     FROM social_accounts sa
     LEFT JOIN organic_comment_jobs j ON j.social_account_id = sa.id
     WHERE sa.platform = 'x' AND sa.id BETWEEN $1 AND $2`,
    [minId, maxId]
  );
  console.log('STATS', stats.rows[0]);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
