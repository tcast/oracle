#!/usr/bin/env node
/**
 * LIVE apply X personas via cookie session + Oxylabs sticky proxy.
 *
 * Prerequisites:
 *   - credentials.x_persona assigned (update-x-personas.js)
 *   - Cookie session healthy (no password login — allowLogin:false)
 *   - X_PERSONA_LIVE=1
 *
 * Usage:
 *   X_PERSONA_LIVE=1 node src/scripts/apply-x-personas-live.js --accounts 618,620,600
 *   X_PERSONA_LIVE=1 node src/scripts/apply-x-personas-live.js --pending --with-photo --with-banner --concurrency 4
 *   X_PERSONA_LIVE=1 node src/scripts/apply-x-personas-live.js --banner-fix --concurrency 4
 *   X_PERSONA_LIVE=1 node src/scripts/apply-x-personas-live.js --restore-media --accounts 630,610 --concurrency 4
 *   X_PERSONA_LIVE=1 node src/scripts/apply-x-personas-live.js --ids-file /tmp/x-ids.txt --dry-run
 *
 * Avatar photos: private/x-photos (+ linkedin-photos fallback for portraits only).
 * Banner headers: private/x-banners ONLY — never portraits / face crops.
 * --restore-media: re-apply portrait avatar THEN scenic banner (fixes avatar/banner mixups).
 *
 * Soft-skips rate_limit / proxy_error (does not mark account dead).
 * Session dead → markDeadSessionAccount and continue.
 * Banned/suspended → markBannedAccount and continue.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../services/db');
const playwrightService = require('../services/playwrightService');

const PHOTO_DIR =
  process.env.X_PHOTO_DIR || path.join(__dirname, '../../private/x-photos');
const BANNER_DIR =
  process.env.X_BANNER_DIR || path.join(__dirname, '../../private/x-banners');
const LI_PHOTO_DIR = path.join(__dirname, '../../private/linkedin-photos');

function arg(name, def = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return def;
  const v = process.argv[idx + 1];
  return v && !v.startsWith('--') ? v : true;
}

function parseJson(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function classifyApplyError(msg) {
  const m = String(msg || '');
  if (
    /account_suspended|is suspended|has been suspended|account_does_not_exist|This account doesn.?t exist|account_locked/i.test(
      m
    )
  ) {
    return 'banned';
  }
  if (/x_profile_error|Oops,?\s*something went wrong/i.test(m)) {
    return 'other';
  }
  if (
    /no_live_session|session_not_logged_in|not.?logged.?in|login_wall|no_session/i.test(m)
  ) {
    return 'session_dead';
  }
  if (/x_username_needs_password|rename_needs_password/i.test(m)) {
    return 'needs_password';
  }
  if (/x_persona_verify_failed/i.test(m)) {
    return 'verify_failed';
  }
  if (/rate.?limit|try again later/i.test(m)) {
    return 'rate_limit';
  }
  if (/proxy|oxylabs|ECONNREFUSED|ETIMEDOUT|tunnel|ERR_PROXY|ERR_TUNNEL/i.test(m)) {
    return 'proxy_error';
  }
  if (/challenge|unusual activity|verify you/i.test(m)) {
    return 'challenge';
  }
  return 'other';
}

function listImages(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .map((f) => path.join(dir, f));
}

const PHOTO_POOL = [...listImages(PHOTO_DIR), ...listImages(LI_PHOTO_DIR)];
// NEVER fall back to portrait / LinkedIn face crops for headers.
const BANNER_POOL = listImages(BANNER_DIR);

function pickFromPool(pool, accountId) {
  if (!pool.length) return null;
  return pool[Number(accountId) % pool.length];
}

function assertBannerAsset(filePath) {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  const bannerRoot = path.resolve(BANNER_DIR);
  if (!resolved.startsWith(bannerRoot + path.sep) && resolved !== bannerRoot) {
    throw new Error(
      `Refusing non-banner asset as X header (must live under x-banners/): ${filePath}`
    );
  }
  return resolved;
}

function resolvePhotoPath(accountId) {
  const candidates = [
    path.join(PHOTO_DIR, `${accountId}.jpg`),
    path.join(PHOTO_DIR, `${accountId}.png`),
    path.join(PHOTO_DIR, `pilot-${accountId}.jpg`),
    path.join(PHOTO_DIR, `pilot-${accountId}.png`),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return pickFromPool(PHOTO_POOL, accountId);
}

function resolveBannerPath(accountId) {
  const candidates = [
    path.join(BANNER_DIR, `${accountId}.jpg`),
    path.join(BANNER_DIR, `${accountId}.png`),
    path.join(BANNER_DIR, `banner-${accountId}.jpg`),
    path.join(BANNER_DIR, `banner-${accountId}.png`),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return assertBannerAsset(p);
  }
  const picked = pickFromPool(BANNER_POOL, accountId + 17);
  return picked ? assertBannerAsset(picked) : null;
}

async function resolvePendingIds({ upgrade, renameOnly, bannerFix } = {}) {
  const { needsHumanHandle } = require('../services/xPersonas');
  const { rows } = await pool.query(
    `SELECT id, username, status, warmup_status, credentials
     FROM social_accounts
     WHERE platform = 'x'
       AND status = 'active'
       AND COALESCE(warmup_status, 'new') = 'warmed'
     ORDER BY id ASC`
  );
  const out = [];
  for (const row of rows) {
    const creds = parseJson(row.credentials, {});
    const xp = creds.x_persona || {};
    const applied = !!xp.applied_live;
    const hasUser = !!(xp.desired_username || xp.username);
    const hasBanner = !!xp.banner_applied;
    const needsRename = needsHumanHandle(row.username, xp);
    if (bannerFix) {
      // Re-apply scenic header for anyone who already got a live persona / face banner.
      if (applied || hasBanner || xp.photo_applied) out.push(row.id);
      continue;
    }
    if (renameOnly) {
      if (needsRename) out.push(row.id);
      continue;
    }
    const needs =
      !applied ||
      needsRename ||
      (upgrade && (!hasUser || !hasBanner || !xp.username_applied || !xp.photo_applied));
    if (needs) out.push(row.id);
  }
  return out;
}

async function parseIds() {
  const accounts = arg('--accounts');
  if (typeof accounts === 'string') {
    return accounts
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  }
  const idsFile = arg('--ids-file');
  if (typeof idsFile === 'string') {
    const text = fs.readFileSync(idsFile, 'utf8');
    return text
      .split(/[\s,]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  }
  if (
    process.argv.includes('--pending') ||
    process.argv.includes('--rename-pending') ||
    process.argv.includes('--banner-fix')
  ) {
    return resolvePendingIds({
      upgrade: process.argv.includes('--upgrade'),
      renameOnly: process.argv.includes('--rename-pending'),
      bannerFix: process.argv.includes('--banner-fix'),
    });
  }
  throw new Error('Provide --accounts <ids>, --ids-file <path>, --pending, or --banner-fix');
}

async function ensureOfflinePersona(accountId, { dryRun }) {
  const { rows } = await pool.query(
    `SELECT id, platform, username, credentials, status, warmup_status
     FROM social_accounts WHERE id = $1`,
    [accountId]
  );
  if (!rows.length) {
    return { ok: false, error: 'not found' };
  }
  const row = rows[0];
  if (row.platform !== 'x') {
    return { ok: false, error: `platform is ${row.platform}` };
  }
  if (
    row.status === 'banned' ||
    row.status === 'inactive' ||
    row.status === 'session_dead' ||
    row.warmup_status === 'failed'
  ) {
    return {
      ok: false,
      error: `skip banned/inactive (status=${row.status}, warmup=${row.warmup_status})`,
      soft: true,
    };
  }

  const {
    generateXPersona,
    toCredentialsXPersona,
    mergePersonaTraits,
    enrichmentPatchFromPersona,
  } = require('../services/xPersonas');
  const { updateEnrichment } = require('../services/profileEnrichment');

  const creds = parseJson(row.credentials, {});
  if (creds.x_persona?.display_name && creds.x_persona?.bio) {
    // Backfill desired_username if missing, or refresh boring concatenated handles
    const {
      allocateDesiredUsername,
      needsHumanHandle,
    } = require('../services/xPersonas');
    const existingDesired =
      creds.x_persona.desired_username || creds.x_persona.username || null;
    const staleDesired =
      existingDesired &&
      !existingDesired.includes('_') &&
      /^[a-z]+\d+$/i.test(existingDesired);
    if (!existingDesired || staleDesired || process.argv.includes('--refresh-handles')) {
      if (dryRun) {
        return {
          ok: true,
          username: row.username,
          persona: creds.x_persona,
          needsUsername: true,
          dryRun: true,
        };
      }
      const desired = await allocateDesiredUsername(pool, accountId);
      const nextPersona = {
        ...creds.x_persona,
        username: desired,
        desired_username: desired,
        rename_handle: true,
        username_applied: false,
        updated_at: new Date().toISOString(),
      };
      await pool.query(
        `UPDATE social_accounts
         SET credentials = jsonb_set(COALESCE(credentials, '{}'::jsonb), '{x_persona}', $2::jsonb),
             updated_at = NOW()
         WHERE id = $1`,
        [accountId, JSON.stringify(nextPersona)]
      );
      return {
        ok: true,
        username: row.username,
        persona: nextPersona,
        usernameBackfilled: true,
        desired,
      };
    }
    // Ensure desired_username key exists even when username already set
    if (!creds.x_persona.desired_username && creds.x_persona.username) {
      const nextPersona = {
        ...creds.x_persona,
        desired_username: creds.x_persona.username,
        rename_handle: true,
      };
      if (!dryRun) {
        await pool.query(
          `UPDATE social_accounts
           SET credentials = jsonb_set(COALESCE(credentials, '{}'::jsonb), '{x_persona}', $2::jsonb),
               updated_at = NOW()
           WHERE id = $1`,
          [accountId, JSON.stringify(nextPersona)]
        );
      }
      return {
        ok: true,
        username: row.username,
        persona: nextPersona,
        alreadyAssigned: true,
        needsRename: needsHumanHandle(row.username, nextPersona),
      };
    }
    return {
      ok: true,
      username: row.username,
      persona: creds.x_persona,
      alreadyAssigned: true,
      needsRename: needsHumanHandle(row.username, creds.x_persona),
    };
  }

  if (dryRun) {
    return {
      ok: true,
      username: row.username,
      needsAssign: true,
      dryRun: true,
    };
  }

  const { rows: full } = await pool.query(
    `SELECT credentials, persona_traits FROM social_accounts WHERE id = $1`,
    [accountId]
  );
  const existingCreds = parseJson(full[0]?.credentials, {});
  const existingTraits = parseJson(full[0]?.persona_traits, {});
  const persona = generateXPersona(accountId);
  const xPersona = toCredentialsXPersona(persona, { applied_live: false });
  const nextCreds = { ...existingCreds, x_persona: xPersona };
  const nextTraits = mergePersonaTraits(existingTraits, persona);

  await pool.query(
    `UPDATE social_accounts
     SET credentials = $2::jsonb,
         persona_traits = $3::jsonb,
         updated_at = NOW()
     WHERE id = $1`,
    [accountId, JSON.stringify(nextCreds), JSON.stringify(nextTraits)]
  );
  await updateEnrichment(accountId, enrichmentPatchFromPersona(persona), {
    source: 'x_persona_offline',
  });

  return {
    ok: true,
    username: row.username,
    persona: xPersona,
    assignedNow: true,
  };
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms (${label})`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function applyOne(accountId, { withPhoto, withBanner, bannerOnly, restoreMedia, dryRun, timeoutMs }) {
  const ensure = await ensureOfflinePersona(accountId, { dryRun });
  if (!ensure.ok) {
    return {
      accountId,
      success: false,
      soft: !!ensure.soft,
      error: ensure.error,
      class: 'skip',
    };
  }

  if (dryRun) {
    const photoPath =
      withPhoto || restoreMedia ? resolvePhotoPath(accountId) : null;
    const bannerPath =
      withBanner || bannerOnly || restoreMedia ? resolveBannerPath(accountId) : null;
    return {
      accountId,
      success: true,
      dryRun: true,
      username: ensure.username,
      display_name: ensure.persona?.display_name || '(would assign)',
      new_handle: ensure.persona?.username || null,
      photo: !!photoPath,
      banner: !!bannerPath,
      photoPath,
      bannerPath,
      bannerOnly: !!bannerOnly,
      restoreMedia: !!restoreMedia,
      needsAssign: !!ensure.needsAssign,
    };
  }

  let photoPath = null;
  let bannerPath = null;
  if (withPhoto || restoreMedia) {
    photoPath = resolvePhotoPath(accountId);
    if (!photoPath) {
      if (restoreMedia) {
        return {
          accountId,
          success: false,
          soft: true,
          error: 'no portrait in x-photos/linkedin-photos for avatar restore',
          class: 'skip',
        };
      }
      console.warn(`#${accountId}: --with-photo but no file — continuing text-only`);
    }
  }
  if (withBanner || bannerOnly || restoreMedia) {
    bannerPath = resolveBannerPath(accountId);
    if (!bannerPath) {
      return {
        accountId,
        success: false,
        soft: true,
        error: 'no scenic banner in private/x-banners (refusing face fallback)',
        class: 'skip',
      };
    }
  }

  try {
    let applyPromise;
    if (restoreMedia) {
      applyPromise = playwrightService.applyXAvatarAndBannerLive(accountId, {
        photoPath,
        bannerPath,
        requireProxy: true,
      });
    } else if (bannerOnly) {
      applyPromise = playwrightService.applyXBannerLive(accountId, {
        bannerPath,
        requireProxy: true,
      });
    } else {
      applyPromise = playwrightService.applyXPersonaLive(accountId, {
        photoPath,
        bannerPath,
        requireProxy: true,
      });
    }
    const result = await withTimeout(applyPromise, timeoutMs, `account #${accountId}`);
    if (!result?.success) {
      return {
        accountId,
        success: false,
        error: result?.error || 'apply returned without success',
        class: 'verify_failed',
        username: result?.username,
        verified: result?.verified,
        skipped: result?.skipped,
      };
    }
    return {
      accountId,
      success: true,
      username: result.username,
      display_name: result.display_name,
      photo: !!result.photo,
      banner: !!result.banner,
      username_renamed: !!result.username_renamed,
      verified: result.verified,
      skipped: result.skipped,
      bannerPath: result.bannerPath || bannerPath,
      photoPath: result.photoPath || photoPath,
    };
  } catch (err) {
    const msg = err.message || String(err);
    const cls = /timeout after/i.test(msg) ? 'timeout' : classifyApplyError(msg);

    if (cls === 'banned') {
      const organicCommentService = require('../services/organicCommentService');
      await organicCommentService
        .markBannedAccount(accountId, `x_persona_live: ${msg}`)
        .catch(() => {});
      return {
        accountId,
        success: false,
        error: msg,
        class: cls,
        accountMarkedBanned: true,
      };
    }

    if (cls === 'session_dead') {
      // During media restore, tunnel flaps often look like login walls — soft-skip, do not kill account.
      if (restoreMedia || bannerOnly) {
        return {
          accountId,
          success: false,
          error: msg,
          class: cls,
          soft: true,
        };
      }
      const organicCommentService = require('../services/organicCommentService');
      await organicCommentService
        .markDeadSessionAccount(accountId, `x_persona_live: ${msg}`)
        .catch(() => {});
      return {
        accountId,
        success: false,
        error: msg,
        class: cls,
        accountMarkedDead: true,
      };
    }

    return {
      accountId,
      success: false,
      error: msg,
      class: cls,
      soft:
        cls === 'rate_limit' ||
        cls === 'proxy_error' ||
        cls === 'challenge' ||
        cls === 'timeout' ||
        cls === 'needs_password',
    };
  }
}

async function runPool(ids, worker, concurrency) {
  const results = new Array(ids.length);
  let cursor = 0;
  async function workerLoop() {
    while (true) {
      const i = cursor;
      cursor += 1;
      if (i >= ids.length) return;
      const id = ids[i];
      console.log(`\n----- #${id} (slot ${i + 1}/${ids.length}) -----`);
      results[i] = await worker(id);
      const r = results[i];
      if (r.success) {
        const v = r.verified
          ? ` verified[name=${!!r.verified.display_name},bio=${!!r.verified.bio},photo=${!!r.verified.photo},user=${!!r.verified.username},banner=${!!r.verified.banner}]`
          : '';
        console.log(
          `#${id} OK @${r.username || '?'} → ${r.display_name || '?'}` +
            (r.photo ? ' +photo' : '') +
            (r.banner ? ' +banner' : '') +
            (r.username_renamed ? ' +rename' : '') +
            v
        );
      } else {
        console.log(
          `#${id} FAIL [${r.class || '?'}]${r.soft ? ' (soft-skip)' : ''}` +
            `${r.accountMarkedDead ? ' [marked dead]' : ''}` +
            `${r.accountMarkedBanned ? ' [marked banned]' : ''}: ${r.error}`
        );
      }
    }
  }
  const n = Math.max(1, Math.min(concurrency, ids.length));
  await Promise.all(Array.from({ length: n }, () => workerLoop()));
  return results;
}

async function main() {
  if (process.env.X_PERSONA_LIVE !== '1' && !process.argv.includes('--dry-run')) {
    console.error('Refusing: set X_PERSONA_LIVE=1 (or pass --dry-run)');
    process.exit(2);
  }

  const dryRun = process.argv.includes('--dry-run');
  const restoreMedia = process.argv.includes('--restore-media');
  const bannerOnly = !restoreMedia && process.argv.includes('--banner-fix');
  const withPhoto =
    restoreMedia || (!bannerOnly && process.argv.includes('--with-photo'));
  // Do NOT auto-enable banner from --with-photo (that previously uploaded face crops as headers).
  const withBanner =
    restoreMedia || bannerOnly || process.argv.includes('--with-banner');
  const concurrency = Math.max(1, Math.min(5, Number(arg('--concurrency', '4')) || 4));
  // Media restore / banner-only should fail fast: hard timeout default 3m
  const timeoutMs = Math.max(
    60000,
    Number(arg('--timeout-ms', restoreMedia || bannerOnly ? '180000' : '480000')) ||
      (restoreMedia || bannerOnly ? 180000 : 480000)
  );

  if ((withBanner || bannerOnly || restoreMedia) && !BANNER_POOL.length) {
    console.error(
      `No scenic banners in ${BANNER_DIR} — refusing to fall back to portraits. ` +
        'Add 1500x500 landscape JPGs under private/x-banners/ first.'
    );
    process.exit(2);
  }

  const ids = await parseIds();
  if (!ids.length) {
    console.log('No account ids to process');
    await pool.end().catch(() => {});
    process.exit(0);
  }

  const modeLabel = restoreMedia
    ? 'RESTORE avatar+banner'
    : bannerOnly
      ? 'BANNER-ONLY'
      : 'LIVE';
  console.log(
    dryRun
      ? `DRY RUN — would ${restoreMedia ? 'restore media for' : bannerOnly ? 'banner-fix' : 'live-apply X personas to'} ${ids.length} account(s)`
      : `${modeLabel} apply to ${ids.length} account(s) (cookie-only, concurrency=${concurrency}, timeout=${Math.round(timeoutMs / 60000)}m)`
  );
  console.log(
    `Photos: ${withPhoto || restoreMedia ? `yes (pool=${PHOTO_POOL.length})` : 'no'} | Banners: ${
      withBanner || bannerOnly || restoreMedia
        ? `yes (x-banners pool=${BANNER_POOL.length}, faces forbidden)`
        : 'no'
    }\n`
  );

  const results = await runPool(
    ids,
    (id) =>
      applyOne(id, { withPhoto, withBanner, bannerOnly, restoreMedia, dryRun, timeoutMs }),
    concurrency
  );

  console.log('\n===== SUMMARY =====');
  console.table(
    results.map((r) => ({
      id: r.accountId,
      ok: !!r.success,
      soft: !!r.soft,
      banned: !!r.accountMarkedBanned,
      dead: !!r.accountMarkedDead,
      photo: !!r.photo,
      banner: !!r.banner,
      rename: !!r.username_renamed,
      handle: (r.username || '').slice(0, 18),
      name: (r.display_name || '').slice(0, 22),
      err: (r.error || r.class || '').slice(0, 40),
    }))
  );
  const ok = results.filter((r) => r.success).length;
  const banned = results.filter((r) => r.accountMarkedBanned).length;
  const soft = results.filter((r) => !r.success && r.soft).length;
  const hard = results.filter((r) => !r.success && !r.soft).length;
  console.log(
    `Done: ${ok} ok / ${banned} banned / ${soft} soft-skip / ${hard} hard-fail of ${results.length}`
  );
  if (bannerOnly) {
    const sample = results
      .filter((r) => r.success && r.bannerPath)
      .slice(0, 3)
      .map((r) => path.basename(r.bannerPath));
    console.log(`Banner assets used (sample): ${sample.join(', ') || '(none)'}`);
  }
  await pool.end().catch(() => {});
  process.exit(hard > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
