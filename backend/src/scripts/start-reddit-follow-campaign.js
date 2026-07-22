#!/usr/bin/env node
/**
 * Enable Reddit following campaign, enroll eligible accounts, optionally run one tick.
 *
 * Usage:
 *   node src/scripts/start-reddit-follow-campaign.js
 *   node src/scripts/start-reddit-follow-campaign.js --tick
 */
require('dotenv').config();
const pool = require('../services/db');
const redditFollowService = require('../services/redditFollowService');
const redditFollowScheduler = require('../services/redditFollowScheduler');

async function main() {
  const doTick = process.argv.includes('--tick');

  const settings = await redditFollowService.updateSettings({
    enabled: true,
    min_per_day: 2,
    max_per_day: 5,
    max_concurrent: 2,
    quiet_hours_start: 1,
    quiet_hours_end: 8,
    warm: true,
  });
  console.log('Settings:', settings);

  const n = await redditFollowService.ensureJobsForEligible();
  console.log(`Enrolled ${n} eligible Reddit account(s)`);

  const dash = await redditFollowService.getDashboard();
  console.log(
    `Targets enabled=${dash.targets_enabled}`,
    dash.targets_by_category,
    `jobs_enabled=${dash.jobs.filter((j) => j.enabled).length}/${dash.jobs.length}`
  );
  console.table(
    dash.jobs.slice(0, 25).map((j) => ({
      id: j.social_account_id,
      user: j.username,
      today: `${j.follows_today}/${j.daily_target}`,
      next: j.next_due_at,
      enabled: j.enabled,
    }))
  );

  if (doTick) {
    console.log('\nRunning immediate tick…');
    const result = await redditFollowScheduler.tick();
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('\nCampaign enabled. Durable queue + AccountOpsBrain will pick up follows.');
  }

  await pool.end().catch(() => {});
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
