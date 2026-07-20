#!/usr/bin/env node
/**
 * Dry-run eligibility report for Reddit password-reset protection loop.
 *
 * Usage (in container):
 *   node src/scripts/reddit-password-reset-eligibility.js
 *   node src/scripts/reddit-password-reset-eligibility.js --json
 */
require('dotenv').config();
const pool = require('../services/db');
const redditPasswordResetService = require('../services/redditPasswordResetService');

async function main() {
  const asJson = process.argv.includes('--json');
  const report = await redditPasswordResetService.eligibilityReport();

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('Reddit password-reset eligibility');
    console.log('================================');
    console.log(`Settings: enabled=${report.settings.enabled} max/day=${report.settings.max_per_day} rotate_every=${report.settings.rotate_every_days}d`);
    console.log(`Sources: ${(report.settings.sources || []).join(', ')}`);
    console.log('');
    console.log('Totals:');
    for (const [k, v] of Object.entries(report.totals)) {
      console.log(`  ${k}: ${v}`);
    }
    console.log('');
    console.log('Active bought by inbox class:');
    for (const [k, v] of Object.entries(report.byInbox || {})) {
      console.log(`  ${k}: ${v}`);
    }
    console.log('');
    console.log('Active bought by email domain:');
    for (const [k, v] of Object.entries(report.byDomain || {})) {
      console.log(`  ${k}: ${v}`);
    }
    if (Object.keys(report.ineligibleReasons || {}).length) {
      console.log('');
      console.log('Ineligible reasons:');
      for (const [k, v] of Object.entries(report.ineligibleReasons)) {
        console.log(`  ${k}: ${v}`);
      }
    }
    console.log('');
    console.log('Sample eligible:');
    for (const row of report.sampleEligible || []) {
      console.log(
        `  #${row.accountId} ${row.username} <${row.email}> proxy=${row.proxyId} domain=${row.emailDomain}`
      );
    }
    if (!(report.sampleEligible || []).length) {
      console.log('  (none)');
    }
    console.log('');
    console.log('Honest blockers for accounts without inbox access:');
    console.log('  - Bought accounts whose seller email we cannot read cannot join this loop.');
    console.log('  - Re-buy with email+password, or migrate email to a mailbox we control.');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
