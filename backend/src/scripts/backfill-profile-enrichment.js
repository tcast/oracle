#!/usr/bin/env node
/**
 * Backfill social_accounts.profile_enrichment from known LinkedIn photo files
 * and hiring_persona credentials. Reddit/X get category from persona_traits.expertise.
 *
 * Assumptions:
 * - LI photo file in private/linkedin-photos ⇒ photo was uploaded (batch1+batch2).
 * - credentials.hiring_persona ⇒ headline/about/experience applied (batch1 only).
 * - LinkedIn banner not implemented ⇒ banner always false.
 *
 * Usage:
 *   node src/scripts/backfill-profile-enrichment.js
 *   node src/scripts/backfill-profile-enrichment.js --dry-run
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../services/db');
const {
  deriveEnrichment,
  normalizeEnrichment,
} = require('../services/profileEnrichment');

const PHOTO_DIR =
  process.env.LINKEDIN_PHOTO_DIR || path.join(__dirname, '../../private/linkedin-photos');

function slugFromProfile(url) {
  const m = String(url || '').match(/linkedin\.com\/in\/([^\/?#]+)/i);
  return m ? m[1] : null;
}

function hasPhotoFile(slug, username) {
  const candidates = [
    path.join(PHOTO_DIR, `${slug}.jpg`),
    path.join(PHOTO_DIR, `${slug}.png`),
    path.join(PHOTO_DIR, `${username}.jpg`),
    path.join(PHOTO_DIR, `${username}.png`),
  ];
  return candidates.some((p) => p && fs.existsSync(p));
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`Photo dir: ${PHOTO_DIR}`);
  console.log(dryRun ? 'DRY RUN — no writes' : 'Writing profile_enrichment…');

  // Ensure column exists
  await pool.query(`
    ALTER TABLE social_accounts
      ADD COLUMN IF NOT EXISTS profile_enrichment JSONB DEFAULT NULL
  `);

  const { rows } = await pool.query(
    `SELECT id, platform, username, credentials, persona_traits, profile_enrichment
     FROM social_accounts
     ORDER BY platform, id`
  );

  const summary = { full: 0, partial: 0, none: 0, updated: 0 };
  for (const row of rows) {
    const creds =
      typeof row.credentials === 'string'
        ? JSON.parse(row.credentials)
        : row.credentials || {};
    const slug = slugFromProfile(creds.profile_url) || row.username;
    const photoFile =
      row.platform === 'linkedin' ? hasPhotoFile(slug, row.username) : false;

    const enrichment = deriveEnrichment({
      platform: row.platform,
      credentials: creds,
      persona_traits: row.persona_traits,
      hasPhotoFile: photoFile,
      existing: row.profile_enrichment,
    });

    // Prefer preserving manually set fields if already richer
    const existing = normalizeEnrichment(row.profile_enrichment);
    const merged = normalizeEnrichment({
      photo: existing.photo || enrichment.photo,
      banner: existing.banner || enrichment.banner,
      headline: existing.headline || enrichment.headline,
      about: existing.about || enrichment.about,
      experience: existing.experience || enrichment.experience,
      category: existing.category || enrichment.category,
      source: 'backfill',
      updated_at: new Date().toISOString(),
    });

    summary[merged.built_out] = (summary[merged.built_out] || 0) + 1;

    if (!dryRun) {
      await pool.query(
        `UPDATE social_accounts
         SET profile_enrichment = $2::jsonb, updated_at = NOW()
         WHERE id = $1`,
        [row.id, JSON.stringify(merged)]
      );
      summary.updated += 1;
    }

    if (row.platform === 'linkedin' || merged.built_out !== 'none' || merged.category) {
      console.log(
        `#${row.id} ${row.platform} ${String(row.username).slice(0, 28)} ` +
          `built=${merged.built_out} photo=${merged.photo} headline=${merged.headline} ` +
          `cat=${merged.category || '—'}`
      );
    }
  }

  console.log('\n===== SUMMARY =====');
  console.log(summary);
  await pool.end().catch(() => {});
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
