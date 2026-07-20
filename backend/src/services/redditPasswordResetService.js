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
    return {
      confirmationSnippet: body.slice(0, 240),
      looksOk,
      landingSnippet: landingSnippet.slice(0, 120),
      url: page.url(),
    };
  }

  async completePasswordReset(page, resetLink, newPassword) {
    await page.goto(resetLink, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await playwrightService.humanLikeDelay(2000, 4000);
    await this.dismissCookieBanners(page);

    const pwInputs = page.locator(
      'input[type="password"], faceplate-text-input[name*="password" i] input, input[name*="password" i]'
    );
    const count = await pwInputs.count();
    if (count < 1) {
      const snippet = (await page.locator('body').innerText().catch(() => '')).slice(0, 300);
      throw new Error(`Password fields not found on reset page: ${snippet}`);
    }

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

    const save =
      (await page.$('button[type="submit"]')) ||
      (await page.$('button:has-text("Save")')) ||
      (await page.$('button:has-text("Set")')) ||
      (await page.$('button:has-text("Change")')) ||
      (await page.$('button:has-text("Continue")'));
    if (!save) throw new Error('Save-password button not found');
    await save.click();
    await playwrightService.humanLikeDelay(3000, 5500);

    const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 500);
    const failed = /invalid|expired|error|try again|incorrect/i.test(body) &&
      !/success|updated|changed|logged in|home/i.test(body);
    if (failed) {
      throw new Error(`Password save may have failed: ${body.slice(0, 200)}`);
    }
    return { url: page.url(), snippet: body.slice(0, 200) };
  }

  async persistNewPassword(accountId, creds, newPassword) {
    const next = {
      ...creds,
      password: newPassword,
      password_rotated_at: new Date().toISOString(),
      password_rotation_source: 'reddit_password_reset_loop',
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
    const proxyId = info.proxyId;
    const triggeredAt = new Date();
    const newPassword = generatePassword(16);

    try {
      const result = await playwrightService.createBrowserForAccount(account.id, 2, {
        requireProxy: true,
        forceDesktop: true,
      });
      browser = result.browser;
      const page = result.page;

      const triggerEmail = account.email || creds.email || account.username;
      const trigger = await this.triggerForgotPassword(page, triggerEmail);

      // Poll inbox for reset link (Outlook web fallback for Hotmail)
      const verified = await emailInboxService.pollForVerification(inboxAccount, {
        timeoutMs: 90000,
        intervalMs: 12000,
        fromIncludes: 'reddit',
        subjectIncludes: 'password',
        afterDate: triggeredAt,
        linkIncludes: 'reddit.com',
        limit: 12,
      });

      let resetLink = verified.link;
      if (!resetLink && verified.links?.length) {
        resetLink = verified.links.find((u) => /reddit\.com/i.test(u)) || verified.links[0];
      }
      if (!resetLink) {
        // Broader retry without subject filter (some subjects omit "password")
        const retry = await emailInboxService.getLatestVerification(inboxAccount, {
          limit: 15,
          fromIncludes: 'reddit',
          afterDate: triggeredAt,
          linkIncludes: 'reddit.com',
        });
        resetLink = retry.link || retry.links?.find((u) => /reddit\.com/i.test(u));
      }
      if (!resetLink) {
        throw new Error(
          `No Reddit password-reset link in inbox (scanned ${verified.scanned} messages)`
        );
      }

      const completed = await this.completePasswordReset(page, resetLink, newPassword);
      await this.persistNewPassword(account.id, creds, newPassword);

      // Verify login with the new password
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
        console.warn(
          `Password rotated for ${account.username} but login verify failed: ${loginErr.message}`
        );
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
    } catch (err) {
      const failureClass = await this.markFailure(job, err);
      await this.logAction(account.id, proxyId, 'failed', {}, err.message);
      if (proxyId) {
        const isProxyPath = /proxy|ECONNREFUSED|tunnel|TIMEOUT|net::/i.test(err.message || '');
        await proxyService
          .updateProxyStats(proxyId, false, { reason: err.message })
          .catch(() => {});
        if (isProxyPath) {
          /* updateProxyStats already handles cooldown escalation */
        }
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
