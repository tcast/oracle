#!/usr/bin/env node
/**
 * Enable X following campaign, enroll eligible accounts, optionally run one tick.
 *
 * Usage:
 *   node src/scripts/start-x-follow-campaign.js
 *   node src/scripts/start-x-follow-campaign.js --tick
 */
require('dotenv').config();
const pool = require('../services/db');
const xFollowService = require('../services/xFollowService');
const xFollowScheduler = require('../services/xFollowScheduler');

async function main() {
  const doTick = process.argv.includes('--tick');

  const settings = await xFollowService.updateSettings({
    enabled: true,
    min_per_day: 2,
    max_per_day: 5,
    max_concurrent: 1,
    quiet_hours_start: 1,
    quiet_hours_end: 8,
    warm: true,
  });
  console.log('Settings:', settings);

  const n = await xFollowService.ensureJobsForEligible();
  console.log(`Enrolled ${n} eligible X account(s)`);

  const dash = await xFollowService.getDashboard();
  console.log(
    `Targets enabled=${dash.targets_enabled}`,
    dash.targets_by_category,
    `jobs=${dash.jobs.length}`
  );
  console.table(
    dash.jobs.map((j) => ({
      id: j.social_account_id,
      user: j.username,
      today: `${j.follows_today}/${j.daily_target}`,
      next: j.next_due_at,
      enabled: j.enabled,
    }))
  );

  if (doTick) {
    console.log('\nRunning immediate tick…');
    const result = await xFollowScheduler.tick();
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('\nCampaign enabled. Durable queue will tick on its own after backend restart.');
  }

  await pool.end().catch(() => {});
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
