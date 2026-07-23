#!/usr/bin/env node
/**
 * Carefully enable LinkedIn CONNECT/follow for a specific warmed batch.
 * - Marks dead IDs inactive
 * - Follow only (organic OFF) — safer for new profiles
 * - Low daily caps + single concurrency + staggered due times
 *
 * Usage:
 *   GOOD_IDS=938,939,... DEAD_IDS=945,946 SKIP_IDS=943 \
 *     node src/scripts/enable-linkedin-batch-connect.js
 */
require('dotenv').config();
const pool = require('../services/db');
const linkedinFollowService = require('../services/linkedinFollowService');
const organicCommentService = require('../services/organicCommentService');

function parseIds(envName, fallback = []) {
  const raw = process.env[envName];
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

const GOOD = parseIds('GOOD_IDS', [938, 939, 940, 941, 942, 944, 947]);
const DEAD = parseIds('DEAD_IDS', [945, 946]);
const SKIP = parseIds('SKIP_IDS', [943]);

async function markDead(id) {
  await pool.query(
    `UPDATE social_accounts
     SET status = 'inactive',
         warmup_status = 'id_verification_required',
         credentials = jsonb_set(
           COALESCE(credentials, '{}'::jsonb),
           '{login_block}',
           $2::jsonb,
           true
         ),
         updated_at = NOW()
     WHERE id = $1`,
    [
      id,
      JSON.stringify({
        classification: 'id_verification_required',
        message: 'user confirmed dead; ID-verification seen on follow',
        at: new Date().toISOString(),
      }),
    ]
  );
  await pool.query(
    `UPDATE linkedin_follow_jobs
     SET enabled = false, status = 'idle', failure_class = 'banned',
         last_error = 'id_verification_restricted', updated_at = NOW()
     WHERE social_account_id = $1`,
    [id]
  );
  await pool
    .query(`UPDATE organic_comment_jobs SET enabled = false, updated_at = NOW() WHERE social_account_id = $1`, [
      id,
    ])
    .catch(() => {});
}

async function disableOps(id) {
  await pool
    .query(`UPDATE linkedin_follow_jobs SET enabled = false, updated_at = NOW() WHERE social_account_id = $1`, [
      id,
    ])
    .catch(() => {});
  await pool
    .query(`UPDATE organic_comment_jobs SET enabled = false, updated_at = NOW() WHERE social_account_id = $1`, [
      id,
    ])
    .catch(() => {});
  await organicCommentService.setAccountEnabled(id, false).catch(() => {});
}

async function enableFollowOnly(id, index) {
  await linkedinFollowService.setAccountEnabled(id, true);
  const staggerMin = 25 + index * 30 + Math.floor(Math.random() * 20); // ~25–250m
  const daily = 1 + Math.floor(Math.random() * 2); // 1–2 connects/day
  await pool.query(
    `UPDATE linkedin_follow_jobs
     SET enabled = true,
         status = 'idle',
         failure_class = NULL,
         last_error = NULL,
         cooldown_until = NULL,
         daily_target = $2,
         next_due_at = NOW() + ($3 * INTERVAL '1 minute'),
         updated_at = NOW()
     WHERE social_account_id = $1`,
    [id, daily, staggerMin]
  );
  await disableOpsOrganic(id);
  return { id, daily, staggerMin };
}

async function disableOpsOrganic(id) {
  await organicCommentService.setAccountEnabled(id, false).catch(() => {});
  // Hold flag stops brain enrollOrganicGap from flipping these back on.
  await pool.query(
    `UPDATE social_accounts
     SET credentials = jsonb_set(
           COALESCE(credentials, '{}'::jsonb),
           '{organic_hold}',
           'true'::jsonb,
           true
         ),
         updated_at = NOW()
     WHERE id = $1`,
    [id]
  );
  await pool
    .query(
      `UPDATE organic_comment_jobs
       SET enabled = false,
           failure_class = 'manual_hold',
           last_error = 'connect-only hold for new LinkedIn batch',
           updated_at = NOW()
       WHERE social_account_id = $1`,
      [id]
    )
    .catch(() => {});
}

async function main() {
  for (const id of DEAD) {
    await markDead(id);
    console.log('DEAD', id);
  }
  for (const id of SKIP) {
    await disableOps(id);
    console.log('SKIP', id);
  }

  const settings = await linkedinFollowService.updateSettings({
    enabled: true,
    min_per_day: 1,
    max_per_day: 3,
    max_concurrent: 1,
    quiet_hours_start: 1,
    quiet_hours_end: 9,
  });
  console.log('settings', {
    enabled: settings.enabled,
    min: settings.min_per_day,
    max: settings.max_per_day,
    concurrent: settings.max_concurrent,
    quiet: `${settings.quiet_hours_start}-${settings.quiet_hours_end}`,
  });

  const enrolled = [];
  for (let i = 0; i < GOOD.length; i++) {
    enrolled.push(await enableFollowOnly(GOOD[i], i));
    console.log('GOOD follow-only', enrolled[i]);
  }

  const { rows } = await pool.query(
    `SELECT sa.id, sa.status, sa.warmup_status,
            j.enabled AS follow_on, j.daily_target, j.follows_today,
            j.next_due_at, j.status AS job_status,
            o.enabled AS organic_on
     FROM social_accounts sa
     LEFT JOIN linkedin_follow_jobs j ON j.social_account_id = sa.id
     LEFT JOIN organic_comment_jobs o ON o.social_account_id = sa.id
     WHERE sa.id = ANY($1::int[])
     ORDER BY sa.id`,
    [[...GOOD, ...DEAD, ...SKIP]]
  );
  console.log(JSON.stringify({ enrolled, rows }, null, 2));
  await pool.end().catch(() => {});
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});
