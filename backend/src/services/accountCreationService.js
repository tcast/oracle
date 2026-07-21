const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const pool = require('./db');
const proxyService = require('./proxyService');
const captchaSolverService = require('./captchaSolverService');
const emailInboxService = require('./emailInboxService');
const playwrightService = require('./playwrightService');
const { generatePassword } = require('../utils/passwordGenerator');
const { generateRealisticUsername } = require('../utils/nameGenerator');
const mailTmService = require('./mailTmService');
const { classifyFailure } = require('./failureClassifier');

chromium.use(stealth);

/** Max concurrent create batches (always 1 — no stampede). */
const CREATE_BATCH_LOCK_MS = 45 * 60 * 1000;

const PLATFORM_CATALOG = {
  reddit: {
    label: 'Reddit',
    readiness: 'ready',
    selfCreate: true,
    notes: 'Self-create via catchall (parked domains) or Yahoo pool + healthy US proxy',
  },
  x: {
    label: 'X',
    readiness: 'needs_accounts_bought',
    selfCreate: false,
    notes: 'Import via /api/social-accounts/import (cookie dump) → verify → organic',
  },
  instagram: {
    label: 'Instagram',
    readiness: 'import_ready',
    selfCreate: false,
    notes: 'Import + TOTP verify + organic comments supported',
  },
  tiktok: {
    label: 'TikTok',
    readiness: 'import_ready',
    selfCreate: false,
    notes: 'Import + login smoke; web comment not stable — warm path ready',
  },
  linkedin: {
    label: 'LinkedIn',
    readiness: 'import_ready',
    selfCreate: false,
    notes: 'Import + session verify + organic feed comments supported',
  },
};

class AccountCreationService {
  constructor() {
    this.activeBrowsers = new Map();
    this._batchRunning = false;
    this._batchStartedAt = null;
    this._attemptsTableReady = false;
  }

  getPlatformCatalog() {
    return { ...PLATFORM_CATALOG };
  }

  async ensureAttemptsTable() {
    if (this._attemptsTableReady) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS account_creation_attempts (
        id SERIAL PRIMARY KEY,
        platform VARCHAR(50) NOT NULL,
        status VARCHAR(50) NOT NULL,
        error_class VARCHAR(50),
        error_message TEXT,
        proxy_id INTEGER REFERENCES proxies(id) ON DELETE SET NULL,
        email_account_id INTEGER REFERENCES email_accounts(id) ON DELETE SET NULL,
        social_account_id INTEGER REFERENCES social_accounts(id) ON DELETE SET NULL,
        username VARCHAR(255),
        email VARCHAR(255),
        source VARCHAR(80) DEFAULT 'api',
        detail JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_account_creation_attempts_created
        ON account_creation_attempts (created_at DESC)
    `).catch(() => {});
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_account_creation_attempts_platform_day
        ON account_creation_attempts (platform, created_at DESC)
    `).catch(() => {});
    this._attemptsTableReady = true;
  }

  /**
   * Persist one create attempt for NOC (created / attempt_failed / skipped / blocked).
   */
  async recordAttempt({
    platform,
    status,
    errorClass = null,
    errorMessage = null,
    proxyId = null,
    emailAccountId = null,
    socialAccountId = null,
    username = null,
    email = null,
    source = 'api',
    detail = {},
  }) {
    try {
      await this.ensureAttemptsTable();
      const result = await pool.query(
        `INSERT INTO account_creation_attempts
           (platform, status, error_class, error_message, proxy_id, email_account_id,
            social_account_id, username, email, source, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
         RETURNING id, created_at`,
        [
          platform,
          status,
          errorClass,
          errorMessage ? String(errorMessage).slice(0, 500) : null,
          proxyId || null,
          emailAccountId || null,
          socialAccountId || null,
          username || null,
          email || null,
          source,
          JSON.stringify(detail || {}),
        ]
      );
      return result.rows[0];
    } catch (err) {
      console.warn('recordAttempt failed:', err.message);
      return null;
    }
  }

  classifyCreateError(message = '') {
    const msg = String(message || '');
    if (/no unassigned email|no .*email/i.test(msg)) return 'no_email';
    if (/no .*proxy|proxy.*unavailable|no healthy proxy|not assignable/i.test(msg)) return 'no_proxy';
    if (/not supported|not.?implemented|gated|needs.?accounts/i.test(msg)) return 'not_ready';
    if (/verification (email|code)|scanned 0 messages|inbox/i.test(msg)) return 'email_verify';
    if (/CAPTCHA|sitekey/i.test(msg)) return 'challenge';
    if (/batch already running|create already in progress/i.test(msg)) return 'busy';
    return classifyFailure(msg);
  }

  acquireBatchLock() {
    if (this._batchRunning) {
      const age = this._batchStartedAt ? Date.now() - this._batchStartedAt : 0;
      if (age < CREATE_BATCH_LOCK_MS) {
        throw new Error(
          `Account create already in progress (started ${Math.round(age / 1000)}s ago)`
        );
      }
    }
    this._batchRunning = true;
    this._batchStartedAt = Date.now();
  }

  releaseBatchLock() {
    this._batchRunning = false;
    this._batchStartedAt = null;
  }

  /**
   * Operator-facing eligibility: emails, healthy proxies, platform readiness.
   */
  async getEligibility(platform = null) {
    const emailPool = await pool.query(`
      SELECT
        COUNT(*)::int AS available,
        COUNT(*) FILTER (WHERE provider = 'catchall')::int AS catchall,
        COUNT(*) FILTER (WHERE provider <> 'catchall')::int AS other
      FROM email_accounts ea
      WHERE ea.status = 'active'
        AND COALESCE(ea.metadata->>'linked_reddit', '') = ''
        AND NOT EXISTS (
          SELECT 1 FROM social_accounts sa
          WHERE sa.email IS NOT NULL AND lower(sa.email) = lower(ea.email)
        )
        AND NOT EXISTS (
          SELECT 1 FROM social_accounts sa
          WHERE sa.email_account_id = ea.id
        )
    `).catch(() => ({ rows: [{ available: 0, catchall: 0, other: 0 }] }));

    const proxies = await pool.query(`
      SELECT COUNT(*)::int AS healthy_us
      FROM proxies p
      WHERE p.is_active = true
        AND p.country = 'US'
        AND (p.cooldown_until IS NULL OR p.cooldown_until <= NOW())
        AND COALESCE(p.consecutive_failures, 0) < 3
        AND COALESCE(p.last_health_ok, true) = true
        AND NOT EXISTS (
          SELECT 1 FROM social_account_proxies sap
          JOIN social_accounts sa ON sa.id = sap.social_account_id
          WHERE sap.proxy_id = p.id AND sap.is_active = true AND sa.platform = 'reddit'
        )
    `).catch(() => ({ rows: [{ healthy_us: 0 }] }));

    const attemptsToday = await pool.query(`
      SELECT
        platform,
        COUNT(*)::int AS attempted,
        COUNT(*) FILTER (WHERE status = 'created')::int AS created,
        COUNT(*) FILTER (WHERE status IN ('attempt_failed', 'blocked', 'skipped'))::int AS failed
      FROM account_creation_attempts
      WHERE created_at::date = CURRENT_DATE
      GROUP BY platform
    `).catch(() => ({ rows: [] }));

    const catalog = this.getPlatformCatalog();
    const platforms = Object.entries(catalog).map(([id, meta]) => {
      const today = attemptsToday.rows.find((r) => r.platform === id) || {
        attempted: 0,
        created: 0,
        failed: 0,
      };
      const canSelfCreate =
        meta.selfCreate &&
        meta.readiness === 'ready' &&
        (emailPool.rows[0]?.available || 0) > 0 &&
        (proxies.rows[0]?.healthy_us || 0) > 0;
      return {
        platform: id,
        ...meta,
        can_self_create: canSelfCreate,
        today,
      };
    });

    const filtered = platform
      ? platforms.filter((p) => p.platform === platform)
      : platforms;

    return {
      batch_running: this._batchRunning,
      batch_started_at: this._batchStartedAt
        ? new Date(this._batchStartedAt).toISOString()
        : null,
      email_pool: emailPool.rows[0] || { available: 0, catchall: 0, other: 0 },
      proxies: { healthy_us: proxies.rows[0]?.healthy_us || 0 },
      platforms: filtered,
      max_batch: 5,
      default_concurrency: 1,
    };
  }

  async createBrowser(proxyConfig = null) {
    const args = [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-web-security',
      '--disable-features=BlockInsecurePrivateNetworkRequests',
      '--disable-webrtc',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ];

    const options = {
      headless: process.env.NODE_ENV === 'production',
      args,
      ignoreDefaultArgs: ['--enable-automation'],
    };

    const executablePath =
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
      process.env.CHROMIUM_PATH ||
      undefined;
    if (executablePath) options.executablePath = executablePath;

    if (proxyConfig) {
      const { _proxyId, ...clean } = proxyConfig;
      options.proxy = {
        server: clean.server,
        username: clean.username,
        password: clean.password,
      };
    }

    const browser = await chromium.launch(options);
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York',
      ignoreHTTPSErrors: true,
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(45000);
    return { browser, context, page };
  }

  async humanLikeDelay(min = 500, max = 2000) {
    const delay = Math.floor(Math.random() * (max - min + 1) + min);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  async humanLikeTyping(page, selector, text) {
    const loc = page.locator(selector).first();
    await loc.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    await loc.click({ timeout: 10000 }).catch(async () => {
      await page.click(selector, { timeout: 5000 });
    });
    await this.humanLikeDelay(200, 500);
    // Clear without locator.fill — faceplate shadow inputs reject fill()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Backspace');
    for (const char of text) {
      await page.keyboard.type(char);
      await this.humanLikeDelay(40, 120);
    }
  }

  async typeIntoLocator(page, locator, text) {
    await locator.click({ timeout: 10000 });
    await this.humanLikeDelay(200, 500);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(text, { delay: 55 });
  }

  async extractCaptchaSiteKey(page) {
    return page.evaluate(() => {
      const el =
        document.querySelector('[data-sitekey]') ||
        document.querySelector('.g-recaptcha[data-sitekey]');
      if (el) return { siteKey: el.getAttribute('data-sitekey'), type: 'recaptcha_v2' };

      const iframe = document.querySelector(
        'iframe[src*="recaptcha"], iframe[title*="reCAPTCHA"], iframe[src*="hcaptcha"]'
      );
      if (iframe) {
        const src = iframe.getAttribute('src') || '';
        const m = src.match(/[?&]k=([^&]+)/);
        if (m) {
          return {
            siteKey: decodeURIComponent(m[1]),
            type: src.includes('hcaptcha') ? 'hcaptcha' : 'recaptcha_v2',
          };
        }
      }
      return null;
    });
  }

  async maybeSolveCaptcha(page, pageUrl) {
    const captchaFrame = await page.$(
      'iframe[title*="recaptcha"], iframe[src*="captcha"], iframe[src*="hcaptcha"], [data-sitekey]'
    );
    if (!captchaFrame) return { solved: false, reason: 'none' };

    const info = await this.extractCaptchaSiteKey(page);
    if (!info?.siteKey) {
      return { solved: false, reason: 'captcha_present_no_sitekey' };
    }

    console.log(`CAPTCHA detected (${info.type}), solving…`);
    const token = await captchaSolverService.solveCaptcha(
      info.siteKey,
      pageUrl,
      info.type
    );
    await captchaSolverService.injectCaptchaToken(page, token);
    return { solved: true, type: info.type };
  }

  async isRedditLoggedIn(page) {
    return page.evaluate(() => {
      const text = document.body?.innerText || '';
      if (/Expand user menu|Open inbox|Create post/i.test(text)) return true;
      if (document.querySelector('#expand-user-drawer-button, [id*="UserDrawer"]')) return true;
      if (document.querySelector('a[href^="/user/"]')) return true;
      return false;
    });
  }

  /**
   * Claim one unassigned active email from the pool.
   * Prefer Yahoo (web OTP works), then proven parked catchalls, then other catchalls/MS/GMX.
   */
  async claimEmailFromPool(opts = {}) {
    const result = await pool.query(
      `SELECT ea.*
       FROM email_accounts ea
       WHERE ea.status = 'active'
         AND COALESCE(ea.metadata->>'linked_reddit', '') = ''
         AND NOT EXISTS (
           SELECT 1 FROM social_accounts sa
           WHERE sa.email IS NOT NULL AND lower(sa.email) = lower(ea.email)
         )
         AND NOT EXISTS (
           SELECT 1 FROM social_accounts sa
           WHERE sa.email_account_id = ea.id
         )
         AND (
           $1::boolean = true
           OR ea.provider IN ('catchall', 'yahoo', 'outlook', 'hotmail', 'live', 'gmx')
         )
       ORDER BY
         CASE
           WHEN ea.provider = 'yahoo' THEN 0
           -- Domains with proven Reddit SMTP delivery into the Hetzner pool inbox
           WHEN ea.provider = 'catchall'
             AND lower(split_part(ea.email, '@', 2)) IN (
               'bashed.net', 'faregiant.com', 'retain360.io', 'uspunk.com', 'usgeek.com'
             ) THEN 1
           WHEN ea.provider = 'catchall'
             AND lower(split_part(ea.email, '@', 2)) <> 'proteusmail.net' THEN 2
           WHEN ea.provider = 'catchall' THEN 3
           WHEN ea.provider IN ('outlook', 'hotmail', 'live') THEN 4
           WHEN ea.provider = 'gmx' THEN 5
           ELSE 6
         END,
         CASE WHEN COALESCE(ea.metadata->>'last_inbox_ok', '') = 'true' THEN 0 ELSE 1 END,
         ea.id DESC
       LIMIT 1`,
      [opts.allowAnyProvider === true]
    );
    return result.rows[0] || null;
  }

  /**
   * Reclaim a US proxy from a pending_setup Reddit shell, or take any free US proxy.
   * USA-only policy: never assign non-US proxies for create/warm.
   */
  async claimProxyForNewAccount() {
    const shells = await pool.query(
      `SELECT sa.id AS account_id, sap.proxy_id
       FROM social_accounts sa
       JOIN social_account_proxies sap ON sap.social_account_id = sa.id AND sap.is_active = true
       JOIN proxies p ON p.id = sap.proxy_id
       WHERE sa.status = 'pending_setup' AND sa.platform = 'reddit'
         AND p.is_active = true AND p.country = 'US'
       ORDER BY sa.id
       LIMIT 1`
    );
    if (shells.rows[0]) {
      const { account_id, proxy_id } = shells.rows[0];
      await pool.query(
        `UPDATE social_account_proxies SET is_active = false WHERE social_account_id = $1`,
        [account_id]
      );
      await pool.query(`DELETE FROM social_account_proxies WHERE social_account_id = $1`, [
        account_id,
      ]);
      await pool.query(
        `DELETE FROM social_accounts WHERE id = $1 AND status = 'pending_setup'`,
        [account_id]
      );
      return proxy_id;
    }

    // Prefer proxies that recently loaded Reddit successfully, then healthy ProxyBase
    // (BrightData ISP is currently network-blocked on /register). Never two Reddit
    // accounts on same proxy. Skip cooled / degraded / unhealthy.
    const pick = await pool.query(
      `SELECT p.id FROM proxies p
       WHERE p.is_active = true
         AND p.country = 'US'
         AND (p.cooldown_until IS NULL OR p.cooldown_until <= NOW())
         AND COALESCE(p.consecutive_failures, 0) < 3
         AND COALESCE(p.last_health_ok, true) = true
         AND NOT EXISTS (
           SELECT 1 FROM social_account_proxies sap
           JOIN social_accounts sa ON sa.id = sap.social_account_id
           WHERE sap.proxy_id = p.id AND sap.is_active = true AND sa.platform = 'reddit'
         )
       ORDER BY
         CASE
           WHEN p.last_success_at IS NOT NULL
             AND p.last_success_at > NOW() - INTERVAL '2 hours'
             AND COALESCE(p.last_error, '') NOT ILIKE '%network_security%'
             THEN 0
           WHEN p.provider ILIKE '%proxybase%'
             AND p.name ILIKE '%residential%' THEN 1
           WHEN p.provider ILIKE '%proxybase%' THEN 2
           WHEN p.provider ILIKE '%brightdata%'
             AND COALESCE(p.metadata->>'zone', '') IN ('isp_proxy3', 'isp_proxy4') THEN 3
           ELSE 4
         END,
         CASE WHEN EXISTS (
           SELECT 1 FROM social_account_proxies sap
           WHERE sap.proxy_id = p.id AND sap.is_active = true
         ) THEN 1 ELSE 0 END,
         p.failure_count ASC NULLS FIRST,
         p.last_used_at ASC NULLS FIRST,
         p.id
       LIMIT 1`
    );
    return pick.rows[0]?.id || null;
  }

  async createRedditAccount(username, email, password, proxyConfig = null, emailToken = null, emailAccount = null) {
    let browser;
    const pageUrl = 'https://www.reddit.com/register/';
    try {
      const { browser: b, page } = await this.createBrowser(proxyConfig);
      browser = b;

      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await this.humanLikeDelay(2500, 4500);

      // Dismiss cookie banners if present
      for (const label of ['Accept all', 'Accept', 'I agree', 'Continue']) {
        const btn = await page.$(`button:has-text("${label}")`);
        if (btn) {
          await btn.click().catch(() => {});
          await this.humanLikeDelay(500, 1200);
        }
      }

      // Current Reddit signup: choose Email vs Phone first
      const emailChoice =
        (await page.$('button:has-text("Email")')) ||
        (await page.$('a:has-text("Email")')) ||
        (await page.getByText('Email', { exact: true }).first().elementHandle().catch(() => null));
      if (emailChoice) {
        await emailChoice.click().catch(() => {});
        await this.humanLikeDelay(1000, 2000);
      }

      // Wait for email field (faceplate shadow DOM or classic inputs)
      let emailLocator = page
        .locator('faceplate-text-input[name="email"] input, input[name="email"], input[type="email"], #regEmail')
        .first();
      try {
        await emailLocator.waitFor({ state: 'visible', timeout: 25000 });
      } catch (_) {
        // Try clicking Email again / expand auth modal
        await page.getByRole('button', { name: /email/i }).first().click().catch(() => {});
        await this.humanLikeDelay(1000, 2000);
        emailLocator = page
          .locator(
            'faceplate-text-input input, auth-flow-modal input[type="email"], input[name="email"], input[type="email"]'
          )
          .first();
        await emailLocator.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      }

      const emailVisible = await emailLocator.isVisible().catch(() => false);
      if (!emailVisible) {
        const snap = `/tmp/reddit-register-fail-${Date.now()}.png`;
        await page.screenshot({ path: snap, fullPage: true }).catch(() => {});
        const title = await page.title().catch(() => '');
        const url = page.url();
        const snippet = (await page.locator('body').innerText().catch(() => '')).slice(0, 400);
        throw new Error(
          `Reddit register: email input not found (title=${title} url=${url} snap=${snap}) ${snippet}`
        );
      }

      await this.typeIntoLocator(page, emailLocator, email);
      await this.humanLikeDelay();

      const continueBtn = await page.$(
        'button:has-text("Continue"), button:has-text("Next"), button[type="submit"]'
      );
      if (continueBtn) {
        await continueBtn.click().catch(() => {});
        await this.humanLikeDelay(1000, 2000);
      }

      // Optional email verification code step — require verify-page copy to avoid false positives
      const pageTextEarly = await page
        .evaluate(() => (document.body?.innerText || '').slice(0, 600))
        .catch(() => '');
      const onVerifyPage = /verify your email|verification code|6-digit code|enter the code/i.test(
        pageTextEarly
      );
      const codeInput = onVerifyPage
        ? await page.$(
            'input[name="code"], input[autocomplete="one-time-code"], input[placeholder*="code" i]'
          )
        : null;
      if (codeInput && emailAccount) {
        const pageHint = await page
          .evaluate(() => (document.body?.innerText || '').slice(0, 400))
          .catch(() => '');
        console.log(
          `Reddit asking for email verification code… email=${emailAccount.email} hint=${pageHint.replace(/\s+/g, ' ').slice(0, 180)}`
        );
        const verifyStartedAt = new Date(Date.now() - 90_000);
        let verified = null;
        const isCatchall = String(emailAccount.provider || '').toLowerCase() === 'catchall';
        // Yahoo/web: allow ~4 min. Catchall: abort at 75s if Reddit never SMTP'd (don't burn 7 min).
        const pollDeadline = Date.now() + (isCatchall ? 75000 : 240000);
        let resentAt = 0;
        let firstResendAfter = Date.now() + (isCatchall ? 45000 : 90000);
        while (Date.now() < pollDeadline) {
          try {
            verified = await emailInboxService.pollForVerification(emailAccount, {
              timeoutMs: Math.min(isCatchall ? 25000 : 70000, pollDeadline - Date.now()),
              intervalMs: 8000,
              limit: 50,
              fromIncludes: 'reddit',
              afterDate: verifyStartedAt,
              searchQuery: 'reddit',
            });
            if (verified?.code) break;
          } catch (pollErr) {
            const msg = pollErr.message || String(pollErr);
            console.warn(`Reddit verify poll wait: ${msg.slice(0, 180)}`);
          }
          if (Date.now() >= firstResendAfter && (!resentAt || Date.now() - resentAt > 90000)) {
            const resend =
              (await page.$('button:has-text("Resend"), button:has-text("Send again"), a:has-text("Resend")')) ||
              (await page.getByText(/resend|send again|didn.?t get/i).first().elementHandle().catch(() => null));
            if (resend) {
              console.log('Reddit verify: clicking resend…');
              await resend.click().catch(() => {});
              resentAt = Date.now();
              await this.humanLikeDelay(2000, 4000);
            }
          }
        }
        if (!verified?.code) {
          throw new Error(
            `Verification email not received within ${isCatchall ? 75000 : 240000}ms for ${emailAccount.email}`
          );
        }
        await this.humanLikeTyping(
          page,
          'input[name="code"], input[autocomplete="one-time-code"], input[placeholder*="code" i]',
          verified.code
        );
        await this.humanLikeDelay();
        const submitCode = await page.$('button[type="submit"], button:has-text("Continue")');
        if (submitCode) await submitCode.click();
        await this.humanLikeDelay(1500, 3000);
      } else if (codeInput && emailToken) {
        // mail.tm path — poll messages for a code
        const start = Date.now();
        let code = null;
        while (Date.now() - start < 90000 && !code) {
          const messages = await mailTmService.getMessages(emailToken);
          for (const msg of messages) {
            const full = await mailTmService.getMessage(emailToken, msg.id);
            const text = `${full?.subject || ''} ${full?.text || ''} ${full?.html || ''}`;
            const m = text.match(/\b(\d{6})\b/);
            if (m) {
              code = m[1];
              break;
            }
          }
          if (!code) await this.humanLikeDelay(3000, 4000);
        }
        if (!code) throw new Error('mail.tm verification code not received');
        await this.humanLikeTyping(
          page,
          'input[name="code"], input[autocomplete="one-time-code"], input[placeholder*="code" i]',
          code
        );
        await this.humanLikeDelay();
        const submitCode = await page.$('button[type="submit"], button:has-text("Continue")');
        if (submitCode) await submitCode.click();
        await this.humanLikeDelay(1500, 3000);
      }

      const userField = page
        .locator(
          'faceplate-text-input[name="username"] input, input[name="username"], #regUsername'
        )
        .first();
      const passField = page
        .locator(
          'faceplate-text-input[name="password"] input, input[name="password"], #regPassword'
        )
        .first();

      if (await userField.isVisible().catch(() => false)) {
        await this.typeIntoLocator(page, userField, username);
        await this.humanLikeDelay();
      }
      if (await passField.isVisible().catch(() => false)) {
        await this.typeIntoLocator(page, passField, password);
        await this.humanLikeDelay();
      }

      const captchaResult = await this.maybeSolveCaptcha(page, page.url());
      if (captchaResult.reason === 'captcha_present_no_sitekey') {
        throw new Error(
          'CAPTCHA present but sitekey not extractable — blocked (need solver wiring for this challenge type)'
        );
      }

      const submit = await page.$(
        'button[type="submit"], button:has-text("Sign Up"), button:has-text("Create")'
      );
      if (submit) await submit.click();
      await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
      await this.humanLikeDelay(2000, 4000);

      // Link-based email verify if still pending
      if (emailAccount) {
        try {
          const verified = await emailInboxService.getLatestVerification(emailAccount, {
            fromIncludes: 'reddit',
          });
          if (verified.link) {
            await page.goto(verified.link, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await this.humanLikeDelay(1500, 3000);
          }
        } catch (_) {
          /* optional */
        }
      } else if (emailToken) {
        try {
          const { link } = await mailTmService.pollForVerificationLink(emailToken, 60000, 3000);
          await page.goto(link, { waitUntil: 'domcontentloaded' });
          await this.humanLikeDelay();
        } catch (verifyErr) {
          console.warn('Email verification polling failed:', verifyErr.message);
        }
      }

      const loggedIn = await this.isRedditLoggedIn(page);
      if (!loggedIn) {
        const bodySnippet = await page.evaluate(() =>
          (document.body?.innerText || '').slice(0, 300)
        );
        throw new Error(
          `Account creation failed — not logged in after registration. Page: ${bodySnippet}`
        );
      }

      // Best-effort TOTP enable (may fail silently)
      let totpSecret = null;
      try {
        totpSecret = await this.enableRedditTotp(page);
      } catch (err) {
        console.warn('Reddit TOTP enable skipped:', err.message);
      }

      const cookies = await page.context().cookies();

      return {
        success: true,
        username,
        email,
        password,
        totp_secret: totpSecret,
        email_verified: true,
        cookies,
        captcha: captchaResult,
      };
    } catch (error) {
      console.error('Error creating Reddit account:', error.message);
      throw error;
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  /**
   * Best-effort: open Reddit 2FA settings and capture a new authenticator secret.
   * Returns null if UI not found / blocked.
   */
  async enableRedditTotp(page) {
    await page.goto('https://www.reddit.com/settings/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await this.humanLikeDelay(1500, 3000);

    const twoFaLink = await page.$(
      'a[href*="two-factor"], a[href*="2fa"], button:has-text("Two-factor"), a:has-text("Two-factor")'
    );
    if (!twoFaLink) {
      await page.goto('https://www.reddit.com/account-activity', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      }).catch(() => {});
    } else {
      await twoFaLink.click();
      await this.humanLikeDelay(1500, 2500);
    }

    const enableBtn = await page.$(
      'button:has-text("Enable"), button:has-text("Set up"), button:has-text("Add authenticator")'
    );
    if (!enableBtn) return null;
    await enableBtn.click();
    await this.humanLikeDelay(1500, 2500);

    const secret = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      const m = text.match(/\b([A-Z2-7]{16,64})\b/);
      return m ? m[1] : null;
    });
    if (!secret) return null;

    // Reddit usually asks to confirm with a code — generate locally if possible
    try {
      const { generateTotp } = require('../utils/totp');
      const code = generateTotp(secret);
      const codeInput = await page.$(
        'input[name="code"], input[autocomplete="one-time-code"], input[type="text"]'
      );
      if (codeInput) {
        await this.humanLikeTyping(
          page,
          'input[name="code"], input[autocomplete="one-time-code"], input[type="text"]',
          code
        );
        const confirm = await page.$('button[type="submit"], button:has-text("Verify"), button:has-text("Enable")');
        if (confirm) await confirm.click();
        await this.humanLikeDelay(1000, 2000);
      }
    } catch (_) {
      /* store secret even if confirm UI differs */
    }

    return secret;
  }

  async createXAccount(username, email, password, proxyConfig = null, emailToken = null) {
    let browser;
    try {
      const { browser: b, page } = await this.createBrowser(proxyConfig);
      browser = b;

      await page.goto('https://twitter.com/i/flow/signup', { waitUntil: 'networkidle' });
      await this.humanLikeDelay();

      const nameInput = await page.$('input[name="name"]');
      if (nameInput) {
        await this.humanLikeTyping(page, 'input[name="name"]', username);
        await this.humanLikeDelay();
        await page.keyboard.press('Enter');
        await this.humanLikeDelay(1000, 2000);
      }

      const emailInput = await page.$('input[autocomplete="email"]');
      if (emailInput) {
        await this.humanLikeTyping(page, 'input[autocomplete="email"]', email);
        await this.humanLikeDelay();
        await page.keyboard.press('Enter');
        await this.humanLikeDelay(1000, 2000);
      }

      const phoneInput = await page.$('input[autocomplete="tel"]');
      if (phoneInput) {
        throw new Error('Phone verification required - use SMS service');
      }

      const passwordInput = await page.$('input[type="password"]');
      if (passwordInput) {
        await this.humanLikeTyping(page, 'input[type="password"]', password);
        await this.humanLikeDelay();
        await page.keyboard.press('Enter');
        await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
      }

      if (emailToken) {
        try {
          const { link } = await mailTmService.pollForVerificationLink(emailToken, 60000, 3000);
          await page.goto(link, { waitUntil: 'networkidle' });
          await this.humanLikeDelay();
        } catch (verifyErr) {
          console.warn('X email verification polling failed:', verifyErr.message);
        }
      }

      return { success: true, username, email, password, email_verified: !!emailToken };
    } catch (error) {
      console.error('Error creating X account:', error);
      throw error;
    } finally {
      if (browser) await browser.close();
    }
  }

  /**
   * Reddit create+warm pilot using durable emails from email_accounts pool.
   * Serial only; records every attempt for NOC. Max 2 proxy rotations on network blocks.
   * @param {number} count - 1..5 recommended
   * @param {{ warm?: boolean, usernamePrefix?: string, source?: string }} opts
   */
  async createRedditFromPool(count, opts = {}) {
    const warm = opts.warm !== false;
    const source = opts.source || 'api_email_pool';
    const results = { created: [], errors: [], blocked: [], skipped: [] };

    for (let i = 0; i < count; i++) {
      const step = { index: i + 1 };
      try {
        const emailAccount = await this.claimEmailFromPool();
        if (!emailAccount) {
          const error = 'No unassigned email_accounts available';
          results.errors.push({ ...step, error });
          await this.recordAttempt({
            platform: 'reddit',
            status: 'skipped',
            errorClass: 'no_email',
            errorMessage: error,
            source,
          });
          break;
        }
        step.email = emailAccount.email;
        step.emailAccountId = emailAccount.id;

        const username = (
          opts.usernamePrefix
            ? `${opts.usernamePrefix}${Math.floor(Math.random() * 10000)}`
            : generateRealisticUsername('random') + Date.now().toString().slice(-4)
        ).slice(0, 20);
        const password = generatePassword(14);
        step.username = username;

        // At most 5 proxy tries — ISP first; rotate on network blocks and tunnel/timeout flakes.
        let proxyId = null;
        let created = null;
        let lastErr = null;
        for (let attempt = 1; attempt <= 5; attempt++) {
          proxyId = await this.claimProxyForNewAccount();
          step.proxyId = proxyId;
          if (!proxyId) {
            lastErr = new Error('No healthy US proxy available for create');
            break;
          }
          let proxyConfig = null;
          const proxyRow = await pool.query('SELECT * FROM proxies WHERE id = $1', [proxyId]);
          if (proxyRow.rows[0]) {
            if (!proxyService.isAssignableProxy(proxyRow.rows[0])) {
              lastErr = new Error(`Proxy ${proxyId} not assignable (cooled/degraded)`);
              continue;
            }
            proxyConfig = proxyService.formatProxyConfig(proxyRow.rows[0]);
            proxyConfig._proxyId = proxyId;
          }
          try {
            created = await this.createRedditAccount(
              username,
              emailAccount.email,
              password,
              proxyConfig,
              null,
              emailAccount
            );
            if (proxyId) await proxyService.updateProxyStats(proxyId, true);
            break;
          } catch (err) {
            lastErr = err;
            const msg = err.message || String(err);
            const netBlocked = /blocked by network security|js_challenge/i.test(msg);
            const proxyFlake =
              /ERR_TUNNEL|ERR_TIMED_OUT|ERR_PROXY|ERR_CONNECTION|tunnel_connection|proxy/i.test(msg);
            if (proxyId) {
              await proxyService.updateProxyStats(proxyId, false, {
                reason: netBlocked ? 'reddit_network_security' : msg.slice(0, 120),
              });
              if (netBlocked) {
                const cool = await proxyService.applyProxyCooldown(proxyId, 6, {
                  reason: 'reddit_network_security',
                  minConsecutive: 3,
                });
                console.warn(
                  `Reddit create: proxy ${proxyId} network-blocked — ` +
                    `${cool.action === 'cooldown' ? 'cooled 6h' : cool.action}, retry ${attempt}/5`
                );
              } else if (proxyFlake) {
                console.warn(
                  `Reddit create: proxy ${proxyId} flake (${msg.slice(0, 80)}) — retry ${attempt}/5`
                );
              }
            }
            if (!(netBlocked || proxyFlake) || attempt === 5) throw err;
          }
        }
        if (!created) throw lastErr || new Error('Reddit create failed');

        const credentials = {
          password,
          email: emailAccount.email,
          email_password: emailAccount.password,
          totp_secret: created.totp_secret || null,
          source: 'self_create_pool',
          needs_signup: false,
        };

        const inserted = await pool.query(
          `INSERT INTO social_accounts
             (platform, username, email, credentials, status, is_simulated, warmup_status, email_account_id)
           VALUES ('reddit', $1, $2, $3::jsonb, 'active', false, 'pending', $4)
           RETURNING *`,
          [username, emailAccount.email, JSON.stringify(credentials), emailAccount.id]
        );
        const account = inserted.rows[0];
        step.accountId = account.id;

        await pool.query(
          `UPDATE email_accounts
           SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
           WHERE id = $1`,
          [
            emailAccount.id,
            JSON.stringify({
              linked_reddit: username,
              linked_social_account_id: account.id,
              linked_at: new Date().toISOString(),
            }),
          ]
        );

        if (proxyId) {
          await proxyService.assignProxiesToAccount(account.id, [proxyId]);
        }

        if (created.cookies?.length) {
          await pool.query(
            `INSERT INTO browser_sessions (account_id, platform, cookies, session_data, user_agent)
             VALUES ($1, 'reddit', $2::jsonb, '{}'::jsonb, NULL)
             ON CONFLICT (account_id, platform)
             DO UPDATE SET cookies = $2::jsonb, updated_at = NOW()`,
            [account.id, JSON.stringify(created.cookies)]
          ).catch(() => {});
        }

        let warmResult = null;
        if (warm) {
          try {
            warmResult = await playwrightService.warmUpAccount(account.id, 'reddit');
          } catch (warmErr) {
            warmResult = { success: false, error: warmErr.message };
          }
        }

        await this.recordAttempt({
          platform: 'reddit',
          status: 'created',
          proxyId,
          emailAccountId: emailAccount.id,
          socialAccountId: account.id,
          username,
          email: emailAccount.email,
          source,
          detail: { warm: warmResult, captcha: created.captcha, totp: !!created.totp_secret },
        });

        results.created.push({
          ...step,
          totp: !!created.totp_secret,
          warm: warmResult,
          captcha: created.captcha,
        });

        // Conservative spacing between creates — avoid stampede / network blocks
        if (i < count - 1) await this.humanLikeDelay(45000, 90000);
      } catch (error) {
        const msg = error.message || String(error);
        const errorClass = this.classifyCreateError(msg);
        const entry = { ...step, error: msg, errorClass };
        const isBlocked = /CAPTCHA|captcha|sitekey|network security|js_challenge/i.test(msg);
        if (isBlocked) {
          results.blocked.push(entry);
        } else {
          results.errors.push(entry);
        }
        await this.recordAttempt({
          platform: 'reddit',
          status: isBlocked ? 'blocked' : 'attempt_failed',
          errorClass,
          errorMessage: msg,
          proxyId: step.proxyId || null,
          emailAccountId: step.emailAccountId || null,
          username: step.username || null,
          email: step.email || null,
          source,
        });
        console.error(`Reddit pool create #${i + 1} failed:`, msg);
        // Stop the batch early on security blocks — do not burn more proxies
        if (/network security|js_challenge/i.test(msg)) {
          results.skipped.push({
            reason: 'Stopped batch after network-security block',
            remaining: count - i - 1,
          });
          break;
        }
      }
    }

    return results;
  }

  /**
   * Orchestrated multi-platform create entrypoint.
   * Serial batches only; records telemetry; gates non-ready platforms.
   */
  async createAccounts(platform, count, emailDomain = null, usernamePrefix = null, proxyConfigs = [], opts = {}) {
    const catalog = this.getPlatformCatalog()[platform];
    if (!catalog) {
      throw new Error(`Unknown platform: ${platform}`);
    }

    const source = opts.source || (opts.useEmailPool ? 'api_email_pool' : 'api');
    const allowGated = opts.allowGated === true;

    if (!catalog.selfCreate || catalog.readiness !== 'ready') {
      if (!allowGated) {
        await this.recordAttempt({
          platform,
          status: 'skipped',
          errorClass: 'not_ready',
          errorMessage: catalog.notes,
          source,
          detail: { readiness: catalog.readiness, requested: count },
        });
        return {
          mode: 'gated',
          platform,
          readiness: catalog.readiness,
          created: [],
          errors: [],
          blocked: [],
          skipped: [
            {
              error: catalog.notes,
              readiness: catalog.readiness,
            },
          ],
          message: catalog.notes,
        };
      }
    }

    this.acquireBatchLock();
    try {
      if (platform === 'reddit' && opts.useEmailPool) {
        return await this.createRedditFromPool(count, {
          warm: opts.warm !== false,
          usernamePrefix,
          source,
        });
      }

      if (platform === 'reddit') {
        return await this.createRedditDomainBatch(
          count,
          emailDomain,
          usernamePrefix,
          proxyConfigs,
          source
        );
      }

      if (platform === 'x' && allowGated) {
        return await this.createXDomainBatch(
          count,
          emailDomain,
          usernamePrefix,
          proxyConfigs,
          source
        );
      }

      await this.recordAttempt({
        platform,
        status: 'skipped',
        errorClass: 'not_ready',
        errorMessage: `Self-create path not available for ${platform}`,
        source,
      });
      return {
        mode: 'unsupported',
        platform,
        created: [],
        errors: [{ error: `Self-create path not available for ${platform}` }],
        blocked: [],
        skipped: [],
      };
    } finally {
      this.releaseBatchLock();
    }
  }

  async createRedditDomainBatch(count, emailDomain, usernamePrefix, proxyConfigs, source) {
    const results = { created: [], errors: [], blocked: [], accounts: [] };
    for (let i = 0; i < count; i++) {
      const step = { index: i + 1 };
      try {
        const username = usernamePrefix
          ? `${usernamePrefix}${Math.floor(Math.random() * 10000)}`
          : `user${Date.now()}${i}`;
        const email = `${username}@${emailDomain}`;
        const password = generatePassword();
        step.username = username;
        step.email = email;

        let proxyId = null;
        let proxyConfig = proxyConfigs[i % (proxyConfigs.length || 1)] || null;
        if (!proxyConfig) {
          proxyId = await this.claimProxyForNewAccount();
          if (!proxyId) throw new Error('No healthy US proxy available for create');
          const proxyRow = await pool.query('SELECT * FROM proxies WHERE id = $1', [proxyId]);
          if (!proxyRow.rows[0] || !proxyService.isAssignableProxy(proxyRow.rows[0])) {
            throw new Error('No assignable proxy for create');
          }
          proxyConfig = proxyService.formatProxyConfig(proxyRow.rows[0]);
          proxyConfig._proxyId = proxyId;
        }
        step.proxyId = proxyId || proxyConfig?._proxyId || null;

        const account = await this.createRedditAccount(
          username,
          email,
          password,
          proxyConfig,
          null
        );
        if (step.proxyId) await proxyService.updateProxyStats(step.proxyId, true);

        const credentials = { password };
        if (account.totp_secret) credentials.totp_secret = account.totp_secret;
        credentials.source = 'self_create_domain';

        const result = await pool.query(
          `INSERT INTO social_accounts
           (platform, username, email, credentials, status, is_simulated, warmup_status)
           VALUES ('reddit', $1, $2, $3, 'active', false, 'pending')
           RETURNING *`,
          [username, email, JSON.stringify(credentials)]
        );
        const row = result.rows[0];
        if (step.proxyId) {
          await proxyService.assignProxiesToAccount(row.id, [step.proxyId]);
        }

        await this.recordAttempt({
          platform: 'reddit',
          status: 'created',
          proxyId: step.proxyId,
          socialAccountId: row.id,
          username,
          email,
          source,
        });
        results.created.push({ ...step, accountId: row.id });
        results.accounts.push(row);
        if (i < count - 1) await this.humanLikeDelay(45000, 90000);
      } catch (error) {
        const msg = error.message || String(error);
        const errorClass = this.classifyCreateError(msg);
        results.errors.push({ ...step, error: msg, errorClass });
        await this.recordAttempt({
          platform: 'reddit',
          status: 'attempt_failed',
          errorClass,
          errorMessage: msg,
          proxyId: step.proxyId || null,
          username: step.username || null,
          email: step.email || null,
          source,
        });
        if (step.proxyId) {
          await proxyService.updateProxyStats(step.proxyId, false, {
            reason: msg.slice(0, 120),
          });
        }
        console.error(`Failed to create reddit account ${i + 1}:`, msg);
      }
    }
    return results;
  }

  async createXDomainBatch(count, emailDomain, usernamePrefix, proxyConfigs, source) {
    const results = { created: [], errors: [], blocked: [], accounts: [] };
    // Hard cap: never mass-create X even when allowGated
    const capped = Math.min(count, 1);
    for (let i = 0; i < capped; i++) {
      const step = { index: i + 1 };
      try {
        let email;
        let emailToken;
        let username;
        if (emailDomain) {
          username = usernamePrefix
            ? `${usernamePrefix}${Math.floor(Math.random() * 10000)}`
            : `user${Date.now()}${i}`;
          email = `${username}@${emailDomain}`;
        } else {
          const inbox = await mailTmService.createInbox();
          email = inbox.email;
          emailToken = inbox.token;
          username = email.split('@')[0];
        }
        const password = generatePassword();
        step.username = username;
        step.email = email;

        const proxyConfig = proxyConfigs[i % (proxyConfigs.length || 1)] || null;
        const account = await this.createXAccount(
          username,
          email,
          password,
          proxyConfig,
          emailToken
        );

        const credentials = { password, source: 'self_create_x_gated' };
        if (emailToken) credentials.emailToken = emailToken;

        const result = await pool.query(
          `INSERT INTO social_accounts
           (platform, username, email, credentials, status, is_simulated, warmup_status)
           VALUES ('x', $1, $2, $3, 'active', false, 'pending')
           RETURNING *`,
          [username, email, JSON.stringify(credentials)]
        );
        const row = result.rows[0];
        await this.recordAttempt({
          platform: 'x',
          status: 'created',
          socialAccountId: row.id,
          username,
          email,
          source,
          detail: { email_verified: account.email_verified },
        });
        results.created.push({ ...step, accountId: row.id });
        results.accounts.push(row);
      } catch (error) {
        const msg = error.message || String(error);
        const errorClass = this.classifyCreateError(msg);
        results.errors.push({ ...step, error: msg, errorClass });
        await this.recordAttempt({
          platform: 'x',
          status: 'attempt_failed',
          errorClass,
          errorMessage: msg,
          username: step.username || null,
          email: step.email || null,
          source,
        });
      }
    }
    return results;
  }

  async cleanup() {
    for (const [accountId, browser] of this.activeBrowsers) {
      try {
        await browser.close();
        this.activeBrowsers.delete(accountId);
      } catch (error) {
        console.error(`Error cleaning up browser for account ${accountId}:`, error);
      }
    }
  }
}

module.exports = new AccountCreationService();
