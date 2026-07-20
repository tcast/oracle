const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const pool = require('./db');
const fiveSimService = require('./fiveSimService');
const smsManService = require('./smsManService');
const captchaSolverService = require('./captchaSolverService');
const proxyService = require('./proxyService');
const { generatePassword } = require('../utils/passwordGenerator');
const { generateRealisticUsername } = require('../utils/nameGenerator');

// Apply stealth plugin
chromium.use(stealth);

/**
 * Email Account Creation Service
 * Automates creation of Yandex and GMX email accounts
 * Uses Playwright + Stealth for anti-detection
 * Integrates with SMS-Man for phone verification
 * Integrates with 2Captcha/CapSolver for CAPTCHA solving
 */
class EmailAccountCreationService {
  constructor() {
    this.activeBrowsers = new Map();
  }

  async cancelSms(provider, requestId) {
    if (!requestId) return;
    if (provider === 'smsman') {
      await smsManService.cancelRequest(requestId);
    } else {
      await fiveSimService.cancelRequest(requestId);
    }
  }

  /**
   * Create browser with anti-detection measures
   * Pattern: Reuses playwrightService approach
   */
  async createBrowser(proxyConfig = null) {
    const args = [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-web-security',
      '--disable-features=BlockInsecurePrivateNetworkRequests',
      '--disable-webrtc',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--disable-rtc-smoothness-algorithm',
    ];

    const options = {
      headless: true, // Headless for bulk operations
      args,
      ignoreDefaultArgs: ['--enable-automation'],
    };

    // Add proxy if provided
    if (proxyConfig) {
      const { _proxyId, ...cleanProxyConfig } = proxyConfig;
      options.proxy = cleanProxyConfig;
    }

    // Use system chromium in Docker, or downloaded chromium locally
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
                          process.env.CHROMIUM_PATH ||
                          undefined;

    if (executablePath) {
      options.executablePath = executablePath;
    }

    const browser = await chromium.launch(options);
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York',
      permissions: [],
      colorScheme: 'light',
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      ignoreHTTPSErrors: true,
    });

    // Anti-detection JavaScript injection
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });

      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });

      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });

      // Block WebRTC to prevent IP leaks
      if (window.RTCPeerConnection) window.RTCPeerConnection = undefined;
      if (window.RTCSessionDescription) window.RTCSessionDescription = undefined;
      if (window.RTCIceCandidate) window.RTCIceCandidate = undefined;
      if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = undefined;
      if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = undefined;
    });

    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    return { browser, context, page };
  }

  /**
   * Random delay to mimic human behavior
   */
  async humanLikeDelay(min = 500, max = 2000) {
    const delay = Math.floor(Math.random() * (max - min + 1) + min);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  /**
   * Type text with human-like character-by-character input
   */
  async humanLikeTyping(page, selector, text) {
    await page.click(selector);
    await this.humanLikeDelay(200, 500);

    for (const char of text) {
      await page.keyboard.type(char);
      await this.humanLikeDelay(50, 200);
    }
  }

  /**
   * Enter OTP — Yahoo now uses 6 separate digit boxes (verify-code-0..5).
   */
  async enterOtpCode(page, code) {
    const digits = String(code).replace(/\D/g, '');
    const splitBoxes = await page.$$('input[id^="verify-code-"]');
    if (splitBoxes.length >= digits.length && digits.length > 0) {
      for (let i = 0; i < digits.length; i++) {
        const box = await page.$(`#verify-code-${i}`);
        if (!box) break;
        await box.click({ force: true }).catch(() => {});
        await box.fill('');
        await box.type(digits[i], { delay: 80 });
        await this.humanLikeDelay(40, 120);
      }
      return;
    }

    const single =
      (await page.$('input[name="verificationCode"]')) ||
      (await page.$('input[name="code"]')) ||
      (await page.$('input[autocomplete="one-time-code"]'));
    if (!single) {
      throw new Error('OTP input not found');
    }
    await single.click({ force: true });
    await single.fill('');
    await single.type(digits, { delay: 60 });
  }

  /**
   * Create Yahoo email account
   * @param {string} username - Desired username
   * @param {string} password - Account password
   * @param {Object} proxyConfig - Proxy configuration (optional)
   * @returns {Promise<Object>} Account details
   */
  async createYahooAccount(username, password, proxyConfig = null) {
    let browser, smsRequestId;
    const startTime = Date.now();

    try {
      console.log(`\n🔧 Creating Yahoo account: ${username}`);

      const { browser: b, page } = await this.createBrowser(proxyConfig);
      browser = b;

      // Navigate to Yahoo signup
      console.log('   1/9 Navigating to Yahoo signup...');
      await page.goto('https://login.yahoo.com/account/create', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
      await this.humanLikeDelay(2000, 3000);

      // Generate fake name parts
      const firstName = username.split(/[._]/)[0] || 'User';
      const lastName = username.split(/[._]/)[1] || 'Account';

      // Fill first name
      console.log('   2/8 Filling first name...');
      await page.waitForSelector('#reg-firstName', { timeout: 15000 });
      await this.humanLikeTyping(page, '#reg-firstName', firstName);
      await this.humanLikeDelay();

      // Fill last name
      console.log('   3/8 Filling last name...');
      await this.humanLikeTyping(page, '#reg-lastName', lastName);
      await this.humanLikeDelay();

      // Fill email username
      console.log('   4/8 Filling email address...');
      await this.humanLikeTyping(page, '#reg-userId', username);
      await this.humanLikeDelay();

      // Fill password
      console.log('   5/8 Filling password...');
      const passwordField = await page.$('#reg-password, input[name="password"]');
      if (passwordField) {
        await this.humanLikeTyping(page, '#reg-password, input[name="password"]', password);
        await this.humanLikeDelay();
      }

      // Fill birthday (random date to look real)
      const randomMonth = Math.floor(Math.random() * 12) + 1;
      const randomDay = Math.floor(Math.random() * 28) + 1;
      const randomYear = 1990 + Math.floor(Math.random() * 15);

      const monthField = await page.$('#reg-month, input[name="mm"]');
      if (monthField) {
        await this.humanLikeTyping(page, '#reg-month, input[name="mm"]', randomMonth.toString().padStart(2, '0'));
        await this.humanLikeDelay(300, 500);
      }

      const dayField = await page.$('#reg-day, input[name="dd"]');
      if (dayField) {
        await this.humanLikeTyping(page, '#reg-day, input[name="dd"]', randomDay.toString());
        await this.humanLikeDelay(300, 500);
      }

      const yearField = await page.$('#reg-year, input[name="yyyy"]');
      if (yearField) {
        await this.humanLikeTyping(page, '#reg-year, input[name="yyyy"]', randomYear.toString());
        await this.humanLikeDelay();
      }

      // Handle CAPTCHA if present on signup form
      const captchaIframe = await page.$('iframe[src*="recaptcha"]');
      if (captchaIframe) {
        console.log('   📸 Solving CAPTCHA on signup form...');
        const siteKey = await page.evaluate(() => {
          const element = document.querySelector('[data-sitekey]');
          return element ? element.getAttribute('data-sitekey') : null;
        });

        if (siteKey) {
          const captchaToken = await captchaSolverService.solveCaptcha(siteKey, page.url(), 'recaptcha_v2');
          await captchaSolverService.injectCaptchaToken(page, captchaToken);
          await this.humanLikeDelay(2000, 3000);
        }
      }

      // Click Next to proceed to phone verification page
      console.log('   6/9 Submitting signup form...');
      await page.click('button:has-text("Next")');
      await this.humanLikeDelay(5000, 7000);

      // Check if Yahoo rejected the username
      const errorMessage = await page.$('text="This email address is not available"');
      if (errorMessage) {
        throw new Error('Username already taken - this should not happen with timestamp suffix');
      }

      // NOW we should be on "Add your phone number" page
      console.log('   7/9 Waiting for phone verification page...');
      await page.waitForSelector('text="Add your phone number"', { timeout: 15000 });
      console.log('   ✅ Phone verification page loaded');

      // Ensure US country code on Yahoo phone page (USA-only policy)
      const countrySelectors = [
        'select[name="shortCountryCode"]',
        'select#shortCountryCode',
        'select[name="countryCode"]',
        'select[aria-label*="country" i]',
      ];
      for (const sel of countrySelectors) {
        const el = await page.$(sel);
        if (!el) continue;
        try {
          await page.selectOption(sel, { value: 'US' });
        } catch (_) {
          try {
            await page.selectOption(sel, { label: 'United States' });
          } catch (__) {
            /* keep current selection */
          }
        }
        break;
      }

      // Request USA phone number from SMS-Man (USA-only; 5sim fallback)
      console.log('   8/9 Requesting USA phone number from SMS-Man...');
      let smsProvider = 'smsman';
      let smsRequest;
      try {
        smsRequest = await smsManService.getNumber('US', 'yahoo');
      } catch (smsManErr) {
        console.warn(`   SMS-Man failed (${smsManErr.message}); falling back to 5SIM USA...`);
        smsProvider = '5sim';
        smsRequest = await fiveSimService.getNumber('usa', 'yahoo');
      }
      if (smsRequest.country && smsRequest.country !== 'usa') {
        await this.cancelSms(smsProvider, smsRequest.id);
        throw new Error(`Refusing non-US SMS country: ${smsRequest.country}`);
      }
      if (!/^\+1\d{10}$/.test(String(smsRequest.number || '').replace(/\s/g, ''))) {
        await this.cancelSms(smsProvider, smsRequest.id);
        throw new Error(`Refusing non-US phone number: ${smsRequest.number}`);
      }
      smsRequestId = smsRequest.id;
      this._lastSmsProvider = smsProvider;

      // Enter phone number on verification page
      console.log(`   Entering phone: ${smsRequest.number}...`);
      const phoneInput = await page.$('input[type="tel"], input[name="phone"]');
      if (phoneInput) {
        // National number only; Yahoo country dropdown is US
        const phoneNumber = smsRequest.number.replace(/^\+1/, '').replace(/\D/g, '');
        await this.humanLikeTyping(page, 'input[type="tel"], input[name="phone"]', phoneNumber);
        await this.humanLikeDelay(2000, 3000);
      }

      // Click "Get code by text" button
      console.log('   Requesting verification code...');
      await page.click('button:has-text("Get code by text")');
      await this.humanLikeDelay(3000, 5000);

      // Wait for SMS verification code
      console.log(`   9/9 Waiting for SMS verification code (${smsProvider})...`);
      const verification = smsProvider === 'smsman'
        ? await smsManService.getVerificationCode(smsRequestId, 180000)
        : await fiveSimService.getVerificationCode(smsRequestId, 180000);

      // Enter verification code
      console.log(`   Entering code: ${verification.code}...`);
      await page.waitForSelector(
        'input[id^="verify-code-"], input[name="verificationCode"], input[id*="code"], input[autocomplete="one-time-code"]',
        { timeout: 15000 }
      );
      await this.enterOtpCode(page, verification.code);
      await this.humanLikeDelay();

      // Submit verification (some Yahoo flows auto-advance after last digit)
      const submitBtn = await page.$('button[type="submit"]:not([disabled])');
      if (submitBtn) {
        await submitBtn.click({ force: true }).catch(() => page.keyboard.press('Enter'));
      } else {
        await page.keyboard.press('Enter').catch(() => {});
      }
      await this.humanLikeDelay(5000, 7000);

      // Verify success - look for Yahoo mail indicators
      const successIndicators = [
        'text=Welcome',
        'a[href*="mail.yahoo.com"]',
        '#ybarMailIcon',
        'button[aria-label*="account"]'
      ];

      let success = false;
      for (const selector of successIndicators) {
        try {
          if (await page.isVisible(selector)) {
            success = true;
            break;
          }
        } catch (e) {
          // Selector not found, continue
        }
      }

      if (!success) {
        throw new Error('Yahoo account creation verification failed');
      }

      const email = `${username}@yahoo.com`;
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      console.log(`   ✅ Yahoo account created successfully in ${duration}s`);

      return {
        success: true,
        provider: 'yahoo',
        email,
        username,
        password,
        phone: smsRequest.number,
        phoneProvider: smsProvider
      };

    } catch (error) {
      console.error(`   ❌ Yahoo account creation failed:`, error.message);

      // Cancel SMS request if it exists
      if (smsRequestId) {
        await this.cancelSms(this._lastSmsProvider || 'smsman', smsRequestId);
      }

      throw error;
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  /**
   * Create GMX email account
   * @param {string} username - Desired username
   * @param {string} password - Account password
   * @param {Object} proxyConfig - Proxy configuration (optional)
   * @returns {Promise<Object>} Account details
   */
  async createGMXAccount(username, password, proxyConfig = null) {
    let browser, smsRequestId;
    const startTime = Date.now();

    try {
      console.log(`\n🔧 Creating GMX account: ${username}`);

      const { browser: b, page } = await this.createBrowser(proxyConfig);
      browser = b;

      // Navigate to GMX registration
      console.log('   1/9 Navigating to GMX signup...');
      await page.goto('https://www.gmx.com/mail/create-email-address/', {
        waitUntil: 'networkidle',
        timeout: 30000
      });
      await this.humanLikeDelay(1000, 2000);

      // Fill first name (random)
      console.log('   2/9 Filling personal details...');
      const firstName = `User${Math.floor(Math.random() * 10000)}`;
      const lastName = `Account${Math.floor(Math.random() * 10000)}`;

      await this.humanLikeTyping(page, 'input[name="firstName"]', firstName);
      await this.humanLikeDelay();

      await this.humanLikeTyping(page, 'input[name="lastName"]', lastName);
      await this.humanLikeDelay();

      // Fill email username
      console.log('   3/9 Filling email username...');
      await this.humanLikeTyping(page, 'input[name="email"]', username);
      await this.humanLikeDelay();

      // Fill password
      console.log('   4/9 Filling password...');
      await this.humanLikeTyping(page, 'input[name="password"]', password);
      await this.humanLikeDelay();

      // Confirm password
      await this.humanLikeTyping(page, 'input[name="passwordConfirm"]', password);
      await this.humanLikeDelay();

      // Handle CAPTCHA
      console.log('   5/9 Checking for CAPTCHA...');
      const captchaIframe = await page.$('iframe[src*="recaptcha"]');

      if (captchaIframe) {
        console.log('   📸 CAPTCHA detected, solving...');

        const siteKey = await page.evaluate(() => {
          const element = document.querySelector('[data-sitekey]');
          return element ? element.getAttribute('data-sitekey') : null;
        });

        if (siteKey) {
          const captchaToken = await captchaSolverService.solveCaptcha(
            siteKey,
            page.url(),
            'recaptcha_v2'
          );

          await captchaSolverService.injectCaptchaToken(page, captchaToken);
          await this.humanLikeDelay(1000, 2000);
        }
      }

      // Request USA phone number (SMS-Man first)
      console.log('   6/9 Requesting USA phone number...');
      let smsProvider = 'smsman';
      let smsRequest;
      try {
        smsRequest = await smsManService.getNumber('US', 'gmx');
      } catch (smsManErr) {
        console.warn(`   SMS-Man failed (${smsManErr.message}); falling back to 5SIM USA...`);
        smsProvider = '5sim';
        smsRequest = await fiveSimService.getNumber('usa', 'gmx');
      }
      if (!/^\+1\d{10}$/.test(String(smsRequest.number || '').replace(/\s/g, ''))) {
        await this.cancelSms(smsProvider, smsRequest.id);
        throw new Error(`Refusing non-US phone number: ${smsRequest.number}`);
      }
      smsRequestId = smsRequest.id;
      this._lastSmsProvider = smsProvider;

      // Enter phone number
      console.log(`   7/9 Entering phone: ${smsRequest.number}...`);
      const phoneInput = await page.$('input[name="phone"], input[type="tel"]');
      if (phoneInput) {
        await this.humanLikeTyping(page, 'input[name="phone"], input[type="tel"]', smsRequest.number);
        await this.humanLikeDelay();
      }

      // Submit registration form
      await page.click('button[type="submit"]');
      await this.humanLikeDelay(2000, 3000);

      // Wait for SMS verification code
      console.log(`   8/9 Waiting for SMS verification (${smsProvider})...`);
      const verification = smsProvider === 'smsman'
        ? await smsManService.getVerificationCode(smsRequestId, 180000)
        : await fiveSimService.getVerificationCode(smsRequestId, 180000);

      // Enter verification code
      console.log(`   9/9 Entering verification code: ${verification.code}...`);
      const codeInput = await page.$('input[name="verificationCode"], input[name="code"]');
      if (codeInput) {
        await this.humanLikeTyping(page, 'input[name="verificationCode"], input[name="code"]', verification.code);
        await this.humanLikeDelay();

        await page.click('button[type="submit"]');
        await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 });
      }

      // Verify success
      const successIndicators = [
        'text=Welcome',
        'text=Inbox',
        'a[href*="mail.gmx.com"]'
      ];

      let success = false;
      for (const selector of successIndicators) {
        try {
          if (await page.isVisible(selector)) {
            success = true;
            break;
          }
        } catch (e) {
          // Selector not found, continue
        }
      }

      if (!success) {
        throw new Error('GMX account creation verification failed');
      }

      const email = `${username}@gmx.com`;
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      console.log(`   ✅ GMX account created successfully in ${duration}s`);

      return {
        success: true,
        provider: 'gmx',
        email,
        username,
        password,
        phone: smsRequest.number,
        phoneProvider: this._lastSmsProvider || 'smsman'
      };

    } catch (error) {
      console.error(`   ❌ GMX account creation failed:`, error.message);

      if (smsRequestId) {
        await this.cancelSms(this._lastSmsProvider || 'smsman', smsRequestId);
      }

      throw error;
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  /**
   * Create multiple email accounts in batch
   * @param {string} provider - 'yandex' or 'gmx'
   * @param {number} count - Number of accounts to create (1-50)
   * @param {string} nameStyle - Style of username ('professional', 'casual', 'tech', 'random')
   * @param {boolean} useProxies - Whether to use proxy rotation
   * @returns {Promise<Object>} Results with success and failed arrays
   */
  async createEmailAccounts(provider, count, nameStyle = 'random', useProxies = true) {
    console.log(`\n🚀 Starting batch creation: ${count} ${provider} accounts`);
    console.log(`   Name style: ${nameStyle}`);
    console.log(`   Using proxies: ${useProxies}`);

    const accounts = [];
    const errors = [];
    // USA-only HTTP/HTTPS residential proxies (Playwright doesn't support SOCKS5 auth)
    const allProxies = useProxies
      ? await proxyService.getActiveProxies({ is_residential: true, country: 'US' })
      : [];
    const proxies = allProxies.filter(p => p.type === 'http' || p.type === 'https');

    if (useProxies && proxies.length === 0) {
      throw new Error('No US residential HTTP proxies available (USA-only policy)');
    }

    for (let i = 0; i < count; i++) {
      const accountNumber = i + 1;
      console.log(`\n📧 Creating account ${accountNumber}/${count}...`);

      try {
        // Generate realistic username and password with timestamp for guaranteed uniqueness
        const baseUsername = generateRealisticUsername(nameStyle);
        const timestamp = Date.now().toString().slice(-6); // Last 6 digits of timestamp
        const username = `${baseUsername}${timestamp}`;
        const password = generatePassword(16);

        // Rotate proxy if available
        const proxyConfig = proxies.length > 0 ?
          proxyService.formatProxyConfig(proxies[i % proxies.length]) : null;

        if (proxyConfig) {
          console.log(`   Using proxy: ${proxyConfig.server}`);
        }

        // Create account based on provider
        let result;
        if (provider === 'yahoo') {
          result = await this.createYahooAccount(username, password, proxyConfig);
        } else if (provider === 'gmx') {
          result = await this.createGMXAccount(username, password, proxyConfig);
        } else {
          throw new Error(`Unsupported provider: ${provider}`);
        }

        // Store in database
        const dbResult = await pool.query(
          `INSERT INTO email_accounts
           (provider, email, username, password, phone_number, phone_provider,
            status, is_verified, verification_date, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9)
           RETURNING *`,
          [
            result.provider,
            result.email,
            result.username,
            result.password,
            result.phone,
            result.phoneProvider,
            'active',
            true,
            JSON.stringify({ created_by: 'automation', proxy_used: !!proxyConfig })
          ]
        );

        accounts.push(dbResult.rows[0]);
        console.log(`   ✅ Account ${accountNumber}/${count} created and stored`);

        // Rate limiting between accounts (30-60 seconds)
        if (i < count - 1) {
          const delaySeconds = Math.floor((30 + Math.random() * 30));
          console.log(`   ⏸️  Waiting ${delaySeconds}s before next account...`);
          await this.humanLikeDelay(30000, 60000);
        }

      } catch (error) {
        console.error(`   ❌ Account ${accountNumber}/${count} failed:`, error.message);

        errors.push({
          index: i,
          attemptNumber: accountNumber,
          error: error.message,
          timestamp: new Date(),
          provider
        });

        // Continue with next account (don't fail entire batch)
      }
    }

    const successRate = ((accounts.length / count) * 100).toFixed(1);
    console.log(`\n📊 Batch creation complete:`);
    console.log(`   ✅ Successful: ${accounts.length}/${count} (${successRate}%)`);
    console.log(`   ❌ Failed: ${errors.length}/${count}`);

    return {
      success: accounts,
      failed: errors,
      successCount: accounts.length,
      failureCount: errors.length,
      successRate: parseFloat(successRate),
      provider
    };
  }

  /**
   * Test login for existing email account
   * @param {number} emailAccountId - Email account ID
   * @returns {Promise<boolean>} Login success
   */
  async testEmailLogin(emailAccountId) {
    let browser;

    try {
      const result = await pool.query(
        'SELECT * FROM email_accounts WHERE id = $1',
        [emailAccountId]
      );

      if (result.rows.length === 0) {
        throw new Error('Email account not found');
      }

      const account = result.rows[0];
      const { browser: b, page } = await this.createBrowser();
      browser = b;

      let loginUrl, usernameSelector, passwordSelector, successSelector;

      if (account.provider === 'yandex') {
        loginUrl = 'https://passport.yandex.com/auth';
        usernameSelector = 'input[name="login"]';
        passwordSelector = 'input[name="passwd"]';
        successSelector = '[data-bem*="user-account"]';
      } else if (account.provider === 'gmx') {
        loginUrl = 'https://www.gmx.com/login/';
        usernameSelector = 'input[name="email"]';
        passwordSelector = 'input[name="password"]';
        successSelector = 'a[href*="mail.gmx.com"]';
      }

      await page.goto(loginUrl, { waitUntil: 'networkidle' });
      await this.humanLikeDelay();

      await this.humanLikeTyping(page, usernameSelector, account.username);
      await this.humanLikeDelay();

      await this.humanLikeTyping(page, passwordSelector, account.password);
      await this.humanLikeDelay();

      await page.click('button[type="submit"]');
      await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 });

      const loggedIn = await page.isVisible(successSelector);

      // Update database
      await pool.query(
        `UPDATE email_accounts
         SET last_login_test = NOW(), login_test_success = $1
         WHERE id = $2`,
        [loggedIn, emailAccountId]
      );

      return loggedIn;

    } catch (error) {
      console.error('Error testing email login:', error);
      throw error;
    } finally {
      if (browser) await browser.close();
    }
  }

  /**
   * Cleanup active browsers
   */
  async cleanup() {
    for (const [id, browser] of this.activeBrowsers) {
      try {
        await browser.close();
        this.activeBrowsers.delete(id);
      } catch (error) {
        console.error(`Error cleaning up browser ${id}:`, error);
      }
    }
  }
}

module.exports = new EmailAccountCreationService();
