#!/usr/bin/env node
/**
 * Reclaim proxies from unused X accounts (#488-587, and #3-12 if any)
 * and assign 1:1 onto orphaned Reddit accounts for organic commenting.
 *
 * Does NOT enable X follow campaign. Does NOT mass-login Reddit.
 *
 * Usage:
 *   node src/scripts/reclaim-x-proxies-for-reddit.js
 *   node src/scripts/reclaim-x-proxies-for-reddit.js --dry-run
 */
require('dotenv').config();
const { Queue } = require('bullmq');
const pool = require('../services/db');
const proxyService = require('../services/proxyService');
const organicCommentService = require('../services/organicCommentService');

const DRY = process.argv.includes('--dry-run');
const ORGANIC_QUEUE = 'organic-comments';

async function listDonorProxies() {
  const result = await pool.query(
    `SELECT sa.id AS x_account_id, sa.username AS x_username, sap.proxy_id
     FROM social_accounts sa
     JOIN social_account_proxies sap ON sap.social_account_id = sa.id AND sap.is_active = true
     JOIN proxies p ON p.id = sap.proxy_id AND p.is_active = true
     WHERE sa.platform = 'x'
       AND (
         sa.id BETWEEN 488 AND 587
         OR sa.id BETWEEN 3 AND 12
       )
     ORDER BY
       CASE WHEN sa.id BETWEEN 488 AND 587 THEN 0 ELSE 1 END,
       sa.id`
  );
  return result.rows;
}

async function listRedditNeedingProxy() {
  const result = await pool.query(
    `SELECT sa.id, sa.username
     FROM social_accounts sa
     WHERE sa.platform = 'reddit'
       AND COALESCE(sa.is_simulated, false) = false
       AND sa.status = 'active'
       AND COALESCE(sa.credentials->>'password', '') NOT IN ('', 'default_password')
       AND COALESCE(sa.credentials->>'needs_signup', 'false') != 'true'
       AND NOT EXISTS (
         SELECT 1 FROM social_account_proxies sap
         JOIN proxies p ON p.id = sap.proxy_id
         WHERE sap.social_account_id = sa.id
           AND sap.is_active = true
           AND p.is_active = true
       )
     ORDER BY
       CASE WHEN sa.id BETWEEN 330 AND 487 THEN 0 ELSE 1 END,
       sa.id`
  );
  return result.rows;
}

async function kickOrganicSoon(delayMs = 5000) {
  const connection = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: null,
  };
  const q = new Queue(ORGANIC_QUEUE, { connection });
  try {
    const delayed = await q.getDelayed();
    const waiting = await q.getWaiting();
    for (const job of [...delayed, ...waiting]) {
      if (job.name === 'tick') {
        try {
          await job.remove();
        } catch {
          /* ignore */
        }
      }
    }
    await q.add(
      'tick',
      { scheduledAt: new Date().toISOString(), reason: 'reclaim-x-proxies-for-reddit' },
      {
        delay: delayMs,
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 1,
      }
    );
    return true;
  } finally {
    await q.close();
  }
}

async function main() {
  const donors = await listDonorProxies();
  const needers = await listRedditNeedingProxy();

  console.log(`Donor X proxies: ${donors.length}`);
  console.log(`Reddit accounts needing proxy: ${needers.length}`);
  if (DRY) console.log('DRY RUN — no writes');

  const pairs = Math.min(donors.length, needers.length);
  const assignments = [];
  let enrolled = 0;
  let newlyCreatedJobs = 0;

  for (let i = 0; i < pairs; i++) {
    const donor = donors[i];
    const reddit = needers[i];
    assignments.push({
      proxy_id: donor.proxy_id,
      from_x: donor.x_account_id,
      to_reddit: reddit.id,
      reddit_username: reddit.username,
    });

    if (DRY) continue;

    // assignProxiesToAccount frees the proxy from X (soft-deactivate) and binds 1:1
    await proxyService.assignProxiesToAccount(reddit.id, [donor.proxy_id]);

    const before = await pool.query(
      'SELECT id FROM organic_comment_jobs WHERE social_account_id = $1',
      [reddit.id]
    );
    await organicCommentService.ensureJob(reddit.id);
    if (!before.rows[0]) newlyCreatedJobs += 1;
    enrolled += 1;

    if ((i + 1) % 25 === 0) {
      console.log(`Assigned ${i + 1}/${pairs}...`);
    }
  }

  let kicked = false;
  if (!DRY && enrolled > 0) {
    try {
      kicked = await kickOrganicSoon(5000);
      console.log('Kicked organic queue (5s delay)');
    } catch (err) {
      console.warn('kickOrganicSoon failed:', err.message);
    }
  }

  // Post-verify
  const stillMissing = await listRedditNeedingProxy();
  const xStillHolding = await listDonorProxies();
  const xFollow = await pool.query(
    'SELECT enabled FROM x_follow_settings WHERE id = 1'
  );

  console.log('\n=== Result ===');
  console.log(JSON.stringify({
    dry_run: DRY,
    proxies_reclaimed_from_x: DRY ? pairs : enrolled,
    reddit_accounts_regained_proxies: DRY ? pairs : enrolled,
    organic_jobs_ensured: DRY ? 0 : enrolled,
    organic_jobs_newly_created: newlyCreatedJobs,
    organic_queue_kicked: kicked,
    still_missing_proxies: stillMissing.length,
    still_missing_ids: stillMissing.map((r) => r.id),
    x_donors_still_holding_proxies: xStillHolding.length,
    x_follow_campaign_enabled: xFollow.rows[0]?.enabled ?? null,
    sample_assignments: assignments.slice(0, 5),
    last_assignments: assignments.slice(-3),
  }, null, 2));

  await pool.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
