#!/usr/bin/env node
/**
 * Cookie-first LinkedIn smoke for the 2026-07-23 cookie batch.
 *
 * Safety (AGENTS.md — NON-NEGOTIABLE):
 *   - Cookie restore ONLY (allowLogin:false). Never password login on this batch.
 *   - ONE account at a time, human-spaced.
 *   - Any ID-verification / checkpoint => STOP that account + abort whole run.
 *   - Optional --profile builds hiring persona + photo/banner after clean cookie session.
 *
 * Usage:
 *   node src/scripts/smoke-linkedin-cookie-batch.js --limit 1
 *   node src/scripts/smoke-linkedin-cookie-batch.js --limit 3 --profile --space-min 8
 *   node src/scripts/smoke-linkedin-cookie-batch.js --ids 901,902 --profile
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../services/db');
const playwrightService = require('../services/playwrightService');

const BATCH_DEFAULT = '2026-07-23-cookies';
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

function humanName(username) {
  const base = String(username || '')
    .replace(/-\d+[a-z0-9]*$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return base
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ') || 'Professional';
}

function personaFor(accountId, username) {
  const [title, headline] = TITLES[accountId % TITLES.length];
  const company = COMPANIES[(accountId + 1) % COMPANIES.length];
  const about = ABOUTS[accountId % ABOUTS.length];
  return { name: humanName(username), title, headline, company, about };
}

function findPortrait(username) {
  const dirs = [PHOTO_DIR, X_PHOTO_DIR].filter((d) => fs.existsSync(d));
  for (const dir of dirs) {
    for (const ext of ['jpg', 'png']) {
      const p = path.join(dir, `${username}.${ext}`);
      if (fs.existsSync(p)) return p;
    }
  }
  const poolFiles = [];
  for (const dir of dirs) {
    for (const name of fs.readdirSync(dir)) {
      if (/\.(jpe?g|png)$/i.test(name)) poolFiles.push(path.join(dir, name));
    }
  }
  if (!poolFiles.length) return null;
  let h = 0;
  for (const c of username) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return poolFiles[h % poolFiles.length];
}

function findBanner(accountId) {
  const dirs = [LI_BANNER_DIR, X_BANNER_DIR].filter((d) => fs.existsSync(d));
  const poolFiles = [];
  for (const dir of dirs) {
    for (const name of fs.readdirSync(dir)) {
      if (!/\.(jpe?g|png|webp)$/i.test(name)) continue;
      if (/face|portrait|headshot|avatar|pilot/i.test(name)) continue;
      poolFiles.push(path.join(dir, name));
    }
  }
  if (!poolFiles.length) return null;
  return poolFiles[accountId % poolFiles.length];
}

async function markBlocked(accountId, classification, message) {
  // Proxy/tunnel failures are transient — do not freeze the account.
  if (classification === 'connect_error') {
    console.log(`connect_error on #${accountId} — not marking inactive`);
    return;
  }
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

async function classifyPage(page) {
  return page
    .evaluate(() => {
      const text = (document.body?.innerText || '').slice(0, 3000);
      const url = location.href;
      const joinOrSign =
        /Join LinkedIn|Agree & Join|Sign in as |Discover new opportunities/i.test(text) ||
        /\/signup|\/uas\/login|authwall/i.test(url);
      const loggedIn =
        !joinOrSign &&
        (/Start a post|Messaging|My Network|Notifications/i.test(text) ||
          /linkedin\.com\/(feed|in\/|mynetwork|messaging)/i.test(url));
      // Extra: guest chrome always has Join now + Sign in in header
      const guestChrome =
        /Join now/i.test(text) && /Sign in/i.test(text) && !/Start a post/i.test(text);
      return {
        url,
        loggedIn: loggedIn && !guestChrome,
        idWall:
          /Access to your account has been (temporarily )?restricted|verify your identity|government-issued ID|submit a government/i.test(
            text
          ),
        checkpoint: /quick security check|verify you.?re human|I.?m not a robot|reCAPTCHA|checkpoint/i.test(text),
        authwall:
          joinOrSign ||
          guestChrome ||
          (/Sign in|Join now|Welcome Back/i.test(text) && /Email or phone|Forgot password|Continue with Google/i.test(text)) ||
          /\/login|\/authwall|\/uas\//i.test(url),
        snippet: text
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, 5)
          .join(' | '),
      };
    })
    .catch(() => ({ url: page.url(), error: 'eval_failed' }));
}

/**
 * Cookie-only session check. Never password-logs-in.
 * Uses assigned residential proxy + sticky imported UA (android).
 * Optional in-session profile touch (same browser — never flip UA mid-flight).
 */
async function cookieProbe(accountId, { doProfile = false, persona = null } = {}) {
  let browser;
  try {
    await playwrightService.requireProxyForLive(accountId);
    const opened = await playwrightService.createBrowserForAccount(accountId, 2, {
      requireProxy: true,
      forceDesktop: false,
    });
    browser = opened.browser;
    let page = opened.page;
    const acct = await pool.query(`SELECT device_profile, username FROM social_accounts WHERE id=$1`, [
      accountId,
    ]);
    let profile = acct.rows[0]?.device_profile;
    if (typeof profile === 'string') {
      try {
        profile = JSON.parse(profile);
      } catch {
        profile = null;
      }
    }
    if (profile?.sticky_import_ua && profile.platform === 'android') {
      const launchedUa = await page.evaluate(() => navigator.userAgent).catch(() => '');
      if (launchedUa && !/Mobile/i.test(launchedUa)) {
        await browser.close().catch(() => {});
        playwrightService._untrackBrowser(accountId);
        const proxyConfig = await require('../services/proxyService').getNextProxyForAccount(accountId);
        const rebuilt = await playwrightService.createBrowser(proxyConfig, false, profile);
        browser = rebuilt.browser;
        page = rebuilt.page;
        rebuilt.accountId = accountId;
        playwrightService._trackBrowser(accountId, browser);
      }
    }

    const restored = await playwrightService.restoreSession(page, 'linkedin', accountId);
    if (!restored) {
      return { success: false, classification: 'no_cookies', error: 'no session cookies in browser_sessions' };
    }

    await page.goto('https://www.linkedin.com/feed/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await playwrightService.humanLikeDelay(2500, 4500);
    await playwrightService.simulateHumanBehavior(page).catch(() => {});

    let info = await classifyPage(page);
    if (info.idWall) {
      await page.screenshot({ path: `/tmp/li-idwall-${accountId}.png` }).catch(() => {});
      return {
        success: false,
        classification: 'id_verification_required',
        error: 'id_verification_wall',
        url: (info.url || '').slice(0, 80),
        snippet: info.snippet,
      };
    }
    if (info.checkpoint) {
      await page.screenshot({ path: `/tmp/li-checkpoint-${accountId}.png` }).catch(() => {});
      return {
        success: false,
        classification: 'checkpoint',
        error: 'checkpoint_or_captcha',
        url: (info.url || '').slice(0, 80),
        snippet: info.snippet,
      };
    }
    if (info.authwall || !info.loggedIn) {
      await page.goto('https://www.linkedin.com/in/me/', {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      }).catch(() => {});
      await playwrightService.humanLikeDelay(2000, 3500);
      info = await classifyPage(page);
      if (info.idWall) {
        return {
          success: false,
          classification: 'id_verification_required',
          error: 'id_verification_wall',
          url: (info.url || '').slice(0, 80),
          snippet: info.snippet,
        };
      }
      if (info.authwall || /\/login|\/authwall|\/signup|Join LinkedIn/i.test(info.url || '') || /Join LinkedIn/i.test(info.snippet || '')) {
        return {
          success: false,
          classification: 'session_dead',
          error: 'cookie_session_dead',
          url: (info.url || '').slice(0, 80),
          snippet: info.snippet,
        };
      }
      if (!info.loggedIn && !/linkedin\.com\/in\//i.test(info.url || '')) {
        return {
          success: false,
          classification: 'login_failed',
          error: 'not_logged_in_after_cookie',
          url: (info.url || '').slice(0, 80),
          snippet: info.snippet,
        };
      }
    }

    await playwrightService.persistSession(page, 'linkedin', accountId);
    await pool.query(
      `UPDATE social_accounts
       SET warmup_status = 'warmed', warmed_up_at = NOW(), last_used_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [accountId]
    );

    let profileResult = null;
    if (doProfile && persona) {
      profileResult = await mobileProfileTouch(page, accountId, persona);
      // Re-check for ID wall after edits
      const after = await classifyPage(page);
      if (after.idWall) {
        return {
          success: false,
          classification: 'id_verification_required',
          error: 'id_wall_after_profile',
          url: (after.url || '').slice(0, 80),
          profile: profileResult,
        };
      }
      // Only persist after confirmed still logged-in (never overwrite li_at with guest cookies)
      const stillIn = after.loggedIn || /linkedin\.com\/in\//i.test(after.url || '');
      if (stillIn) await playwrightService.persistSession(page, 'linkedin', accountId);
    }

    return {
      success: true,
      classification: 'ok',
      url: (info.url || page.url()).slice(0, 80),
      snippet: info.snippet,
      profile: profileResult,
    };
  } catch (e) {
    const cls = playwrightService.classifyLinkedInLoginFailure(e.message);
    return { success: false, classification: cls, error: (e.message || String(e)).slice(0, 200) };
  } finally {
    if (browser) await browser.close().catch(() => {});
    playwrightService._untrackBrowser(accountId);
  }
}

/** Best-effort mobile intro/about edit in the already-open cookie session. */
async function mobileProfileTouch(page, accountId, persona) {
  const steps = [];
  try {
    await page.goto('https://www.linkedin.com/in/me/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await playwrightService.humanLikeDelay(2500, 4000);

    // Open intro editor — mobile often uses "Edit" / pencil near name/headline
    const opened = await page.evaluate(() => {
      const els = [...document.querySelectorAll('a, button, [role="button"]')];
      const hit = els.find((e) => {
        const t = `${e.getAttribute('aria-label') || ''} ${e.innerText || ''}`.trim();
        if (!/edit (intro|profile)|edit headline|pencil|Edit$/i.test(t) && !/edit intro/i.test(t)) {
          return false;
        }
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (hit) {
        hit.click();
        return (hit.getAttribute('aria-label') || hit.innerText || 'edit').trim().slice(0, 40);
      }
      return null;
    });
    if (opened) {
      steps.push(`open:${opened}`);
      await playwrightService.humanLikeDelay(2000, 3500);
    } else {
      await page.goto('https://www.linkedin.com/in/me/edit/intro/', {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      }).catch(() => {});
      await playwrightService.humanLikeDelay(2000, 3500);
      steps.push('nav:edit/intro');
    }

    await page.screenshot({ path: `/tmp/li-mobile-intro-${accountId}.png` }).catch(() => {});

    // Fill first visible contenteditable / textarea / headline-ish input
    const filled = await page.evaluate((headline) => {
      const candidates = [
        ...document.querySelectorAll(
          'div[role="textbox"][contenteditable="true"], textarea, input[name*="headline" i], input[id*="headline" i], input[aria-label*="Headline" i], input[aria-label*="headline" i]'
        ),
      ].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (!candidates.length) return false;
      const el = candidates[0];
      el.focus();
      if (el.isContentEditable) {
        el.textContent = '';
        el.textContent = headline;
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      } else {
        el.value = headline;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    }, persona.headline);

    if (filled) {
      steps.push('headline');
      await playwrightService.humanLikeDelay(800, 1500);
      const saved = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button, [role="button"]')];
        const b = buttons.find((x) => {
          if (!/^(Save|Save changes|Done|Continue)$/i.test((x.innerText || '').trim()) || x.disabled) {
            return false;
          }
          const r = x.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (b) {
          b.click();
          return (b.innerText || '').trim();
        }
        return null;
      });
      if (saved) {
        steps.push(`save:${saved}`);
        await playwrightService.humanLikeDelay(2500, 4000);
      }
    } else {
      steps.push('headline_missing');
    }

    // About
    await page.goto('https://www.linkedin.com/in/me/edit/forms/summary/', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    }).catch(() => {});
    await playwrightService.humanLikeDelay(2000, 3500);
    const aboutOk = await page.evaluate((about) => {
      const el = [...document.querySelectorAll('div[role="textbox"][contenteditable="true"], textarea')].find(
        (e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }
      );
      if (!el) return false;
      el.focus();
      if (el.isContentEditable) {
        el.textContent = about;
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      } else {
        el.value = about;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    }, persona.about);
    if (aboutOk) {
      steps.push('about');
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) =>
          /^(Save|Save changes|Done)$/i.test((x.innerText || '').trim())
        );
        if (b) b.click();
      });
      await playwrightService.humanLikeDelay(2000, 3500);
    }

    await page.screenshot({ path: `/tmp/li-mobile-profile-done-${accountId}.png` }).catch(() => {});

    const ok = steps.includes('headline') || steps.includes('about');
    if (ok) {
      await pool.query(
        `UPDATE social_accounts
         SET profile_enrichment = COALESCE(profile_enrichment, '{}'::jsonb) || $2::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        [
          accountId,
          JSON.stringify({
            persona: {
              title: persona.title,
              headline: persona.headline,
              company: persona.company,
              at: new Date().toISOString(),
              via: 'mobile_cookie_session',
            },
          }),
        ]
      );
    }
    return { success: ok, steps };
  } catch (e) {
    return { success: false, steps, error: (e.message || String(e)).slice(0, 120) };
  }
}

async function selectAccounts({ ids, limit, batch }) {
  if (ids && ids.length) {
    const { rows } = await pool.query(
      `SELECT id, email, username, warmup_status
       FROM social_accounts
       WHERE platform = 'linkedin' AND id = ANY($1::int[])
       ORDER BY id`,
      [ids]
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT sa.id, sa.email, sa.username, sa.warmup_status
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
  const opts = {
    limit: 1,
    spaceMin: 6,
    profile: false,
    ids: null,
    batch: BATCH_DEFAULT,
    abortBlocks: 1, // stop on first ID wall / hard fail for cookie batch
  };
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

async function spaceOut(minutes) {
  const jitterMs = Math.floor(minutes * 60000 * (0.8 + Math.random() * 0.6));
  console.log(`... spacing ~${Math.round(jitterMs / 60000)}m before next (human pacing) ...`);
  await sleep(jitterMs);
}

async function main() {
  const opts = parseArgs();
  const accounts = await selectAccounts(opts);
  if (!accounts.length) {
    console.log('No eligible cookie-batch accounts.');
    await pool.end().catch(() => {});
    return;
  }
  console.log(
    `Cookie-smoke ${accounts.length} acct(s) batch=${opts.batch} profile=${opts.profile} space=${opts.spaceMin}m abort=${opts.abortBlocks}`
  );

  const results = [];
  let blocks = 0;

  for (let i = 0; i < accounts.length; i++) {
    const acct = accounts[i];
    console.log(`\n=== #${acct.id} ${acct.username} / ${acct.email} (cookie-only, proxy) ===`);

    const persona = opts.profile ? personaFor(acct.id, acct.username) : null;
    if (persona) console.log(`profile plan: ${persona.title} @ ${persona.company} (same-session mobile)`);

    const probe = await cookieProbe(acct.id, { doProfile: opts.profile, persona });
    console.log(
      `probe: ${JSON.stringify({
        ok: probe.success,
        class: probe.classification,
        err: (probe.error || '').slice(0, 80),
        url: probe.url,
        profile: probe.profile
          ? { ok: probe.profile.success, steps: probe.profile.steps }
          : opts.profile
            ? null
            : 'skipped',
      })}`
    );

    if (!probe.success) {
      await markBlocked(acct.id, probe.classification || 'login_failed', probe.error);
      results.push({
        id: acct.id,
        username: acct.username,
        login: false,
        classification: probe.classification,
        profile: probe.profile || null,
      });
      const catastrophic = probe.classification === 'id_verification_required';
      // Soft-skip dead cookies; only count hard failures toward abort, and always
      // stop the whole run on ID-verification.
      const countsTowardAbort =
        catastrophic ||
        (probe.classification !== 'session_dead' &&
          probe.classification !== 'no_cookies' &&
          probe.classification !== 'connect_error');
      if (countsTowardAbort) blocks += 1;
      if (catastrophic || (countsTowardAbort && blocks >= opts.abortBlocks)) {
        console.warn(
          `\n!!! STOPPING: ${catastrophic ? 'ID-verification' : `${blocks} hard failures`} — preserving rest of batch.`
        );
        break;
      }
      console.log(`soft-skip ${probe.classification} — continuing batch`);
      if (i < accounts.length - 1) await spaceOut(opts.spaceMin);
      continue;
    }

    results.push({
      id: acct.id,
      username: acct.username,
      login: true,
      classification: 'ok',
      profile: opts.profile ? !!(probe.profile && probe.profile.success) : 'skipped',
    });

    if (i < accounts.length - 1) await spaceOut(opts.spaceMin);
  }

  console.log('\n===== COOKIE BATCH SUMMARY =====');
  console.table(
    results.map((r) => ({
      id: r.id,
      user: (r.username || '').slice(0, 28),
      login: r.login,
      class: r.classification,
      profile: r.profile,
    }))
  );
  await pool.end().catch(() => {});
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});
