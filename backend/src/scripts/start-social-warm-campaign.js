#!/usr/bin/env node
/**
 * Enable IG + TikTok warming, enroll accounts, optional tick / browse warmup.
 *
 * Usage:
 *   node src/scripts/start-social-warm-campaign.js
 *   node src/scripts/start-social-warm-campaign.js --smoke
 *   node src/scripts/start-social-warm-campaign.js --tick
 */
require('dotenv').config();
const pool = require('../services/db');
const socialWarmService = require('../services/socialWarmService');
const socialWarmScheduler = require('../services/socialWarmScheduler');
const playwrightService = require('../services/playwrightService');

async function ensureOtterProxy() {
  // #76 was historically unmapped
  const row = await pool.query(
    `SELECT sa.id FROM social_accounts sa
     WHERE sa.id = 76 AND NOT EXISTS (
       SELECT 1 FROM social_account_proxies sap
       WHERE sap.social_account_id = sa.id AND sap.is_active
     )`
  );
  if (!row.rows[0]) return;
  const proxyService = require('../services/proxyService');
  const free = await pool.query(
    `SELECT p.id FROM proxies p
     WHERE p.is_active AND NOT EXISTS (
       SELECT 1 FROM social_account_proxies sap WHERE sap.proxy_id = p.id AND sap.is_active
     )
     ORDER BY p.id LIMIT 1`
  );
  if (free.rows[0]) {
    await proxyService.assignProxiesToAccount(76, [free.rows[0].id]);
    console.log('Assigned proxy', free.rows[0].id, 'to IG #76');
  }
}

async function smokeAll() {
  const ig = await pool.query(
    `SELECT id, username FROM social_accounts WHERE platform='instagram' AND status='active' ORDER BY id`
  );
  const tt = await pool.query(
    `SELECT id, username FROM social_accounts WHERE platform='tiktok' AND status='active' ORDER BY id`
  );

  console.log('\n=== Instagram smoke ===');
  for (const a of ig.rows) {
    console.log(`\n#${a.id} @${a.username}`);
    try {
      const r = await playwrightService.smokeTestInstagramLogin(a.id, { requireProxy: false });
      console.log(JSON.stringify(r));
    } catch (e) {
      console.error(e.message);
    }
    await new Promise((r) => setTimeout(r, 12000));
  }

  console.log('\n=== TikTok smoke ===');
  for (const a of tt.rows) {
    console.log(`\n#${a.id} @${a.username}`);
    try {
      const r = await playwrightService.smokeTestTikTokLogin(a.id, { requireProxy: false });
      console.log(JSON.stringify(r));
    } catch (e) {
      console.error(e.message);
    }
    await new Promise((r) => setTimeout(r, 20000));
  }
}

async function browseWarmLoggedIn() {
  const { rows } = await pool.query(
    `SELECT sa.id, sa.platform, sa.username
     FROM social_accounts sa
     JOIN browser_sessions bs ON bs.account_id = sa.id AND bs.platform = sa.platform
     WHERE sa.platform IN ('instagram','tiktok')
       AND sa.status = 'active'
       AND bs.cookies IS NOT NULL AND jsonb_array_length(bs.cookies) > 0
     ORDER BY sa.platform, sa.id`
  );
  console.log(`\nBrowse-warmup ${rows.length} account(s) with sessions…`);
  for (const a of rows) {
    console.log(`\nWarm browse #${a.id} ${a.platform} @${a.username}`);
    try {
      const r = await playwrightService.warmUpAccount(a.id, a.platform);
      console.log(JSON.stringify(r));
    } catch (e) {
      console.error(e.message);
    }
    await new Promise((r) => setTimeout(r, 10000));
  }
}

async function main() {
  const doSmoke = process.argv.includes('--smoke');
  const doTick = process.argv.includes('--tick');
  const doBrowse = process.argv.includes('--browse') || doSmoke;

  await ensureOtterProxy();

  if (doSmoke) {
    await smokeAll();
  }

  for (const platform of ['instagram', 'tiktok']) {
    const settings = await socialWarmService.updateSettings(platform, {
      enabled: true,
      min_per_day: 2,
      max_per_day: 4,
      max_concurrent: 1,
      do_follow: true,
      do_like: true,
      warm: true,
    });
    const n = await socialWarmService.ensureJobsForPlatform(platform);
    console.log(`${platform}: enabled=${settings.enabled}, enrolled=${n}`);
  }

  if (doBrowse) {
    await browseWarmLoggedIn();
  }

  // Stagger first due times so we don't burst after smoke
  await pool.query(
    `UPDATE social_warm_jobs j
     SET next_due_at = NOW() + (INTERVAL '30 minutes' + (random() * INTERVAL '3 hours')),
         updated_at = NOW()
     FROM social_accounts sa
     WHERE sa.id = j.social_account_id AND sa.platform IN ('instagram','tiktok')`
  );

  const dash = await socialWarmService.getDashboard();
  console.log('\nTargets:', dash.targets_by_category);
  console.table(
    dash.jobs.map((j) => ({
      id: j.social_account_id,
      platform: j.platform,
      user: j.username,
      today: `${j.actions_today}/${j.daily_target}`,
      next: j.next_due_at,
      warmup: j.warmup_status,
    }))
  );

  if (doTick) {
    // Force one due job if any have sessions
    await pool.query(
      `UPDATE social_warm_jobs j
       SET next_due_at = NOW() - INTERVAL '1 minute'
       FROM social_accounts sa
       JOIN browser_sessions bs ON bs.account_id = sa.id AND bs.platform = sa.platform
       WHERE j.social_account_id = sa.id
         AND sa.platform IN ('instagram','tiktok')
         AND jsonb_array_length(COALESCE(bs.cookies,'[]'::jsonb)) > 0
         AND j.id = (
           SELECT j2.id FROM social_warm_jobs j2
           JOIN social_accounts sa2 ON sa2.id = j2.social_account_id
           JOIN browser_sessions bs2 ON bs2.account_id = sa2.id
           WHERE sa2.platform IN ('instagram','tiktok')
           ORDER BY j2.id LIMIT 1
         )`
    );
    console.log('\nRunning tick…');
    console.log(JSON.stringify(await socialWarmScheduler.tick(), null, 2));
  }

  await pool.end().catch(() => {});
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
