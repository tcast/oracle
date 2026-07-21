const pool = require('./db');
const playwrightService = require('./playwrightService');
const proxyService = require('./proxyService');
const emailInboxService = require('./emailInboxService');
const { generatePassword } = require('../utils/passwordGenerator');
const { classifyFailure, cooldownUntil } = require('./failureClassifier');

const BOUGHT_SOURCES = ['excel_import', 'bulk_import'];
// www /account/forgotpassword/ is network-security blocked on many residential/mobile
// proxies; old.reddit password recovery still renders the form.
const FORGOT_URL = 'https://old.reddit.com/password/';
const FORGOT_URL_FALLBACK = 'https://www.reddit.com/account/forgotpassword/';

function parseCreds(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw;
}

function providerFromEmail(email) {
  const domain = String(email || '')
    .split('@')[1]
    ?.toLowerCase() || '';
  if (domain.includes('hotmail')) return 'hotmail';
  if (domain.includes('outlook') || domain.includes('live.')) return 'outlook';
  if (domain.includes('yahoo')) return 'yahoo';
  if (domain.includes('gmx')) return 'gmx';
  return null;
}

class RedditPasswordResetService {
  async getSettings() {
    const result = await pool.query('SELECT * FROM reddit_password_reset_settings WHERE id = 1');
    if (result.rows[0]) return result.rows[0];
    const inserted = await pool.query(
      `INSERT INTO reddit_password_reset_settings (id, enabled)
       VALUES (1, false)
       ON CONFLICT (id) DO UPDATE SET updated_at = NOW()
       RETURNING *`
    );
    return inserted.rows[0];
  }

  async updateSettings(patch = {}) {
    const current = await this.getSettings();
    const enabled = patch.enabled !== undefined ? !!patch.enabled : current.enabled;
    const max_per_day = patch.max_per_day ?? current.max_per_day;
    const max_concurrent = patch.max_concurrent ?? current.max_concurrent;
    const rotate_every_days = patch.rotate_every_days ?? current.rotate_every_days;
    const quiet_hours_start = patch.quiet_hours_start ?? current.quiet_hours_start;
    const quiet_hours_end = patch.quiet_hours_end ?? current.quiet_hours_end;
    const sources = Array.isArray(patch.sources) && patch.sources.length
      ? patch.sources
      : current.sources || BOUGHT_SOURCES;

    if (max_per_day < 1 || max_per_day > 10) {
      throw new Error('max_per_day must be between 1 and 10');
    }
    if (max_concurrent < 1 || max_concurrent > 3) {
      throw new Error('max_concurrent must be between 1 and 3');
    }
    if (rotate_every_days < 7 || rotate_every_days > 180) {
      throw new Error('rotate_every_days must be between 7 and 180');
    }

    const result = await pool.query(
      `UPDATE reddit_password_reset_settings
       SET enabled = $1,
           max_per_day = $2,
           max_concurrent = $3,
           rotate_every_days = $4,
           quiet_hours_start = $5,
           quiet_hours_end = $6,
           sources = $7,
           updated_at = NOW()
       WHERE id = 1
       RETURNING *`,
      [
        enabled,
        max_per_day,
        max_concurrent,
        rotate_every_days,
        quiet_hours_start,
        quiet_hours_end,
        sources,
      ]
    );
    return result.rows[0];
  }

  inQuietHours(settings) {
    const start = settings.quiet_hours_start;
    const end = settings.quiet_hours_end;
    if (start == null || end == null) return false;
    const hour = new Date().getHours();
    if (start === end) return false;
    if (start < end) return hour >= start && hour < end;
    return hour >= start || hour < end;
  }

  emailAccountFromSocial(account, creds) {
    const email = account.email || creds.email;
    const password = creds.email_password;
    if (!email || !password) return null;
    return {
      email,
      password,
      provider: providerFromEmail(email),
      metadata: {},
      status: 'active',
    };
  }

  async classifyAccount(account, settings = null) {
    const cfg = settings || (await this.getSettings());
    const sources = cfg.sources || BOUGHT_SOURCES;
    const creds = parseCreds(account.credentials);
    const source = creds.source || null;
    const isBought = sources.includes(source);
    const email = account.email || creds.email || null;
    const emailPassword = creds.email_password || null;
    const hasInlineInbox = !!(email && emailPassword);
    const hasLinkedEmail = !!account.email_account_id;

    let linkedEmailOk = false;
    if (hasLinkedEmail) {
      const ea = await pool.query(
        `SELECT id, email, password FROM email_accounts WHERE id = $1`,
        [account.email_account_id]
      );
      linkedEmailOk = !!(ea.rows[0]?.password && ea.rows[0]?.email);
    }

    const proxies = await proxyService.getAccountProxies(account.id, false);
    const activeProxy = proxies.find((p) => p.is_active !== false) || proxies[0] || null;
    const proxyHealthy = activeProxy ? proxyService.isAssignableProxy(activeProxy) : false;

    let inboxClass = 'no_email';
    if (hasLinkedEmail && linkedEmailOk) inboxClass = 'linked_email_account';
    else if (hasInlineInbox) inboxClass = 'inline_email_password';
    else if (email) inboxClass = 'email_no_password';

    const eligible =
      account.status === 'active' &&
      !account.is_simulated &&
      isBought &&
      (hasInlineInbox || linkedEmailOk) &&
      proxyHealthy &&
      !!creds.password &&
      creds.password !== 'default_password';

    let ineligibleReason = null;
    if (!isBought) ineligibleReason = 'not_bought_source';
    else if (account.status !== 'active') ineligibleReason = `status_${account.status}`;
    else if (!(hasInlineInbox || linkedEmailOk)) ineligibleReason = inboxClass;
    else if (!proxyHealthy) ineligibleReason = activeProxy ? 'proxy_unhealthy' : 'no_proxy';
    else if (!creds.password || creds.password === 'default_password') {
      ineligibleReason = 'missing_reddit_password';
    }

    const lastRotated = creds.password_rotated_at
      ? new Date(creds.password_rotated_at)
      : null;

    return {
      accountId: account.id,
      username: account.username,
      email,
      emailDomain: email ? String(email).split('@')[1]?.toLowerCase() : null,
      source,
      status: account.status,
      inboxClass,
      hasInlineInbox,
      hasLinkedEmail,
      linkedEmailOk,
      proxyId: activeProxy?.id || null,
      proxyHealthy,
      eligible,
      ineligibleReason,
      lastRotatedAt: lastRotated ? lastRotated.toISOString() : null,
      daysSinceRotate: lastRotated
        ? Math.floor((Date.now() - lastRotated.getTime()) / (24 * 60 * 60 * 1000))
        : null,
    };
  }

  async eligibilityReport({ limit = 500 } = {}) {
    const settings = await this.getSettings();
    const sources = settings.sources || BOUGHT_SOURCES;
    const { rows } = await pool.query(
      `SELECT id, username, email, email_account_id, credentials, status, is_simulated
       FROM social_accounts
       WHERE platform = 'reddit'
         AND COALESCE(is_simulated, false) = false
       ORDER BY id
       LIMIT $1`,
      [limit]
    );

    const classified = [];
    for (const row of rows) {
      classified.push(await this.classifyAccount(row, settings));
    }

    const bought = classified.filter((c) => sources.includes(c.source));
    const activeBought = bought.filter((c) => c.status === 'active');
    const eligible = activeBought.filter((c) => c.eligible);
    const ineligible = activeBought.filter((c) => !c.eligible);

    const byInbox = {};
    const byReason = {};
    const byDomain = {};
    for (const c of activeBought) {
      byInbox[c.inboxClass] = (byInbox[c.inboxClass] || 0) + 1;
      byDomain[c.emailDomain || 'none'] = (byDomain[c.emailDomain || 'none'] || 0) + 1;
      if (!c.eligible) {
        byReason[c.ineligibleReason || 'unknown'] =
          (byReason[c.ineligibleReason || 'unknown'] || 0) + 1;
      }
    }

    return {
      settings: {
        enabled: settings.enabled,
        max_per_day: settings.max_per_day,
        max_concurrent: settings.max_concurrent,
        rotate_every_days: settings.rotate_every_days,
        sources,
      },
      totals: {
        reddit_all: classified.length,
        bought_all: bought.length,
        bought_active: activeBought.length,
        eligible: eligible.length,
        ineligible: ineligible.length,
      },
      byInbox,
      byDomain,
      ineligibleReasons: byReason,
      sampleEligible: eligible.slice(0, 10),
      sampleIneligible: ineligible.slice(0, 10),
    };
  }

  async listEligibleAccounts() {
    const settings = await this.getSettings();
    const sources = settings.sources || BOUGHT_SOURCES;
    const { rows } = await pool.query(
      `SELECT sa.*
       FROM social_accounts sa
       WHERE sa.platform = 'reddit'
         AND sa.status = 'active'
         AND COALESCE(sa.is_simulated, false) = false
         AND sa.credentials->>'source' = ANY($1::text[])
         AND COALESCE(sa.email, '') <> ''
         AND (
           COALESCE(sa.credentials->>'email_password', '') <> ''
           OR sa.email_account_id IS NOT NULL
         )
         AND COALESCE(sa.credentials->>'password', '') NOT IN ('', 'default_password')
       ORDER BY sa.id`,
      [sources]
    );

    const out = [];
    for (const row of rows) {
      const info = await this.classifyAccount(row, settings);
      if (info.eligible) out.push({ ...row, _eligibility: info });
    }
    return out;
  }

  async ensureJob(accountId) {
    const existing = await pool.query(
      `SELECT * FROM reddit_password_reset_jobs WHERE social_account_id = $1`,
      [accountId]
    );
    if (existing.rows[0]) return existing.rows[0];
    const inserted = await pool.query(
      `INSERT INTO reddit_password_reset_jobs (social_account_id, enabled, next_due_at)
       VALUES ($1, true, NOW())
       ON CONFLICT (social_account_id) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [accountId]
    );
    return inserted.rows[0];
  }

  async ensureJobsForEligible() {
    const accounts = await this.listEligibleAccounts();
    for (const a of accounts) {
      await this.ensureJob(a.id);
    }
    return { ensured: accounts.length };
  }

  async refreshDayState(job, settings) {
    const today = new Date().toISOString().slice(0, 10);
    if (job.day_key && String(job.day_key).slice(0, 10) === today) return job;
    const result = await pool.query(
      `UPDATE reddit_password_reset_jobs
       SET day_key = $2::date,
           resets_today = 0,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [job.id, today]
    );
    return result.rows[0];
  }

  async markRunning(jobId) {
    await pool.query(
      `UPDATE reddit_password_reset_jobs
       SET status = 'running', updated_at = NOW()
       WHERE id = $1`,
      [jobId]
    );
  }

  /**
   * Recover jobs left status=running after crash/OOM during Outlook poll.
   * Without this, already_running skips them forever (even after schedule re-enable).
   */
  async reclaimStaleRunningJobs(staleMinutes = 40) {
    const result = await pool.query(
      `UPDATE reddit_password_reset_jobs
       SET status = 'idle',
           last_error = COALESCE(last_error, 'reclaimed_stale_running'),
           cooldown_until = NOW() + INTERVAL '2 hours',
           next_due_at = NOW() + INTERVAL '2 hours',
           updated_at = NOW()
       WHERE status = 'running'
         AND updated_at < NOW() - ($1::int * INTERVAL '1 minute')
       RETURNING id, social_account_id`,
      [staleMinutes]
    );
    if (result.rows.length) {
      console.warn(
        `Reclaimed ${result.rows.length} stale password-reset running job(s):`,
        result.rows.map((r) => r.social_account_id)
      );
    }
    return result.rows;
  }

  async markSuccess(job, settings) {
    const rotateDays = settings.rotate_every_days || 30;
    const next = new Date(Date.now() + rotateDays * 24 * 60 * 60 * 1000);
    await pool.query(
      `UPDATE reddit_password_reset_jobs
       SET status = 'idle',
           last_error = NULL,
           last_reset_at = NOW(),
           resets_today = resets_today + 1,
           consecutive_failures = 0,
           failure_class = NULL,
           cooldown_until = NULL,
           next_due_at = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [job.id, next.toISOString()]
    );
  }

  async markFailure(job, err) {
    const failureClass = classifyFailure(err);
    const consecutive = (job.consecutive_failures || 0) + 1;
    const until = cooldownUntil(failureClass, consecutive);
    await pool.query(
      `UPDATE reddit_password_reset_jobs
       SET status = 'idle',
           last_error = $2,
           consecutive_failures = $3,
           failure_class = $4,
           cooldown_until = $5,
           next_due_at = $5,
           updated_at = NOW()
       WHERE id = $1`,
      [job.id, String(err.message || err).slice(0, 500), consecutive, failureClass, until]
    );
    return failureClass;
  }

  async logAction(accountId, proxyId, status, detail = {}, error = null) {
    await pool.query(
      `INSERT INTO reddit_password_reset_actions
         (social_account_id, proxy_id, status, detail, error)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [accountId, proxyId || null, status, JSON.stringify(detail), error]
    );
  }

  async resolveInboxAccount(account, creds) {
    if (account.email_account_id) {
      try {
        return await emailInboxService.getAccountById(account.email_account_id);
      } catch (_) {
        /* fall through to inline */
      }
    }
    return this.emailAccountFromSocial(account, creds);
  }

  async dismissCookieBanners(page) {
    for (const label of ['Accept all', 'Accept', 'I agree', 'Continue']) {
      const btn = await page.$(`button:has-text("${label}")`);
      if (btn) {
        await btn.click().catch(() => {});
        await playwrightService.humanLikeDelay(400, 900);
      }
    }
  }

  async triggerForgotPassword(page, emailOrUsername) {
    const tryUrl = async (url) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await playwrightService.humanLikeDelay(2000, 3500);
      await this.dismissCookieBanners(page);
      const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 400);
      if (/blocked by network security/i.test(body)) {
        throw new Error(`Reddit network-security block on ${url}`);
      }
      return body;
    };

    let landingSnippet = '';
    try {
      landingSnippet = await tryUrl(FORGOT_URL);
    } catch (err) {
      console.warn(`Forgot via ${FORGOT_URL} failed (${err.message}); trying fallback`);
      landingSnippet = await tryUrl(FORGOT_URL_FALLBACK);
    }

    const input = page
      .locator(
        'faceplate-text-input[name="identifier"] input, faceplate-text-input#auth-password-recovery-input input, input[name="identifier"], input[name="email"], input[name="username"], input[type="email"], input[type="text"]'
      )
      .first();
    await input.waitFor({ state: 'visible', timeout: 25000 });
    await input.click({ clickCount: 3 }).catch(() => {});
    await input.fill('');
    await input.type(emailOrUsername, { delay: 55 });
    await playwrightService.humanLikeDelay(600, 1200);

    const submit =
      (await page.$('button:has-text("Reset password")')) ||
      (await page.$('button:has-text("Reset")')) ||
      (await page.$('button[type="submit"]')) ||
      (await page.$('button:has-text("Email")')) ||
      (await page.$('button:has-text("Continue")'));
    if (!submit) throw new Error('Forgot-password submit button not found');
    await submit.click();
    await playwrightService.humanLikeDelay(2500, 4500);

    const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 600);
    const looksOk = /email|sent|check|inbox|link|reset|recover/i.test(body);
    const looksBlocked = /too many|rate.?limit|try again later|blocked|suspicious/i.test(body);
    if (looksBlocked) {
      throw new Error(`Reddit forgot-password blocked: ${body.slice(0, 180)}`);
    }
    if (!looksOk) {
      throw new Error(
        `Reddit forgot-password did not confirm email send: ${body.slice(0, 220)}`
      );
    }
    return {
      confirmationSnippet: body.slice(0, 240),
      looksOk,
      landingSnippet: landingSnippet.slice(0, 120),
      url: page.url(),
    };
  }

  normalizeResetLink(resetLink) {
    try {
      const u = new URL(resetLink);
      if (!/reddit\.com$/i.test(u.hostname) && !/\.reddit\.com$/i.test(u.hostname)) {
        return [resetLink];
      }
      const path = `${u.pathname}${u.search}${u.hash}`;
      // www/new reddit password pages are often network-security blocked on
      // residential proxies; old.reddit usually still serves the form.
      return [
        `https://old.reddit.com${path}`,
        `https://www.reddit.com${path}`,
        resetLink,
      ].filter((v, i, arr) => arr.indexOf(v) === i);
    } catch {
      return [resetLink];
    }
  }

  async completePasswordReset(page, resetLink, newPassword) {
    const candidates = this.normalizeResetLink(resetLink);
    let lastSnippet = '';
    let landed = false;

    for (const url of candidates) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await playwrightService.humanLikeDelay(2000, 4000);
      await this.dismissCookieBanners(page);
      const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 400);
      lastSnippet = body;
      if (/blocked by network security/i.test(body)) {
        console.warn(`Reset page network-security block on ${url}; trying next host`);
        continue;
      }
      landed = true;
      break;
    }
    if (!landed) {
      throw new Error(`Password fields not found on reset page: ${lastSnippet.slice(0, 280)}`);
    }

    const pwInputs = page.locator(
      'input[type="password"], faceplate-text-input[name*="password" i] input, input[name*="password" i]'
    );
    let count = await pwInputs.count();
    if (count < 1) {
      // old.reddit sometimes uses name=new_password / verify_password
      const alt = page.locator('input[name*="pass" i], input[id*="pass" i]');
      count = await alt.count();
      if (count < 1) {
        const snippet = (await page.locator('body').innerText().catch(() => '')).slice(0, 300);
        throw new Error(`Password fields not found on reset page: ${snippet}`);
      }
      await alt.nth(0).click({ clickCount: 3 }).catch(() => {});
      await alt.nth(0).fill('');
      await alt.nth(0).type(newPassword, { delay: 45 });
      await playwrightService.humanLikeDelay(400, 900);
      if (count >= 2) {
        await alt.nth(1).click({ clickCount: 3 }).catch(() => {});
        await alt.nth(1).fill('');
        await alt.nth(1).type(newPassword, { delay: 45 });
        await playwrightService.humanLikeDelay(400, 900);
      }
    } else {
      await pwInputs.nth(0).click({ clickCount: 3 }).catch(() => {});
      await pwInputs.nth(0).fill('');
      await pwInputs.nth(0).type(newPassword, { delay: 45 });
      await playwrightService.humanLikeDelay(400, 900);

      if (count >= 2) {
        await pwInputs.nth(1).click({ clickCount: 3 }).catch(() => {});
        await pwInputs.nth(1).fill('');
        await pwInputs.nth(1).type(newPassword, { delay: 45 });
        await playwrightService.humanLikeDelay(400, 900);
      }
    }

    const save =
      (await page.$('button[type="submit"]')) ||
      (await page.$('button:has-text("Save")')) ||
      (await page.$('button:has-text("Set")')) ||
      (await page.$('button:has-text("Change")')) ||
      (await page.$('button:has-text("Continue")')) ||
      (await page.$('input[type="submit"]'));
    if (!save) throw new Error('Save-password button not found');
    await save.click();
    await playwrightService.humanLikeDelay(3000, 5500);

    const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 500);
    const failed = /invalid|expired|error|try again|incorrect/i.test(body) &&
      !/success|updated|changed|logged in|home|password has been/i.test(body);
    if (failed) {
      throw new Error(`Password save may have failed: ${body.slice(0, 200)}`);
    }
    return { url: page.url(), snippet: body.slice(0, 200) };
  }

  async persistNewPassword(accountId, creds, newPassword, source = 'reddit_password_reset_loop') {
    const next = {
      ...creds,
      password: newPassword,
      password_rotated_at: new Date().toISOString(),
      password_rotation_source: source,
    };
    // Keep one previous password for rollback during pilot — not a full history.
    if (creds.password && creds.password !== newPassword) {
      next.previous_password = creds.password;
    }
    await pool.query(
      `UPDATE social_accounts
       SET credentials = $2::jsonb,
           updated_at = NOW()
       WHERE id = $1`,
      [accountId, JSON.stringify(next)]
    );
  }

  async loginOldRedditPassword(page, username, password) {
    await page.goto('https://old.reddit.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });
    await playwrightService.humanLikeDelay(2000, 3500);
    await this.dismissCookieBanners(page);

    const body0 = (await page.locator('body').innerText().catch(() => '')).slice(0, 300);
    if (/blocked by network security|blocked due to a network policy/i.test(body0)) {
      return { ok: false, blocked: true, snippet: body0.slice(0, 160) };
    }

    const user = page.locator('#user_login, input[name="user"]').first();
    const pass = page.locator('#passwd_login, input[name="passwd"]').first();
    const userVisible = await user.isVisible().catch(() => false);
    if (!userVisible) {
      // New Reddit login shell sometimes serves on /login
      const user2 = page.locator('input[name="username"], input[autocomplete="username"]').first();
      const pass2 = page.locator('input[name="password"], input[type="password"]').first();
      if (!(await user2.isVisible().catch(() => false))) {
        return { ok: false, reason: 'login_form_missing', snippet: body0.slice(0, 160) };
      }
      await user2.fill(username);
      await pass2.fill(password);
      const submit2 =
        (await page.$('button:has-text("Log In")')) ||
        (await page.$('button[type="submit"]'));
      if (submit2) await submit2.click();
      else await page.keyboard.press('Enter');
    } else {
      await user.fill(username);
      await pass.fill(password);
      const submit =
        (await page.$('#login_login button[type="submit"], button.btn, input[type="submit"]')) ||
        (await page.$('button[type="submit"]')) ||
        (await page.$('input[type="submit"]'));
      if (submit) await submit.click();
      else await page.keyboard.press('Enter');
    }
    await playwrightService.humanLikeDelay(4500, 7500);

    await page.goto('https://old.reddit.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await playwrightService.humanLikeDelay(1500, 2500);
    return page.evaluate(() => {
      const header = document.querySelector('#header-bottom-right');
      const logout = header?.querySelector('form.logout, a[href*="logout"]');
      const userLink = header?.querySelector('.user a, span.user a');
      const userText = (userLink?.textContent || '').trim();
      const looksLoggedIn =
        !!logout && !!userText && !/^log\s*in$/i.test(userText) && !/^sign\s*up$/i.test(userText);
      const text = (document.body?.innerText || '').slice(0, 500);
      return {
        ok: looksLoggedIn,
        user: looksLoggedIn ? userText : null,
        snippet: text.slice(0, 160),
      };
    });
  }

  /**
   * Change password while logged in via old.reddit prefs /api/update_password.
   * Bound Hotmail often never receives Reddit reset mail even when email matches;
   * this is the reliable protection path for accounts we can still log into.
   */
  async changePasswordInSession(page, currentPassword, newPassword) {
    // old.reddit prefs needs cookies valid on old.reddit — www session alone may not suffice.
    await page.goto('https://old.reddit.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });
    await playwrightService.humanLikeDelay(1500, 2500);
    await this.dismissCookieBanners(page);

    const oldAuth = await page.evaluate(() => {
      const userLink = document.querySelector('#header-bottom-right .user a, span.user a');
      const logout = document.querySelector('form.logout, a[href*="logout"]');
      return {
        user: userLink?.textContent?.trim() || null,
        loggedIn: !!(userLink && logout),
      };
    });
    if (!oldAuth.loggedIn) {
      throw new Error('Not logged in on old.reddit (www session did not carry over)');
    }

    await page.goto('https://old.reddit.com/prefs/update/', {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });
    await playwrightService.humanLikeDelay(2000, 3500);
    await this.dismissCookieBanners(page);

    const body0 = (await page.locator('body').innerText().catch(() => '')).slice(0, 400);
    if (/blocked by network security/i.test(body0)) {
      throw new Error('old.reddit prefs blocked by network security');
    }

    const curVisible = await page.locator('input[name="curpass"]').first().isVisible().catch(() => false);
    if (!curVisible) {
      throw new Error(`prefs/update missing curpass field: ${body0.slice(0, 180)}`);
    }

    const modhash = await page.evaluate(() => {
      if (window.reddit && window.reddit.modhash) return window.reddit.modhash;
      const m = document.body.innerHTML.match(/modhash["']\s*:\s*["']([^"']+)/);
      if (m) return m[1];
      const inp = document.querySelector('input[name="uh"]');
      return inp ? inp.value : null;
    });
    if (!modhash) throw new Error('Reddit modhash not found on prefs page');

    // Prefer JSON API — form submit is flaky (wrong button / silent validation).
    // Legacy reddit: POST /api/update_password or /api/update with curpass/newpass/verpass.
    const postUpdate = async (path) =>
      page.evaluate(
        async ({ path, curpass, newpass, verpass, uh }) => {
          const body = new URLSearchParams({
            curpass,
            newpass,
            verpass,
            uh,
            api_type: 'json',
          });
          const res = await fetch(path, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
              'x-modhash': uh,
            },
            body: body.toString(),
          });
          const text = await res.text();
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {
            /* html */
          }
          return { path, status: res.status, text: text.slice(0, 800), json };
        },
        {
          path,
          curpass: currentPassword,
          newpass: newPassword,
          verpass: newPassword,
          uh: modhash,
        }
      );

    let apiResult = await postUpdate('/api/update_password');
    const firstBlob = JSON.stringify(apiResult.json || apiResult.text || '');
    if (/404|not found|does not exist/i.test(firstBlob) || apiResult.status === 404) {
      apiResult = await postUpdate('/api/update');
    }

    // While still logged in, record visible status only — do NOT submit the
    // prefs form (it often posts to /post/update_email and 403s).
    const statusBits = await page.evaluate(() => {
      const statuses = [...document.querySelectorAll('.status, #status, .error, .success')]
        .map((el) => (el.textContent || '').trim())
        .filter(Boolean);
      const body = (document.body?.innerText || '').slice(0, 1200);
      return { statuses, bodySnippet: body.slice(0, 400), url: location.href };
    });

    const combinedStatus = `${statusBits.statuses.join(' ')} ${statusBits.bodySnippet}`.toLowerCase();
    const formOk = /password has been updated|preferences have been updated/i.test(combinedStatus);
    const formBad = /wrong password|incorrect password|bad password/i.test(combinedStatus);

    const apiJson = apiResult.json;
    const nested = apiJson?.json || apiJson;
    const errList = Array.isArray(nested?.errors) ? nested.errors : null;
    const blob = JSON.stringify(apiJson || apiResult.text || '').toLowerCase();
    const apiOkEmptyErrors = Array.isArray(errList) && errList.length === 0;
    const apiOkMessage = /password has been updated|preferences have been updated/i.test(blob);
    const apiRejected =
      (Array.isArray(errList) && errList.length > 0) ||
      /wrong.?password|incorrect password|bad_password|bad password match/i.test(blob);

    if (formBad || (apiRejected && !apiOkMessage && !formOk)) {
      throw new Error(
        `In-session password change rejected: status=${combinedStatus.slice(0, 180)} api=${blob.slice(0, 180)}`
      );
    }

    if (formOk || apiOkMessage) {
      return {
        url: page.url(),
        method: formOk ? 'prefs_status' : 'api_update_password',
        snippet: formOk ? combinedStatus.slice(0, 200) : blob.slice(0, 200),
        apiResult,
        statusBits,
      };
    }

    // Ambiguous: API empty errors without visible status — persist path still
    // treats this as accepted because wrong curpass returns WRONG_PASSWORD.
    if (apiOkEmptyErrors) {
      return {
        url: page.url(),
        method: 'api_empty_errors_unverified',
        snippet: blob.slice(0, 200),
        apiResult,
        statusBits,
      };
    }

    throw new Error(
      `In-session password change inconclusive: status=${combinedStatus.slice(0, 200)} api=${blob.slice(0, 200)}`
    );
  }

  /**
   * Login (session or password) → change password in prefs → persist → verify login.
   * Does not use forgot-password email. Leaves schedule alone.
   */
  async runInSessionRotateForAccount(account, { dryRun = false, force = false } = {}) {
    const settings = await this.getSettings();
    const creds = parseCreds(account.credentials);
    const info = await this.classifyAccount(account, settings);

    // In-session only needs Reddit password + healthy proxy — inbox optional.
    const canRotate =
      account.status === 'active' &&
      !account.is_simulated &&
      !!creds.password &&
      creds.password !== 'default_password' &&
      info.proxyHealthy;

    if (!canRotate && !force) {
      return {
        success: false,
        skipped: true,
        reason: !info.proxyHealthy
          ? info.ineligibleReason || 'proxy_unhealthy'
          : 'missing_reddit_password',
        eligibility: info,
      };
    }

    if (dryRun) {
      return {
        success: true,
        dryRun: true,
        method: 'in_session_prefs',
        eligibility: info,
        plan: { proxyId: info.proxyId, username: account.username },
      };
    }

    let job = await this.ensureJob(account.id);
    job = await this.refreshDayState(job, settings);
    if (!force) {
      if (!job.enabled) return { skipped: true, reason: 'job_disabled' };
      if (job.status === 'running') return { skipped: true, reason: 'already_running' };
      if (job.cooldown_until && new Date(job.cooldown_until) > new Date()) {
        return { skipped: true, reason: 'cooldown', until: job.cooldown_until };
      }
      if (job.resets_today >= (settings.max_per_day || 2)) {
        return { skipped: true, reason: 'daily_cap' };
      }
    }

    await this.markRunning(job.id);
    let browser;
    const proxyId = info.proxyId;
    const currentPassword = creds.password;
    // Reddit rejects some exotic specials from the general generator.
    const newPassword = generatePassword(16).replace(/[^A-Za-z0-9!@#$%&*_\-]/g, 'A');
    if (newPassword.length < 10) {
      throw new Error('generated password too short');
    }

    try {
      const result = await playwrightService.createBrowserForAccount(account.id, 2, {
        requireProxy: true,
        forceDesktop: true,
      });
      browser = result.browser;
      const page = result.page;

      const loggedIn = await playwrightService.ensureLoggedIn(
        page,
        'reddit',
        account.id,
        account.username,
        currentPassword
      );
      if (!loggedIn) throw new Error('Login failed before in-session password change');

      // Ensure old.reddit sees the session (password change form lives there).
      await page.goto('https://old.reddit.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 90000,
      });
      await playwrightService.humanLikeDelay(1500, 2500);
      let oldOk = await page.evaluate(() => {
        const userLink = document.querySelector('#header-bottom-right .user a, span.user a');
        const logout = document.querySelector('form.logout, a[href*="logout"]');
        return !!(userLink && logout);
      });
      if (!oldOk) {
        // Password-login via old.reddit login form
        await page.goto('https://old.reddit.com/login', {
          waitUntil: 'domcontentloaded',
          timeout: 90000,
        });
        await playwrightService.humanLikeDelay(2000, 3500);
        const user = page.locator('input[name="user"], input[name="username"], #user_login').first();
        const pass = page.locator('input[name="passwd"], input[name="password"], #passwd_login').first();
        await user.waitFor({ state: 'visible', timeout: 20000 });
        await user.fill(account.username);
        await pass.fill(currentPassword);
        const submit =
          (await page.$('button[type="submit"]')) ||
          (await page.$('input[type="submit"]'));
        if (submit) await submit.click();
        else await page.keyboard.press('Enter');
        await playwrightService.humanLikeDelay(4000, 7000);
        oldOk = await page.evaluate(() => {
          const userLink = document.querySelector('#header-bottom-right .user a, span.user a');
          const logout = document.querySelector('form.logout, a[href*="logout"]');
          return !!(userLink && logout);
        });
        if (!oldOk) throw new Error('old.reddit login failed before password change');
        await playwrightService.persistSession(page, 'reddit', account.id).catch(() => {});
      }

      const completed = await this.changePasswordInSession(page, currentPassword, newPassword);

      // Persist IMMEDIATELY once Reddit accepts the change.
      // `/api/update_password` returns WRONG_PASSWORD for bad curpass and
      // `errors:[]` for success — proven live. Re-login verify often hits
      // ProxyBase network-policy blocks, so we must not lose the new password.
      const accepted =
        completed?.method === 'prefs_status' ||
        completed?.method === 'api_update_password' ||
        completed?.method === 'api_empty_errors_unverified' ||
        /errors":\s*\[\]/.test(JSON.stringify(completed?.apiResult || {}));
      if (!accepted) {
        throw new Error(`Password change not accepted: ${JSON.stringify(completed).slice(0, 300)}`);
      }
      await this.persistNewPassword(
        account.id,
        creds,
        newPassword,
        'reddit_in_session_prefs'
      );
      await playwrightService.persistSession(page, 'reddit', account.id).catch(() => {});

      // Close the logged-in browser before verify — clearing cookies in-place
      // triggers Reddit "network policy" blocks on the same proxy session.
      await Promise.race([
        browser.close().catch(() => {}),
        new Promise((r) => setTimeout(r, 8000)),
      ]);
      playwrightService._untrackBrowser?.(account.id);
      browser = null;
      await new Promise((r) => setTimeout(r, 5000));

      let loginOk = false;
      let oldStillWorks = false;
      let verifyMeta = {};
      {
        // Prefer a direct (skipProxy) verify browser — ProxyBase often network-policy
        // blocks password login right after update_password on the same sticky IP.
        let verifyBrowser;
        try {
          verifyBrowser = await playwrightService.createBrowserForAccount(account.id, 1, {
            skipProxy: true,
            forceDesktop: true,
          });
          verifyMeta.verifyVia = 'direct';
        } catch (directErr) {
          verifyMeta.directError = String(directErr.message || directErr).slice(0, 160);
          verifyBrowser = await playwrightService.createBrowserForAccount(account.id, 2, {
            requireProxy: true,
            forceDesktop: true,
          });
          verifyMeta.verifyVia = 'proxy';
        }
        browser = verifyBrowser.browser;
        const vpage = verifyBrowser.page;
        try {
          const neu = await this.loginOldRedditPassword(vpage, account.username, newPassword);
          loginOk = !!neu.ok;
          verifyMeta.newLogin = neu;
          if (!loginOk) {
            const old = await this.loginOldRedditPassword(vpage, account.username, currentPassword);
            oldStillWorks = !!old.ok;
            verifyMeta.oldLogin = old;
          } else {
            await playwrightService.persistSession(vpage, 'reddit', account.id).catch(() => {});
          }
        } catch (verifyErr) {
          verifyMeta.verifyError = String(verifyErr.message || verifyErr).slice(0, 240);
        }
      }

      await this.markSuccess(job, settings);
      await this.logAction(
        account.id,
        proxyId,
        loginOk ? 'rotated_verified_in_session' : 'rotated_in_session_unverified',
        {
          method: 'in_session_prefs',
          completed,
          loginOk,
          oldStillWorks,
          verifyMeta,
        }
      );
      if (proxyId) await proxyService.updateProxyStats(proxyId, true).catch(() => {});

      return {
        success: true,
        method: 'in_session_prefs',
        accountId: account.id,
        username: account.username,
        loginOk,
        verified: loginOk,
        passwordRotatedAt: new Date().toISOString(),
        warning: loginOk
          ? null
          : 'Password persisted after Reddit accepted change; login verify blocked (retry later)',
      };
    } catch (err) {
      const failureClass = await this.markFailure(job, err);
      await this.logAction(account.id, proxyId, 'failed_in_session', {}, err.message);
      if (
        proxyId &&
        /tunnel|timed_out|timeout|proxy|err_|network.security|blocked by network/i.test(
          err.message || ''
        )
      ) {
        await proxyService
          .updateProxyStats(proxyId, false, { reason: err.message })
          .catch(() => {});
      }
      return {
        success: false,
        method: 'in_session_prefs',
        accountId: account.id,
        username: account.username,
        error: err.message,
        failureClass,
      };
    } finally {
      if (browser) await browser.close().catch(() => {});
      playwrightService._untrackBrowser?.(account.id);
      await pool
        .query(
          `UPDATE reddit_password_reset_jobs
           SET status = 'idle',
               last_error = COALESCE(last_error, 'run_interrupted'),
               updated_at = NOW()
           WHERE id = $1 AND status = 'running'`,
          [job.id]
        )
        .catch(() => {});
    }
  }

  /**
   * Reset one account. dryRun=true only returns eligibility / plan.
   */
  async runOneForAccount(account, { dryRun = false, force = false } = {}) {
    const settings = await this.getSettings();
    const creds = parseCreds(account.credentials);
    const info = await this.classifyAccount(account, settings);

    if (!info.eligible && !force) {
      return { success: false, skipped: true, reason: info.ineligibleReason, eligibility: info };
    }

    if (dryRun) {
      return {
        success: true,
        dryRun: true,
        eligibility: info,
        plan: {
          triggerWith: account.email || creds.email || account.username,
          inboxVia: info.hasLinkedEmail ? 'email_accounts' : 'inline_credentials',
          proxyId: info.proxyId,
        },
      };
    }

    let job = await this.ensureJob(account.id);
    job = await this.refreshDayState(job, settings);

    if (!force) {
      if (!job.enabled) return { skipped: true, reason: 'job_disabled' };
      if (job.status === 'running') return { skipped: true, reason: 'already_running' };
      if (job.cooldown_until && new Date(job.cooldown_until) > new Date()) {
        return { skipped: true, reason: 'cooldown', until: job.cooldown_until };
      }
      if (job.resets_today >= (settings.max_per_day || 2)) {
        return { skipped: true, reason: 'daily_cap' };
      }
    }

    const inboxAccount = await this.resolveInboxAccount(account, creds);
    if (!inboxAccount) {
      return { success: false, skipped: true, reason: 'no_inbox_access', eligibility: info };
    }

    await this.markRunning(job.id);
    let browser;
    let trigger = null;
    const proxyId = info.proxyId;
    const triggeredAt = new Date();
    const newPassword = generatePassword(16);

    try {
      // Phase 1: trigger forgot-password (close browser before Outlook — two Chromiums OOM the box)
      {
        console.log(`Password-reset phase1 trigger start account=${account.id} ${account.username}`);
        const result = await playwrightService.createBrowserForAccount(account.id, 2, {
          requireProxy: true,
          forceDesktop: true,
        });
        browser = result.browser;
        const page = result.page;
        const triggerEmail = account.email || creds.email || account.username;
        const triggerUsername = account.username;
        // Bought accounts: try email first, then username — Reddit sometimes only
        // delivers when the identifier matches how the account was registered.
        try {
          trigger = await this.triggerForgotPassword(page, triggerEmail);
        } catch (emailTriggerErr) {
          console.warn(
            `Forgot via email failed for ${account.username}: ${emailTriggerErr.message}; trying username`
          );
          trigger = await this.triggerForgotPassword(page, triggerUsername);
        }
        // If email "succeeded" but we later find no mail, callers poll; also fire
        // a second username trigger when email !== username (cheap, same session).
        if (
          triggerEmail &&
          triggerUsername &&
          String(triggerEmail).toLowerCase() !== String(triggerUsername).toLowerCase()
        ) {
          try {
            await this.triggerForgotPassword(page, triggerUsername);
            trigger = { ...trigger, alsoTriggeredUsername: true };
          } catch (userTriggerErr) {
            console.warn(`Username forgot follow-up failed: ${userTriggerErr.message}`);
          }
        }
        console.log(
          `Password-reset phase1 trigger ok account=${account.id}:`,
          (trigger?.confirmationSnippet || '').slice(0, 120)
        );
        await Promise.race([
          browser.close().catch(() => {}),
          new Promise((r) => setTimeout(r, 8000)),
        ]);
        try {
          browser.process?.()?.kill?.('SIGKILL');
        } catch (_) {
          /* ignore */
        }
        playwrightService._untrackBrowser?.(account.id);
        browser = null;
      }

      // Hotmail/Outlook: skip IMAP (always fails basic auth) — go straight to web scrape.
      // Reddit mail often takes 1–3+ minutes and lands in Junk/Other.
      const SEARCH_QUERIES = [
        'from:reddit password',
        'subject:password reddit',
        'reddit password reset',
        'password reset',
        'from:reddit',
      ];
      const SUBJECT_NEEDLES = ['password', 'reset', 'recover'];
      const FROM_NEEDLES = ['reddit', 'redditmail', 'noreply'];

      const pollInbox = async (opts) => {
        if (emailInboxService.isMicrosoftAccount(inboxAccount)) {
          await new Promise((r) => setTimeout(r, opts.initialDelayMs || 60000));
          const start = Date.now();
          let last = null;
          let attempt = 0;
          const maxAttempts = opts.maxAttempts || 6;
          while (attempt < maxAttempts && Date.now() - start < (opts.timeoutMs || 420000)) {
            const searchQuery = SEARCH_QUERIES[attempt % SEARCH_QUERIES.length];
            attempt += 1;
            let messages = [];
            try {
              messages = await emailInboxService.fetchViaOutlookWeb(inboxAccount, {
                limit: opts.limit || 20,
                searchQuery,
                timeoutMs: 180000,
              });
            } catch (scrapeErr) {
              console.warn(
                `Outlook reset scrape failed attempt ${attempt} for ${inboxAccount.email}: ${scrapeErr.message}`
              );
              await new Promise((r) => setTimeout(r, opts.intervalMs || 45000));
              continue;
            }
            last = emailInboxService.pickLatestFromMessages(messages, {
              fromIncludes: opts.fromIncludes || FROM_NEEDLES,
              subjectIncludes: opts.subjectIncludes || SUBJECT_NEEDLES,
              linkIncludes: opts.linkIncludes,
              afterDate: opts.afterDate,
              requirePasswordReset: true,
            });
            if (!last.found && messages?.length) {
              const loose = emailInboxService.pickLatestFromMessages(messages, {
                requirePasswordReset: true,
                linkIncludes: 'reddit.com',
              });
              if (loose.found) last = loose;
            }
            if (last.found) return last;
            console.warn(
              `Outlook reset poll attempt ${attempt} for ${inboxAccount.email}: scanned ${last?.scanned || 0} (query=${searchQuery})`
            );
            await new Promise((r) => setTimeout(r, opts.intervalMs || 45000));
          }
          throw new Error(
            `Verification email not received within ${opts.timeoutMs || 420000}ms` +
              (last ? ` (scanned ${last.scanned} messages)` : '')
          );
        }
        return emailInboxService.pollForVerification(inboxAccount, opts);
      };

      const verified = await pollInbox({
        timeoutMs: 420000,
        intervalMs: 45000,
        initialDelayMs: 60000,
        maxAttempts: 6,
        fromIncludes: FROM_NEEDLES,
        subjectIncludes: SUBJECT_NEEDLES,
        linkIncludes: 'reddit.com',
        afterDate: triggeredAt,
        limit: 20,
      });

      let resetLink = verified.link;
      if (!resetLink && verified.links?.length) {
        resetLink =
          verified.links.find((u) => /reddit\.com.*(password|reset|change|account|recover)/i.test(u)) ||
          verified.links.find((u) => /reddit\.com/i.test(u)) ||
          verified.links[0];
      }
      if (!resetLink) {
        const retry = await emailInboxService.fetchViaOutlookWeb(inboxAccount, {
          limit: 25,
          searchQuery: 'from:reddit',
          timeoutMs: 150000,
        });
        const picked = emailInboxService.pickLatestFromMessages(retry, {
          linkIncludes: 'reddit.com',
        });
        resetLink =
          picked.link ||
          picked.links?.find((u) => /reddit\.com.*(password|reset|change|account|recover)/i.test(u)) ||
          picked.links?.find((u) => /reddit\.com/i.test(u));
      }
      if (!resetLink) {
        throw new Error(
          `No Reddit password-reset link in inbox (scanned ${verified.scanned} messages)`
        );
      }

      // Phase 3: open reset link + set password + verify login
      {
        let completed;
        let usedSkipProxy = false;
        let page;

        const openBrowser = async (opts) => {
          if (browser) await browser.close().catch(() => {});
          playwrightService._untrackBrowser?.(account.id);
          const result = await playwrightService.createBrowserForAccount(account.id, 2, opts);
          browser = result.browser;
          page = result.page;
        };

        try {
          await openBrowser({ requireProxy: true, forceDesktop: true });
          completed = await this.completePasswordReset(page, resetLink, newPassword);
        } catch (resetErr) {
          if (!/network.security|blocked by network|Password fields not found/i.test(resetErr.message || '')) {
            throw resetErr;
          }
          console.warn(
            `Reset via proxy failed for ${account.username} (${resetErr.message}); retrying direct`
          );
          usedSkipProxy = true;
          await openBrowser({ skipProxy: true, forceDesktop: true });
          completed = await this.completePasswordReset(page, resetLink, newPassword);
        }

        await this.persistNewPassword(account.id, creds, newPassword);

        let loginOk = false;
        try {
          loginOk = !!(await playwrightService.ensureLoggedIn(
            page,
            'reddit',
            account.id,
            account.username,
            newPassword
          ));
        } catch (loginErr) {
          try {
            await openBrowser({
              requireProxy: !usedSkipProxy,
              skipProxy: usedSkipProxy,
              forceDesktop: true,
            });
            loginOk = !!(await playwrightService.ensureLoggedIn(
              page,
              'reddit',
              account.id,
              account.username,
              newPassword
            ));
          } catch (loginErr2) {
            console.warn(
              `Password rotated for ${account.username} but login verify failed: ${loginErr2.message}`
            );
          }
        }

        await this.markSuccess(job, settings);
        await this.logAction(
          account.id,
          proxyId,
          loginOk ? 'rotated_verified' : 'rotated',
          {
            trigger,
            resetLinkHost: (() => {
              try {
                return new URL(resetLink).host;
              } catch {
                return null;
              }
            })(),
            completed,
            loginOk,
          }
        );

        if (proxyId) await proxyService.updateProxyStats(proxyId, true).catch(() => {});

        return {
          success: true,
          accountId: account.id,
          username: account.username,
          loginOk,
          passwordRotatedAt: new Date().toISOString(),
        };
      }
    } catch (err) {
      const failureClass = await this.markFailure(job, err);
      await this.logAction(account.id, proxyId, 'failed', {}, err.message);
      // Only burn proxy on infra/security — not "mail not found" (inbox scrape issue)
      if (proxyId && /tunnel|timed_out|timeout|proxy|err_|network.security|blocked by network/i.test(err.message || '')) {
        await proxyService
          .updateProxyStats(proxyId, false, { reason: err.message })
          .catch(() => {});
      }
      return {
        success: false,
        accountId: account.id,
        username: account.username,
        error: err.message,
        failureClass,
      };
    } finally {
      if (browser) await browser.close().catch(() => {});
      playwrightService._untrackBrowser?.(account.id);
      // If markSuccess/markFailure never ran (kill -9 / OOM), do not leave forever-running.
      await pool.query(
        `UPDATE reddit_password_reset_jobs
         SET status = 'idle',
             last_error = COALESCE(last_error, 'run_interrupted'),
             updated_at = NOW()
         WHERE id = $1 AND status = 'running'`,
        [job.id]
      ).catch(() => {});
    }
  }

  async getDashboard() {
    const settings = await this.getSettings();
    const report = await this.eligibilityReport();
    const { rows: recent } = await pool.query(
      `SELECT a.*, sa.username
       FROM reddit_password_reset_actions a
       JOIN social_accounts sa ON sa.id = a.social_account_id
       ORDER BY a.created_at DESC
       LIMIT 20`
    );
    const { rows: jobStats } = await pool.query(
      `SELECT
         COUNT(*) AS jobs,
         COUNT(*) FILTER (WHERE enabled) AS enabled_jobs,
         COUNT(*) FILTER (WHERE last_reset_at IS NOT NULL) AS ever_reset,
         COUNT(*) FILTER (WHERE resets_today > 0) AS reset_today,
         COUNT(*) FILTER (WHERE cooldown_until IS NOT NULL AND cooldown_until > NOW()) AS cooling
       FROM reddit_password_reset_jobs`
    );
    return {
      settings,
      eligibility: report.totals,
      byInbox: report.byInbox,
      byDomain: report.byDomain,
      ineligibleReasons: report.ineligibleReasons,
      jobs: jobStats[0] || {},
      recentActions: recent,
    };
  }
}

module.exports = new RedditPasswordResetService();
