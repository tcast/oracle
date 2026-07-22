#!/usr/bin/env node
/**
 * GENTLY log in and (optionally) build out FRESH LinkedIn accounts.
 *
 * Safety model (obeys AGENTS.md "Social automation safety — NON-NEGOTIABLE"):
 *   - ONE login attempt per account, via its dedicated residential proxy only.
 *     No direct-from-datacenter first login, no re-login loop.
 *   - Sequential, human-spaced (minutes between accounts). Low concurrency (1).
 *   - Any checkpoint / captcha / ID-verification => STOP that account, mark it
 *     accurately, never retry.
 *   - If early accounts hit blocks (abort threshold), STOP the whole run so the
 *     rest of the batch is preserved rather than burned.
 *
 * Modes:
 *   default            -> login probe only (no profile writes)
 *   --profile          -> after a clean login, build headline/about/experience,
 *                         then photo (portrait pool) + banner (scenic pool) where none
 *
 * Selection:
 *   --limit N          -> up to N accounts from the fresh batch (default 1)
 *   --ids 1,2,3        -> explicit account ids
 *   --space-min M      -> minutes between accounts (default 5, jittered)
 *   --batch TAG        -> import_batch tag to target (default 2026-07-22)
 *   --abort-blocks N   -> stop whole run after N blocked/failed accounts (default 2)
 *
 * Usage (in container):
 *   node src/scripts/build-linkedin-fresh.js --limit 1
 *   node src/scripts/build-linkedin-fresh.js --ids 858 --profile
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../services/db');
const playwrightService = require('../services/playwrightService');

const BATCH_DEFAULT = '2026-07-22';
const PHOTO_DIR = process.env.LINKEDIN_PHOTO_DIR || path.join(__dirname, '../../private/linkedin-photos');
const X_PHOTO_DIR = process.env.X_PHOTO_DIR || path.join(__dirname, '../../private/x-photos');
const LI_BANNER_DIR = process.env.LINKEDIN_BANNER_DIR || path.join(__dirname, '../../private/linkedin-banners');
const X_BANNER_DIR = process.env.X_BANNER_DIR || path.join(__dirname, '../../private/x-banners');

const TITLES = [
  ['Talent Acquisition Specialist', 'Talent Acquisition | Screening beyond the resume'],
  ['Technical Recruiter', 'Technical Recruiter | Real signal over keyword-perfect resumes'],
  ['People Operations Specialist', 'People Ops | Hiring processes candidates actually finish'],
  ['Talent Acquisition Manager', 'TA Manager | Fewer interviews, better hires'],
  ['Recruiting Lead', 'Recruiting Lead | Pipeline quality over volume'],
  ['Senior Talent Partner', 'Senior Talent Partner | Practical hiring for busy managers'],
  ['Talent Sourcer', 'Talent Sourcer | From Easy Apply noise to real shortlists'],
  ['Recruiting Operations Specialist', 'RecOps | Systems that make TA teams faster'],
];
const COMPANIES = [
  'Northline Talent', 'BrightPath People', 'Harbor & Co. Recruiting',
  'Summit Staff Partners', 'Clearview People Ops', 'Cedarline Talent Group',
];
const ABOUTS = [
  `I help hiring teams move faster without lowering the bar. Most of my week is turning noisy applicant pools into a short list worth a live conversation.\n\nLately I've leaned on async video screening so candidates can show how they think before we burn calendar time.`,
  `Recruiting in 2026 means every resume looks "perfect." I focus on communication, problem-solving, and real evidence of skill — not keyword stuffing.\n\nStructured pre-screens (video + scored responses) help hiring managers only meet people who can explain their work.`,
  `I design hiring workflows candidates complete and recruiters trust. Clear steps, less back-and-forth, better interviews.\n\nBig believer in async pre-screens so we stop guessing from resumes.`,
  `I run TA for growing teams that can't afford weeks of resume theater. Goal is simple: fewer, better interviews.\n\nWe screen with structured journeys so the strongest candidates rise first.`,
];

function humanName(email) {
  const handle = String(email).split('@')[0].replace(/[0-9]+/g, '');
  // Best-effort: many handles are firstlast; we cannot reliably split, so just
  // present a clean capitalized label for records/logs (not pushed to LinkedIn).
  return handle.charAt(0).toUpperCase() + handle.slice(1);
}

function personaFor(accountId, email) {
  const [title, headline] = TITLES[accountId % TITLES.length];
  const company = COMPANIES[(accountId + 1) % COMPANIES.length];
  const about = ABOUTS[accountId % ABOUTS.length];
  return { name: humanName(email), title, headline, company, about };
}

function findPortrait(username) {
  const dirs = [PHOTO_DIR, X_PHOTO_DIR].filter((d) => fs.existsSync(d));
  // Exact per-username match first (rare for fresh accounts), else pooled portrait.
  for (const dir of dirs) {
    for (const ext of ['jpg', 'png']) {
      const p = path.join(dir, `${username}.${ext}`);
      if (fs.existsSync(p)) return p;
    }
  }
  const pool = [];
  for (const dir of dirs) {
    for (const name of fs.readdirSync(dir)) {
      if (/\.(jpe?g|png)$/i.test(name)) pool.push(path.join(dir, name));
    }
  }
  if (!pool.length) return null;
  // Deterministic pick by username hash so re-runs are stable.
  let h = 0;
  for (const c of username) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return pool[h % pool.length];
}

function findBanner(accountId) {
  const dirs = [LI_BANNER_DIR, X_BANNER_DIR].filter((d) => fs.existsSync(d));
  const pool = [];
  for (const dir of dirs) {
    for (const name of fs.readdirSync(dir)) {
      if (!/\.(jpe?g|png|webp)$/i.test(name)) continue;
      if (/face|portrait|headshot|avatar|pilot/i.test(name)) continue; // never a face
      pool.push(path.join(dir, name));
    }
  }
  if (!pool.length) return null;
  return pool[accountId % pool.length];
}

async function markBlocked(accountId, classification, message) {
  await pool.query(
    `UPDATE social_accounts
     SET status = 'inactive',
         warmup_status = $2,
         credentials = jsonb_set(
           COALESCE(credentials, '{}'::jsonb),
           '{login_block}',
           $3::jsonb,
           true
         ),
         updated_at = NOW()
     WHERE id = $1`,
    [
      accountId,
      classification,
      JSON.stringify({
        classification,
        message: String(message || '').slice(0, 300),
        at: new Date().toISOString(),
      }),
    ]
  );
}

async function selectAccounts({ ids, limit, batch }) {
  if (ids && ids.length) {
    const { rows } = await pool.query(
      `SELECT id, email, username, warmup_status, profile_enrichment
       FROM social_accounts
       WHERE platform = 'linkedin' AND id = ANY($1::int[])
       ORDER BY id`,
      [ids]
    );
    return rows;
  }
  // Fresh, proxied, not yet logged in / not blocked.
  const { rows } = await pool.query(
    `SELECT sa.id, sa.email, sa.username, sa.warmup_status, sa.profile_enrichment
     FROM social_accounts sa
     WHERE sa.platform = 'linkedin'
       AND sa.credentials->>'import_batch' = $1
       AND sa.status = 'active'
       AND COALESCE(sa.warmup_status, 'pending') = 'pending'
       AND (sa.credentials ? 'login_block') = false
       AND EXISTS (
         SELECT 1 FROM social_account_proxies sap JOIN proxies p ON p.id = sap.proxy_id
         WHERE sap.social_account_id = sa.id AND sap.is_active AND p.is_active
       )
     ORDER BY sa.id
     LIMIT $2`,
    [batch, limit]
  );
  return rows;
}

function parseArgs() {
  const a = process.argv.slice(2);
  const opts = { limit: 1, spaceMin: 5, profile: false, ids: null, batch: BATCH_DEFAULT, abortBlocks: 2 };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--profile') opts.profile = true;
    else if (a[i] === '--limit') opts.limit = Number(a[++i]);
    else if (a[i] === '--space-min') opts.spaceMin = Number(a[++i]);
    else if (a[i] === '--ids') opts.ids = a[++i].split(',').map(Number).filter(Boolean);
    else if (a[i] === '--batch') opts.batch = a[++i];
    else if (a[i] === '--abort-blocks') opts.abortBlocks = Number(a[++i]);
  }
  return opts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const opts = parseArgs();
  const accounts = await selectAccounts(opts);
  if (!accounts.length) {
    console.log('No eligible accounts to process.');
    await pool.end().catch(() => {});
    return;
  }

  console.log(`Processing ${accounts.length} account(s) — mode=${opts.profile ? 'login+profile' : 'login-probe'}, space=${opts.spaceMin}m, abort-after=${opts.abortBlocks} blocks`);

  const results = [];
  let blocks = 0;

  for (let i = 0; i < accounts.length; i++) {
    const acct = accounts[i];
    console.log(`\n=== #${acct.id} ${acct.email} (proxy-only, single attempt) ===`);

    let login;
    try {
      login = await playwrightService.smokeTestLinkedInLogin(acct.id, { requireProxy: true });
    } catch (e) {
      login = { success: false, accountId: acct.id, error: e.message, classification: playwrightService.classifyLinkedInLoginFailure(e.message) };
    }
    console.log(`login: ${JSON.stringify({ ok: login.success, class: login.classification, err: (login.error || '').slice(0, 80) })}`);

    if (!login.success) {
      const cls = login.classification || 'login_failed';
      await markBlocked(acct.id, cls, login.error);
      blocks += 1;
      results.push({ id: acct.id, email: acct.email, login: false, classification: cls, profile: null });

      const catastrophic = cls === 'id_verification_required';
      if (catastrophic || blocks >= opts.abortBlocks) {
        console.warn(`\n!!! STOPPING RUN: ${catastrophic ? 'ID-verification restriction hit' : `${blocks} blocked accounts`} — preserving the rest of the batch.`);
        break;
      }
      // spacing before next account even after a soft failure
      if (i < accounts.length - 1) await spaceOut(opts.spaceMin);
      continue;
    }

    // Clean login.
    let profileResult = null;
    if (opts.profile) {
      const persona = personaFor(acct.id, acct.email);
      console.log(`profile: building ${persona.title} @ ${persona.company}`);
      profileResult = await playwrightService.updateLinkedInHiringPersona(acct.id, persona, { requireProxy: false })
        .catch((e) => ({ success: false, error: e.message }));
      console.log(`profile: ${JSON.stringify({ ok: profileResult.success, steps: profileResult.steps, err: (profileResult.error || '').slice(0, 60) })}`);

      // Re-read enrichment to decide photo/banner.
      const enr = (await pool.query(`SELECT profile_enrichment FROM social_accounts WHERE id=$1`, [acct.id])).rows[0]?.profile_enrichment || {};
      if (!enr.photo) {
        const portrait = findPortrait(acct.username);
        if (portrait) {
          const ph = await playwrightService.updateLinkedInProfilePhoto(acct.id, portrait, { requireProxy: false }).catch((e) => ({ success: false, error: e.message }));
          console.log(`photo: ${JSON.stringify({ ok: ph.success, err: (ph.error || '').slice(0, 50) })}`);
        } else {
          console.log('photo: no portrait in pool — skip');
        }
      }
      const enr2 = (await pool.query(`SELECT profile_enrichment FROM social_accounts WHERE id=$1`, [acct.id])).rows[0]?.profile_enrichment || {};
      if (!enr2.banner) {
        const banner = findBanner(acct.id);
        if (banner) {
          const bn = await playwrightService.updateLinkedInProfileBanner(acct.id, banner, { requireProxy: false }).catch((e) => ({ success: false, error: e.message }));
          console.log(`banner: ${JSON.stringify({ ok: bn.success, err: (bn.error || '').slice(0, 50) })}`);
        } else {
          console.log('banner: no scenic banner in pool — skip');
        }
      }
    }

    results.push({ id: acct.id, email: acct.email, login: true, classification: 'ok', profile: profileResult ? !!profileResult.success : 'skipped' });

    if (i < accounts.length - 1) await spaceOut(opts.spaceMin);
  }

  console.log('\n===== RUN SUMMARY =====');
  console.table(results.map((r) => ({ id: r.id, email: (r.email || '').slice(0, 26), login: r.login, class: r.classification, profile: r.profile })));
  const ok = results.filter((r) => r.login).length;
  console.log(`Logged in: ${ok}/${results.length} | blocked/failed: ${results.length - ok}`);
  await pool.end().catch(() => {});
}

async function spaceOut(minutes) {
  const jitterMs = Math.floor(minutes * 60000 * (0.8 + Math.random() * 0.6));
  console.log(`... spacing ~${Math.round(jitterMs / 60000)}m before next account (human pacing) ...`);
  await sleep(jitterMs);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
