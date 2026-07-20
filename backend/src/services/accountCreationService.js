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

chromium.use(stealth);

class AccountCreationService {
  constructor() {
    this.activeBrowsers = new Map();
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
    await page.click(selector);
    await this.humanLikeDelay(200, 500);
    for (const char of text) {
      await page.keyboard.type(char);
      await this.humanLikeDelay(50, 200);
    }
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
   */
  async claimEmailFromPool() {
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
       ORDER BY ea.id
       LIMIT 1`
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

    const free = await pool.query(
      `SELECT p.id FROM proxies p
       WHERE p.is_active = true
         AND p.country = 'US'
         AND NOT EXISTS (
           SELECT 1 FROM social_account_proxies sap
           WHERE sap.proxy_id = p.id AND sap.is_active = true
         )
       ORDER BY p.id
       LIMIT 1`
    );
    return free.rows[0]?.id || null;
  }

  async createRedditAccount(username, email, password, proxyConfig = null, emailToken = null, emailAccount = null) {
    let browser;
    const pageUrl = 'https://www.reddit.com/register/';
    try {
      const { browser: b, page } = await this.createBrowser(proxyConfig);
      browser = b;

      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.humanLikeDelay(1500, 3000);

      // Email-first flow (current Reddit) or classic multi-field
      const emailInput =
        (await page.$('input[name="email"]')) ||
        (await page.$('input[type="email"]')) ||
        (await page.$('#regEmail'));
      if (!emailInput) throw new Error('Reddit register: email input not found');

      await emailInput.click({ clickCount: 3 }).catch(() => {});
      await this.humanLikeTyping(page, 'input[name="email"], input[type="email"], #regEmail', email);
      await this.humanLikeDelay();

      const continueBtn = await page.$(
        'button:has-text("Continue"), button:has-text("Next"), button[type="submit"]'
      );
      if (continueBtn) {
        await continueBtn.click().catch(() => {});
        await this.humanLikeDelay(1000, 2000);
      }

      // Optional email verification code step
      const codeInput = await page.$(
        'input[name="code"], input[autocomplete="one-time-code"], input[placeholder*="code" i]'
      );
      if (codeInput && emailAccount) {
        console.log('Reddit asking for email verification code…');
        const verified = await emailInboxService.pollForVerification(emailAccount, {
          timeoutMs: 120000,
          fromIncludes: 'reddit',
        });
        if (!verified.code) throw new Error('No verification code in inbox');
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

      const userField =
        (await page.$('input[name="username"]')) || (await page.$('#regUsername'));
      const passField =
        (await page.$('input[name="password"]')) || (await page.$('#regPassword'));

      if (userField) {
        await this.humanLikeTyping(page, 'input[name="username"], #regUsername', username);
        await this.humanLikeDelay();
      }
      if (passField) {
        await this.humanLikeTyping(page, 'input[name="password"], #regPassword', password);
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
   * @param {number} count - 1..20
   * @param {{ warm?: boolean, usernamePrefix?: string }} opts
   */
  async createRedditFromPool(count, opts = {}) {
    const warm = opts.warm !== false;
    const results = { created: [], errors: [], blocked: [] };

    for (let i = 0; i < count; i++) {
      const step = { index: i + 1 };
      try {
        const emailAccount = await this.claimEmailFromPool();
        if (!emailAccount) {
          results.errors.push({ ...step, error: 'No unassigned email_accounts available' });
          break;
        }
        step.email = emailAccount.email;
        step.emailAccountId = emailAccount.id;

        const proxyId = await this.claimProxyForNewAccount();
        step.proxyId = proxyId;

        let proxyConfig = null;
        if (proxyId) {
          const proxyRow = await pool.query('SELECT * FROM proxies WHERE id = $1', [proxyId]);
          if (proxyRow.rows[0]) {
            proxyConfig = proxyService.formatProxyConfig(proxyRow.rows[0]);
            proxyConfig._proxyId = proxyId;
          }
        }

        const username = (
          opts.usernamePrefix
            ? `${opts.usernamePrefix}${Math.floor(Math.random() * 10000)}`
            : generateRealisticUsername('random') + Date.now().toString().slice(-4)
        ).slice(0, 20);
        const password = generatePassword(14);

        const created = await this.createRedditAccount(
          username,
          emailAccount.email,
          password,
          proxyConfig,
          null,
          emailAccount
        );

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
        step.username = username;

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

        results.created.push({
          ...step,
          totp: !!created.totp_secret,
          warm: warmResult,
          captcha: created.captcha,
        });

        if (i < count - 1) await this.humanLikeDelay(20000, 45000);
      } catch (error) {
        const msg = error.message || String(error);
        const entry = { ...step, error: msg };
        if (/CAPTCHA|captcha|sitekey/i.test(msg)) {
          results.blocked.push(entry);
        } else {
          results.errors.push(entry);
        }
        console.error(`Reddit pool create #${i + 1} failed:`, msg);
      }
    }

    return results;
  }

  async createAccounts(platform, count, emailDomain = null, usernamePrefix = null, proxyConfigs = [], opts = {}) {
    if (platform === 'reddit' && opts.useEmailPool) {
      return this.createRedditFromPool(count, {
        warm: opts.warm !== false,
        usernamePrefix,
      });
    }

    const accounts = [];

    for (let i = 0; i < count; i++) {
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

        const proxyConfig = proxyConfigs[i % proxyConfigs.length] || null;

        let account;
        switch (platform) {
          case 'reddit':
            account = await this.createRedditAccount(
              username,
              email,
              password,
              proxyConfig,
              emailToken
            );
            break;
          case 'x':
            account = await this.createXAccount(
              username,
              email,
              password,
              proxyConfig,
              emailToken
            );
            break;
          default:
            throw new Error(`Platform ${platform} not supported`);
        }

        const credentials = { password };
        if (emailToken) credentials.emailToken = emailToken;
        if (account.totp_secret) credentials.totp_secret = account.totp_secret;

        const result = await pool.query(
          `INSERT INTO social_accounts
           (platform, username, email, credentials, status, is_simulated, proxy_config, warmup_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
           RETURNING *`,
          [platform, username, email, credentials, 'active', false, proxyConfig]
        );

        accounts.push(result.rows[0]);

        if (i < count - 1) {
          await this.humanLikeDelay(30000, 60000);
        }
      } catch (error) {
        console.error(`Failed to create account ${i + 1}:`, error);
      }
    }

    return accounts;
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
