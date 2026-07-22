#!/usr/bin/env node
/**
 * Apply scenic LinkedIn banners (NOT avatars) in parallel.
 *
 * Banner pool: private/linkedin-banners OR private/x-banners (landscape only).
 * Soft-skips flaky accounts and moves on.
 *
 * Usage:
 *   node src/scripts/apply-linkedin-banners.js
 *   node src/scripts/apply-linkedin-banners.js --limit 5 --parallel 3
 *   node src/scripts/apply-linkedin-banners.js 277,278,279
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../services/db');
const playwrightService = require('../services/playwrightService');

const X_BANNER_DIR =
  process.env.X_BANNER_DIR || path.join(__dirname, '../../private/x-banners');
const LI_BANNER_DIR =
  process.env.LINKEDIN_BANNER_DIR || path.join(__dirname, '../../private/linkedin-banners');
const HARD_MS = Number(process.env.LINKEDIN_BANNER_TIMEOUT_MS || 120000);

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function loadBannerPool() {
  const dirs = [LI_BANNER_DIR, X_BANNER_DIR].filter((d) => fs.existsSync(d));
  const files = [];
  for (const dir of dirs) {
    for (const name of fs.readdirSync(dir)) {
      if (!/\.(jpe?g|png|webp)$/i.test(name)) continue;
      if (/face|portrait|headshot|avatar|pilot/i.test(name)) continue;
      files.push(path.join(dir, name));
    }
  }
  return [...new Set(files)];
}

function pickBanner(pool, accountId) {
  if (!pool.length) return null;
  return pool[accountId % pool.length];
}

async function mapPool(items, concurrency, fn) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  let limit = 50;
  let parallel = 4;
  let ids = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--limit=')) limit = Number(a.split('=')[1]);
    else if (a === '--limit') {
      limit = Number(args[++i]);
    } else if (a.startsWith('--parallel=')) parallel = Number(a.split('=')[1]);
    else if (a === '--parallel') {
      parallel = Number(args[++i]);
    } else if (/^\d+(,\d+)*$/.test(a)) {
      ids = a.split(',').map(Number);
    }
  }
  parallel = Math.min(5, Math.max(1, parallel || 4));

  const bannerPool = loadBannerPool();
  if (!bannerPool.length) {
    console.error('No scenic banners in linkedin-banners/ or x-banners/');
    process.exit(1);
  }
  console.log(`Banner pool: ${bannerPool.length} (dirs=${[LI_BANNER_DIR, X_BANNER_DIR].join(', ')})`);

  let rows;
  if (ids) {
    const r = await pool.query(
      `SELECT id, username, email, profile_enrichment
       FROM social_accounts
       WHERE platform = 'linkedin' AND id = ANY($1::int[])
       ORDER BY id`,
      [ids]
    );
    rows = r.rows;
  } else {
    const r = await pool.query(
      `SELECT id, username, email, profile_enrichment
       FROM social_accounts
       WHERE platform = 'linkedin'
         AND status = 'active'
         AND COALESCE(is_simulated, false) = false
         AND COALESCE((profile_enrichment->>'banner')::boolean, false) = false
       ORDER BY id
       LIMIT $1`,
      [limit]
    );
    rows = r.rows;
  }

  console.log(`Applying banners to ${rows.length} account(s), parallel=${parallel}`);

  const results = await mapPool(rows, parallel, async (row) => {
    const bannerPath = pickBanner(bannerPool, row.id);
    console.log(`\n=== #${row.id} ${row.email} ← ${path.basename(bannerPath)} ===`);
    try {
      const result = await withTimeout(
        playwrightService.updateLinkedInProfileBanner(row.id, bannerPath, { requireProxy: false }),
        HARD_MS,
        'li_banner'
      );
      console.log(JSON.stringify({ id: row.id, ok: !!result.success, err: result.error || null }));
      return { ...result, bannerPath };
    } catch (err) {
      console.warn(`#${row.id} soft-skip: ${err.message}`);
      return { success: false, accountId: row.id, error: err.message, skipped: true };
    }
  });

  const ok = results.filter((r) => r && r.success).length;
  console.log('\n===== SUMMARY =====');
  console.table(
    results.map((r) => ({
      id: r.accountId,
      ok: !!r.success,
      skip: !!r.skipped,
      err: (r.error || '').slice(0, 50),
      banner: r.bannerSrc ? 'yes' : '',
      avatar: r.avatarSrc ? 'yes' : '',
    }))
  );
  console.log(`Done: ${ok}/${results.length}`);
  await pool.end().catch(() => {});
  process.exit(ok > 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
