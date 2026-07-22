#!/usr/bin/env node
/**
 * Enable LinkedIn organic + follow for all active proxied LinkedIn accounts.
 * Usage: node src/scripts/enable-linkedin-ops.js
 */
require('dotenv').config();
const pool = require('../services/db');
const organicCommentService = require('../services/organicCommentService');
const linkedinFollowService = require('../services/linkedinFollowService');

async function main() {
  await pool.query(`
    UPDATE organic_comment_settings
    SET enabled = true, updated_at = NOW()
    WHERE id = 1
  `);

  await linkedinFollowService.updateSettings({
    enabled: true,
    min_per_day: 2,
    max_per_day: 5,
    max_concurrent: 2,
    quiet_hours_start: 1,
    quiet_hours_end: 8,
  });

  const { rows } = await pool.query(
    `SELECT sa.id
     FROM social_accounts sa
     WHERE sa.platform = 'linkedin'
       AND sa.status = 'active'
       AND COALESCE(sa.is_simulated, false) = false
       AND EXISTS (
         SELECT 1 FROM social_account_proxies sap
         JOIN proxies p ON p.id = sap.proxy_id
         WHERE sap.social_account_id = sa.id AND sap.is_active AND p.is_active
       )
     ORDER BY sa.id`
  );

  let organic = 0;
  let follow = 0;
  for (let i = 0; i < rows.length; i++) {
    const id = rows[i].id;
    await organicCommentService.setAccountEnabled(id, true);
    const offsetMin = 2 + i * 3 + Math.floor(Math.random() * 4);
    await pool.query(
      `UPDATE organic_comment_jobs
       SET enabled = true,
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
    organic += 1;

    await linkedinFollowService.setAccountEnabled(id, true);
    await pool.query(
      `UPDATE linkedin_follow_jobs
       SET enabled = true,
           status = 'idle',
           next_due_at = NOW() + ($2 * INTERVAL '1 minute'),
           updated_at = NOW()
       WHERE social_account_id = $1`,
      [id, offsetMin + 1]
    );
    follow += 1;
  }

  const counts = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM organic_comment_jobs j
         JOIN social_accounts sa ON sa.id = j.social_account_id
        WHERE sa.platform = 'linkedin' AND j.enabled) AS organic_enabled,
      (SELECT COUNT(*)::int FROM linkedin_follow_jobs j
         JOIN social_accounts sa ON sa.id = j.social_account_id
        WHERE sa.platform = 'linkedin' AND j.enabled) AS follow_enabled,
      (SELECT COUNT(*)::int FROM linkedin_follow_targets WHERE enabled) AS targets
  `);

  console.log(
    JSON.stringify(
      {
        accounts: rows.length,
        organic_enrolled: organic,
        follow_enrolled: follow,
        ...counts.rows[0],
      },
      null,
      2
    )
  );
  await pool.end().catch(() => {});
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});
