const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const pool = require('./db');
const proxyService = require('./proxyService');
const { buildStickyProfile } = require('./deviceProfiles');
const { classifyFailure } = require('./failureClassifier');
const { generateTotp } = require('../utils/totp');

chromium.use(stealth);

class PlaywrightService {
  constructor() {
    this.activeBrowsers = new Map();
  }

  pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1) + min);
  }

  async humanLikeDelay(min = 600, max = 2500) {
    const delay = this.randomBetween(min, max);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  async variableDelay(baseMs = 1000) {
    const jitter = Math.floor(baseMs * (0.2 + Math.random() * 0.6));
    await new Promise(resolve => setTimeout(resolve, jitter));
  }

  /**
   * Sticky fingerprint per account. Prefer Android when the assigned proxy is mobile.
   */
  async getOrCreateDeviceProfile(accountId, { preferMobile = false, forceDesktop = false } = {}) {
    const existing = await pool.query(
      'SELECT device_profile FROM social_accounts WHERE id = $1',
      [accountId]
    );
    let profile = existing.rows[0]?.device_profile;
    if (typeof profile === 'string') {
      try { profile = JSON.parse(profile); } catch { profile = null; }
    }

    // Reassign if missing, or if we must force desktop but currently have mobile
    const needsReassign =
      !profile ||
      !profile.userAgent ||
      !profile.viewport ||
      (forceDesktop && profile.platform === 'android');

    if (!needsReassign) {
      return profile;
    }

    profile = buildStickyProfile({
      preferMobile: forceDesktop ? false : preferMobile,
      forceDesktop,
    });
    await pool.query(
      'UPDATE social_accounts SET device_profile = $2 WHERE id = $1',
      [accountId, JSON.stringify(profile)]
    );
    console.log(
      `Assigned device profile ${profile.label} (${profile.platform}) to account ${accountId}`
    );
    return profile;
  }

  async simulateMouseMovement(page, fromX, fromY, toX, toY) {
    const steps = this.randomBetween(8, 18);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = fromX + (toX - fromX) * t + Math.sin(t * Math.PI) * this.randomBetween(-15, 15);
      const y = fromY + (toY - fromY) * t + Math.cos(t * Math.PI * 0.5) * this.randomBetween(-10, 10);
      await page.mouse.move(Math.round(x), Math.round(y));
      await new Promise(resolve => setTimeout(resolve, this.randomBetween(5, 15)));
    }
  }

  async humanLikeTyping(page, selector, text) {
    const el = await page.$(selector);
    if (!el) {
      const els = await page.$$(selector);
      if (els.length === 0) throw new Error(`Element not found: ${selector}`);
    }
    await page.click(selector);
    await this.humanLikeDelay(150, 400);

    for (const char of text) {
      await page.keyboard.type(char);
      await this.variableDelay(this.randomBetween(30, 120));
    }
  }

  async randomScroll(page) {
    try {
      await page.evaluate(() => {
        const root = document.scrollingElement || document.documentElement || document.body;
        if (!root) return;
        const maxScroll = Math.max((root.scrollHeight || 0) - window.innerHeight, 100);
        window.scrollTo({
          top: Math.floor(Math.random() * maxScroll),
          behavior: 'smooth'
        });
      });
      await this.humanLikeDelay(400, 1200);
    } catch {
      // Page may still be navigating; ignore scroll failures.
    }
  }

  async randomMouseMove(page) {
    const vp = page.viewportSize();
    const toX = this.randomBetween(100, vp.width - 100);
    const toY = this.randomBetween(100, vp.height - 100);
    await page.mouse.move(toX, toY);
    await this.humanLikeDelay(100, 300);
  }

  async createBrowser(proxyConfig = null, retryWithoutProxy = true, deviceProfile = null) {
    const profile = deviceProfile || buildStickyProfile({ preferMobile: false });
    const userAgent = profile.userAgent;
    const viewport = profile.viewport;
    const screen = profile.screen || {
      width: viewport.width,
      height: viewport.height,
      availWidth: viewport.width,
      availHeight: viewport.height,
      colorDepth: 24,
      pixelDepth: 24,
    };
    const isMobile = !!profile.isMobile;
    const hasTouch = !!profile.hasTouch;
    const timezone = profile.timezoneId || this.pickRandom([
      'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    ]);
    const isMac = /Macintosh|Mac OS X/i.test(userAgent);

    const args = [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-web-security',
      '--disable-features=BlockInsecurePrivateNetworkRequests',
      '--disable-webrtc',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--disable-rtc-smoothness-algorithm',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ];

    if (isMac) args.push('--use-mock-keychain');

    const options = {
      headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
      args,
      ignoreDefaultArgs: ['--enable-automation'],
    };

    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
      options.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    }

    if (proxyConfig) {
      const { _proxyId, ...cleanProxyConfig } = proxyConfig;
      options.proxy = cleanProxyConfig;
    }

    try {
      const browser = await chromium.launch(options);

      const context = await browser.newContext({
        viewport,
        userAgent,
        locale: profile.locale || 'en-US',
        timezoneId: timezone,
        permissions: [],
        colorScheme: 'light',
        deviceScaleFactor: profile.deviceScaleFactor || 1,
        isMobile,
        hasTouch,
        geolocation: { latitude: 40.7128, longitude: -74.0060 },
      });

      const fp = {
        maxTouchPoints: profile.maxTouchPoints ?? (hasTouch ? 5 : 0),
        hardwareConcurrency: profile.hardwareConcurrency || 8,
        deviceMemory: profile.deviceMemory || 8,
        webglVendor: profile.webglVendor || 'Intel Inc.',
        webglRenderer: profile.webglRenderer || 'Intel Iris OpenGL Engine',
        screen,
        isMobile,
      };

      await context.addInitScript((fp) => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });

        Object.defineProperty(navigator, 'plugins', {
          get: () => (fp.isMobile ? [] : [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
            { name: 'Native Client', filename: 'internal-nacl-plugin' },
          ]),
        });

        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en'],
        });

        Object.defineProperty(navigator, 'hardwareConcurrency', {
          get: () => fp.hardwareConcurrency,
        });

        Object.defineProperty(navigator, 'deviceMemory', {
          get: () => fp.deviceMemory,
        });

        Object.defineProperty(navigator, 'maxTouchPoints', {
          get: () => fp.maxTouchPoints,
        });

        if (fp.isMobile) {
          Object.defineProperty(navigator, 'platform', { get: () => 'Linux armv8l' });
        }

        try {
          Object.defineProperty(window.screen, 'width', { get: () => fp.screen.width });
          Object.defineProperty(window.screen, 'height', { get: () => fp.screen.height });
          Object.defineProperty(window.screen, 'availWidth', { get: () => fp.screen.availWidth });
          Object.defineProperty(window.screen, 'availHeight', { get: () => fp.screen.availHeight });
          Object.defineProperty(window.screen, 'colorDepth', { get: () => fp.screen.colorDepth });
          Object.defineProperty(window.screen, 'pixelDepth', { get: () => fp.screen.pixelDepth });
        } catch (_) { /* ignore */ }

        if (window.chrome && window.chrome.runtime) {
          Object.defineProperty(window.chrome, 'runtime', {
            get: () => ({ id: undefined }),
          });
        }

        const getParameter = WebGLRenderingContext.prototype.getParameter;
        if (getParameter) {
          WebGLRenderingContext.prototype.getParameter = function (param) {
            if (param === 37445) return fp.webglVendor;
            if (param === 37446) return fp.webglRenderer;
            return getParameter.apply(this, arguments);
          };
        }

        const blockWebRTC = () => {
          if (window.RTCPeerConnection) window.RTCPeerConnection = undefined;
          if (window.RTCSessionDescription) window.RTCSessionDescription = undefined;
          if (window.RTCIceCandidate) window.RTCIceCandidate = undefined;
          if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = undefined;
          if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = undefined;
        };
        blockWebRTC();
      }, fp);

      Object.defineProperty(context, '_userAgent', { value: userAgent });
      Object.defineProperty(context, '_viewport', { value: viewport });
      Object.defineProperty(context, '_deviceProfile', { value: profile });

      const page = await context.newPage();
      page.setDefaultTimeout(45000);

      await page.setViewportSize(viewport);

      return { browser, context, page, proxyConfig, deviceProfile: profile };
    } catch (error) {
      if (proxyConfig && retryWithoutProxy) {
        console.warn('Browser launch failed with proxy, retrying without proxy:', error.message);
        return this.createBrowser(null, false, deviceProfile);
      }
      throw error;
    }
  }

  async createBrowserForAccount(accountId, maxRetries = 2, { requireProxy = false, skipProxy = false } = {}) {
    let lastError;
    let attempt = 0;

    if (skipProxy) {
      console.log(`Skipping proxy for account ${accountId} (direct connection)`);
      const forceDesktop = true;
      const deviceProfile = await this.getOrCreateDeviceProfile(accountId, {
        preferMobile: false,
        forceDesktop,
      });
      const result = await this.createBrowser(null, false, deviceProfile);
      result.proxyConfig = null;
      result.accountId = accountId;
      this._trackBrowser(accountId, result.browser);
      return result;
    }

    while (attempt < maxRetries) {
      try {
        const proxyConfig = await proxyService.getNextProxyForAccount(accountId);

        if (!proxyConfig) {
          if (requireProxy || process.env.REQUIRE_PROXY_FOR_LIVE === 'true') {
            throw new Error(`No proxy assigned to account ${accountId} (required for live)`);
          }
          console.log(`No proxy assigned to account ${accountId}, using direct connection`);
        } else {
          console.log(`Using proxy for account ${accountId} (attempt ${attempt + 1}):`, proxyConfig.server);
        }

        // Prefer Android for mobile ProxyBase pools — except X, whose mobile web
        // aggressively pushes the app and breaks login/automation.
        let preferMobile = false;
        let forceDesktop = false;
        try {
          const account = await this.getAccount(accountId);
          forceDesktop =
            account.platform === 'x' ||
            account.platform === 'instagram' ||
            account.platform === 'linkedin' ||
            account.platform === 'tiktok';
          if (!forceDesktop) {
            const proxies = await proxyService.getAccountProxies(accountId, false);
            preferMobile = proxies.some((p) => proxyService.isMobileProxy(p));
          }
        } catch (_) { /* ignore */ }

        const deviceProfile = await this.getOrCreateDeviceProfile(accountId, {
          preferMobile: forceDesktop ? false : preferMobile,
          forceDesktop,
        });
        const result = await this.createBrowser(proxyConfig, false, deviceProfile);
        result.proxyConfig = proxyConfig;
        result.accountId = accountId;

        this._trackBrowser(accountId, result.browser);

        return result;
      } catch (error) {
        lastError = error;
        attempt++;
        console.warn(`Browser creation failed (attempt ${attempt}/${maxRetries}):`, error.message);

        if (attempt < maxRetries) {
          await this.humanLikeDelay(1000, 2000);
        }
      }
    }

    if (requireProxy || process.env.REQUIRE_PROXY_FOR_LIVE === 'true') {
      throw lastError || new Error(`No proxy available for account ${accountId}`);
    }

    console.log(`All proxy attempts failed for account ${accountId}, trying direct connection`);
    try {
      const deviceProfile = await this.getOrCreateDeviceProfile(accountId, { preferMobile: false, forceDesktop: true });
      const result = await this.createBrowser(null, false, deviceProfile);
      result.proxyConfig = null;
      result.accountId = accountId;
      this._trackBrowser(accountId, result.browser);
      return result;
    } catch (finalError) {
      console.error('Browser creation failed even without proxy:', finalError);
      throw lastError || finalError;
    }
  }

  async restoreSession(page, platform, accountId) {
    try {
      const result = await pool.query(
        `SELECT cookies, session_data FROM browser_sessions
         WHERE account_id = $1 AND platform = $2
         ORDER BY updated_at DESC LIMIT 1`,
        [accountId, platform]
      );
      if (result.rows.length === 0) return false;

      const { cookies, session_data } = result.rows[0];

      if (cookies) {
        const parsed = typeof cookies === 'string' ? JSON.parse(cookies) : cookies;
        if (Array.isArray(parsed) && parsed.length > 0) {
          await page.context().addCookies(parsed);
        }
      }

      if (session_data) {
        const parsed = typeof session_data === 'string' ? JSON.parse(session_data) : session_data;
        if (parsed && parsed.localStorage) {
          await page.evaluate((storage) => {
            for (const [key, value] of Object.entries(storage)) {
              try { localStorage.setItem(key, value); } catch (e) {}
            }
          }, parsed.localStorage);
        }
      }

      return true;
    } catch (error) {
      console.error(`Error restoring session for ${platform}/${accountId}:`, error);
      return false;
    }
  }

  async persistSession(page, platform, accountId) {
    try {
      const cookies = await page.context().cookies();
      const localStorage = await page.evaluate(() => {
        const data = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          data[key] = localStorage.getItem(key);
        }
        return data;
      });

      await pool.query(
        `INSERT INTO browser_sessions (account_id, platform, cookies, session_data, user_agent)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (account_id, platform)
         DO UPDATE SET cookies = $3, session_data = $4, user_agent = $5, updated_at = NOW()`,
        [accountId, platform, JSON.stringify(cookies), JSON.stringify({ localStorage }), page.context()._userAgent || '']
      );
    } catch (error) {
      console.error(`Error persisting session for ${platform}/${accountId}:`, error);
    }
  }

  async verifySessionAlive(page, platform) {
    try {
      switch (platform) {
        case 'reddit':
          await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
          await this.humanLikeDelay(800, 1500);
          // New Reddit often hides user-menu selectors inside custom elements / shadow DOM.
          // Prefer content signals that remain when logged in.
          const redditLoggedIn = await page.evaluate(() => {
            const text = (document.body?.innerText || '').slice(0, 4000);
            if (/Expand user menu|Open inbox|Create post/i.test(text)) return true;
            if (document.querySelector('#USER_DROPDOWN_ID, [aria-label="Expand user menu"], [aria-label="User menu"]')) {
              return true;
            }
            // Logged-out pages advertise login/signup prominently
            if (/Log( ?In| in)|Sign Up/i.test(text) && /Advertise on Reddit/i.test(text) && !/Open inbox/i.test(text)) {
              return false;
            }
            return false;
          });
          return !!redditLoggedIn;
        case 'x':
          await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
          await this.humanLikeDelay(800, 1500);
          const xUser = await page.$(
            '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Home_Link"], [data-testid="BottomBar_Home_Link"], a[href="/home"]'
          );
          if (xUser) return true;
          return await page.evaluate(() => {
            const text = (document.body?.innerText || '').slice(0, 3000);
            if (/Sign in|Create account|Already have an account/i.test(text) && !/Home|Notifications|Messages/i.test(text)) {
              return false;
            }
            return !!document.querySelector('[data-testid="primaryColumn"], [aria-label="Home timeline"]');
          });
        case 'linkedin':
          await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });
          await this.humanLikeDelay(800, 1500);
          if (/authwall|\/login|\/signup|\/uas\//i.test(page.url())) return false;
          return await page.evaluate(() => {
            const text = (document.body?.innerText || '').slice(0, 3500);
            if (/Sign in|Join now|Forgot password/i.test(text) && /Email or phone/i.test(text)) {
              return false;
            }
            if (/authwall|Sign Up|Join LinkedIn/i.test(text) && !/Start a post|Messaging|My Network/i.test(text)) {
              return false;
            }
            return !!(
              document.querySelector(
                '[data-control-name="nav.settings"], .feed-identity-module, .global-nav__me, img.global-nav__me-photo, a[href*="/feed/"]'
              ) ||
              /Start a post|Messaging|My Network|Notifications/i.test(text)
            );
          });
        case 'instagram':
          await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
          await this.humanLikeDelay(800, 1500);
          return await page.evaluate(() => {
            const text = (document.body?.innerText || '').slice(0, 3000);
            if (/Log in|Sign up/i.test(text) && /Create a new account|Forgot password/i.test(text)) {
              return false;
            }
            return !!(
              document.querySelector('svg[aria-label="Home"], a[href="/"]') &&
              (document.querySelector('svg[aria-label="New post"], svg[aria-label="Profile"], img[alt*="profile"]') ||
                /Home|Search|Reels|Messages/i.test(text))
            );
          });
        case 'tiktok':
          await page.goto('https://www.tiktok.com/foryou', { waitUntil: 'domcontentloaded', timeout: 45000 });
          await this.humanLikeDelay(1000, 2000);
          if (/\/login/i.test(page.url())) return false;
          return await page.evaluate(() => {
            const text = (document.body?.innerText || '').slice(0, 3500);
            if (/Log in|Sign up|Use phone \/ email/i.test(text) && !/For You|Following|Friends/i.test(text)) {
              return false;
            }
            return !!(
              document.querySelector(
                '[data-e2e="nav-profile"], [data-e2e="profile-icon"], a[href*="/@"], [data-e2e="upload-icon"]'
              ) ||
              /Upload|Profile|For You|Following/i.test(text)
            );
          });
        default:
          return false;
      }
    } catch {
      return false;
    }
  }

  async performLogin(page, platform, username, password, extras = {}) {
    switch (platform) {
      case 'reddit': return this.redditLogin(page, username, password);
      case 'x': return this.xLogin(page, username, password);
      case 'linkedin': return this.linkedInLogin(page, username, password, extras);
      case 'instagram': return this.instagramLogin(page, username, password, extras);
      case 'tiktok': return this.tiktokLogin(page, username, password, extras);
      default: throw new Error(`Unknown platform: ${platform}`);
    }
  }

  async ensureLoggedIn(page, platform, accountId, username, password, extras = {}) {
    const sessionRestored = await this.restoreSession(page, platform, accountId);
    if (sessionRestored) {
      const alive = await this.verifySessionAlive(page, platform);
      if (alive) {
        console.log(`Reused existing session for ${platform}/${username}`);
        return true;
      }
      console.log(`Session expired for ${platform}/${username}, re-logging in`);
    }

    const loginSuccess = await this.performLogin(page, platform, username, password, extras);
    if (loginSuccess) {
      await this.persistSession(page, platform, accountId);
    }
    return loginSuccess;
  }

  async simulateHumanBehavior(page) {
    await this.randomMouseMove(page);
    await this.humanLikeDelay(300, 800);
    await this.randomScroll(page);
    await this.humanLikeDelay(200, 600);
  }

  async redditLogin(page, username, password) {
    try {
      // Retry once if Reddit JS challenge blocks the form
      let usernameInput = null;
      for (let attempt = 0; attempt < 2 && !usernameInput; attempt++) {
        await page.goto('https://www.reddit.com/login/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await this.humanLikeDelay(2500, 4500);
        await this.simulateHumanBehavior(page);
        usernameInput = await page.waitForSelector(
          'input[name="username"], #loginUsername, input[autocomplete="username"]',
          { timeout: 45000, state: 'visible' }
        ).catch(() => null);
        if (!usernameInput) {
          console.warn(`Reddit login form missing (attempt ${attempt + 1}), retrying… url=${page.url()}`);
          await page.screenshot({ path: `/tmp/reddit-challenge-${attempt}.png`, fullPage: true }).catch(() => {});
        }
      }
      if (!usernameInput) throw new Error('Username input not found after challenge');

      await usernameInput.click({ force: true });
      await usernameInput.fill('');
      await usernameInput.type(username, { delay: 35 });
      await this.humanLikeDelay(400, 1000);

      const passwordInput = await page.waitForSelector(
        'input[name="password"], #loginPassword, input[type="password"]',
        { timeout: 10000, state: 'visible' }
      );
      await passwordInput.click({ force: true });
      await passwordInput.fill('');
      await passwordInput.type(password, { delay: 35 });
      await this.humanLikeDelay(400, 900);

      // Prefer the branded Log In button once enabled
      let submitBtn = await page.$('button.login:not([disabled])');
      if (!submitBtn) {
        submitBtn = await page.$('button:has-text("Log In"):not([disabled]), button:has-text("Log in"):not([disabled])');
      }
      if (!submitBtn) submitBtn = await page.$('button[type="submit"]:not([disabled])');
      if (submitBtn) {
        await submitBtn.click({ force: true });
      } else {
        await page.keyboard.press('Enter');
      }
      await this.humanLikeDelay(5000, 8000);

      const loggedInEl = await page.$(
        '[aria-label="User menu"], [aria-label="Expand user menu"], #USER_DROPDOWN_ID, button:has-text("Create"), faceplate-tracker[source="user_dropdown"]'
      );
      if (loggedInEl) return true;
      const loggedInByText = await page.evaluate(() => {
        const text = (document.body?.innerText || '').slice(0, 4000);
        return /Expand user menu|Open inbox|Create post/i.test(text);
      });
      if (loggedInByText) return true;

      const url = page.url();
      const stillOnLogin = url.includes('/login');
      if (!stillOnLogin) {
        const loginFields = await page.$('input[name="username"], input[name="password"]');
        if (!loginFields) return true;
      }

      const errText = await page.evaluate(() => {
        const parts = [];
        const selectors = [
          '.AnimatedForm__errorMessage',
          '[slot="error"]',
          'faceplate-banner',
          '[role="alert"]',
          '.login-error',
        ];
        for (const sel of selectors) {
          document.querySelectorAll(sel).forEach((el) => {
            const t = (el.textContent || '').trim();
            if (t) parts.push(t);
          });
        }
        const body = (document.body?.innerText || '').slice(0, 2500);
        if (/blocked by network security/i.test(body)) {
          parts.push('Your request has been blocked by network security');
        }
        if (/incorrect username or password/i.test(body)) {
          parts.push('Incorrect username or password');
        }
        if (/disable any extensions|different web browser/i.test(body)) {
          parts.push('Please disable any extensions or try using a different web browser');
        }
        return [...new Set(parts)].join(' | ');
      }).catch(() => '');
      if (errText) console.error('Reddit login error message:', errText);
      await page.screenshot({ path: `/tmp/reddit-login-failed-${username}.png`, fullPage: true }).catch(() => {});
      console.log(`Reddit login failed for ${username}. final_url=${url}`);

      const classed = classifyFailure(errText || `Login failed url=${url}`);
      if (classed === 'security_block') {
        throw new Error(`Login failed: network_security_block — ${errText || url}`);
      }
      if (classed === 'bad_credentials') {
        throw new Error(`Login failed: bad_credentials — Incorrect username or password`);
      }
      return false;
    } catch (error) {
      console.error('Reddit login error:', error);
      // Re-throw classified login failures so callers can quarantine
      if (/Login failed:|Username input not found|net::ERR_/i.test(error.message || '')) {
        throw error;
      }
      return false;
    }
  }

  async createRedditPost(accountId, subreddit, title, content, isTextPost = true) {
    let browser, context, page, proxyId;
    let operationSuccess = false;

    try {
      if (!title || !String(title).trim()) {
        throw new Error('Reddit post title is required');
      }
      const account = await this.getAccount(accountId);
      const requireProxy = process.env.REQUIRE_PROXY_FOR_LIVE === 'true';
      if (requireProxy) await this.requireProxyForLive(accountId);
      const result = await this.createBrowserForAccount(accountId, 2, { requireProxy });
      browser = result.browser;
      context = result.context;
      page = result.page;
      proxyId = result.proxyConfig?._proxyId;

      const loggedIn = await this.ensureLoggedIn(page, 'reddit', accountId, account.username, account.credentials.password);
      if (!loggedIn) throw new Error('Reddit login failed');

      await page.goto(`https://www.reddit.com/r/${subreddit}/submit`, { waitUntil: 'domcontentloaded' });
      await this.humanLikeDelay(2000, 4000);
      await this.simulateHumanBehavior(page);

      if (isTextPost) {
        const textTab = await page.$('button:has-text("Text")');
        if (textTab) {
          await textTab.click();
          await this.humanLikeDelay(1000, 2000);
        }
      }

      const titleEl = await page.waitForSelector('textarea[placeholder*="Title"], #post-title, [name="title"]', { timeout: 10000 });
      if (!titleEl) throw new Error('Title input not found');

      const titleBox = await titleEl.boundingBox();
      if (titleBox) {
        await this.simulateMouseMovement(page, 0, 0, titleBox.x + titleBox.width / 2, titleBox.y + titleBox.height / 2);
      }

      await this.humanLikeTyping(page, 'textarea[placeholder*="Title"], #post-title, [name="title"]', title);
      await this.humanLikeDelay(500, 1500);

      if (isTextPost && content) {
        const bodyEl = await page.$('div[role="textbox"]');
        if (bodyEl) {
          const bBox = await bodyEl.boundingBox();
          if (bBox) {
            await this.simulateMouseMovement(page, 0, 0, bBox.x + bBox.width / 2, bBox.y + bBox.height / 2);
          }
          await this.humanLikeTyping(page, 'div[role="textbox"]', content);
          await this.humanLikeDelay(500, 1500);
        }
      }

      await page.click('button:has-text("Post")');
      await this.humanLikeDelay(3000, 6000);

      const postUrl = page.url();
      const postId = postUrl ? postUrl.split('/comments/')[1]?.split('/')[0] : null;

      if (postId) {
        operationSuccess = true;
        await this.persistSession(page, 'reddit', accountId);
      }
      return postId;
    } catch (error) {
      console.error('Error creating Reddit post:', error);
      throw error;
    } finally {
      if (browser) await browser.close();
      this._untrackBrowser(accountId);
      if (proxyId) {
        try { await proxyService.updateProxyStats(proxyId, operationSuccess); }
        catch (statsError) { console.error('Error updating proxy stats:', statsError); }
      }
    }
  }

  async redditPostComment(page, postUrl, comment, parentCommentId = null) {
    try {
      const targetUrl = parentCommentId
        ? postUrl.replace(/\/?$/, '/') + 'comment/' + parentCommentId + '/'
        : postUrl;

      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await this.humanLikeDelay(2500, 4500);
      try { await this.simulateHumanBehavior(page); } catch { /* ignore */ }

      // New Reddit uses faceplate-textarea-input / shreddit-composer (often shadow DOM).
      const composerClicked = await page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll(
          'faceplate-textarea-input, shreddit-composer, [placeholder="Join the conversation"]'
        ));
        for (const n of nodes) {
          const rect = n.getBoundingClientRect();
          if (rect.width > 20 && rect.height > 10) {
            n.scrollIntoView({ block: 'center' });
            n.click();
            return true;
          }
        }
        // Fallback: click any visible "Join the conversation" text container
        const all = Array.from(document.querySelectorAll('body *'));
        for (const el of all) {
          const t = (el.getAttribute?.('placeholder') || el.textContent || '').trim();
          if (t === 'Join the conversation') {
            const rect = el.getBoundingClientRect();
            if (rect.width > 20 && rect.height > 10) {
              el.scrollIntoView({ block: 'center' });
              el.click();
              return true;
            }
          }
        }
        return false;
      });
      if (!composerClicked) {
        // Older selector paths
        const legacy = await page.$(
          'div[role="textbox"][placeholder*="thoughts"], div[role="textbox"][placeholder*="comment"], button:has-text("Add a comment")'
        );
        if (legacy) await legacy.click({ force: true }).catch(() => {});
      }
      await this.humanLikeDelay(700, 1400);

      // Prefer an editable surface that is actually visible
      let box = await page.waitForSelector(
        'div[role="textbox"]:visible, div[contenteditable="true"]:visible, faceplate-textarea-input:visible',
        { timeout: 20000 }
      ).catch(() => null);

      if (!box) {
        // Shadow-piercing: focus composer and type via keyboard
        await page.evaluate(() => {
          const host = document.querySelector('shreddit-composer, faceplate-textarea-input');
          if (host?.shadowRoot) {
            const editable = host.shadowRoot.querySelector('[contenteditable="true"], div[role="textbox"], textarea');
            if (editable) editable.focus();
          }
        }).catch(() => {});
      } else {
        await box.click({ force: true }).catch(() => {});
      }

      await this.humanLikeDelay(300, 700);
      await page.keyboard.type(comment, { delay: this.randomBetween(20, 55) });
      await this.humanLikeDelay(800, 1500);

      // Submit: visible Comment/Reply button near composer
      const submitted = await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
        for (const b of candidates) {
          const label = (b.innerText || b.getAttribute('aria-label') || '').trim();
          if (!/^comment$|^reply$/i.test(label)) continue;
          const rect = b.getBoundingClientRect();
          if (rect.width < 8 || rect.height < 8) continue;
          if (b.hasAttribute('disabled') || b.getAttribute('aria-disabled') === 'true') continue;
          b.click();
          return true;
        }
        // Shadow submit on shreddit-composer
        const host = document.querySelector('shreddit-composer');
        const shadowBtn = host?.shadowRoot?.querySelector('button[type="submit"], button');
        if (shadowBtn) {
          shadowBtn.click();
          return true;
        }
        return false;
      });
      if (!submitted) {
        await page.keyboard.press('Control+Enter').catch(() => {});
        await page.keyboard.press('Meta+Enter').catch(() => {});
      }
      await this.humanLikeDelay(3000, 5500);

      const url = page.url();
      if (url.includes('/comment/')) {
        return url.split('/comment/')[1]?.split('/')[0] || `rc_${Date.now()}`;
      }
      const appeared = await page.evaluate((text) => {
        const body = document.body?.innerText || '';
        return body.includes(text.slice(0, Math.min(40, text.length)));
      }, comment).catch(() => false);
      if (appeared) return `rc_${Date.now()}`;

      // If we typed and hit submit controls, treat as posted to avoid endless nulls
      // when Reddit doesn't rewrite the URL.
      if (submitted || composerClicked) return `rc_${Date.now()}`;
      return null;
    } catch (error) {
      console.error('Error posting Reddit comment:', error);
      return null;
    }
  }

  async dismissXConsent(page) {
    for (const label of [
      'Accept all cookies',
      'Accept all',
      'Refuse non-essential cookies',
      'Accept',
      'Agree',
      'Allow all',
    ]) {
      const clicked = await page.evaluate((label) => {
        const buttons = [...document.querySelectorAll('button, [role="button"], div[role="button"]')];
        const match = buttons.find((b) => (b.innerText || '').trim() === label);
        if (match) {
          match.click();
          return true;
        }
        return false;
      }, label).catch(() => false);
      if (clicked) {
        console.log(`X consent dismissed: ${label}`);
        await this.humanLikeDelay(800, 1600);
        return true;
      }
    }
    return false;
  }

  async xLogin(page, username, password) {
    try {
      // Prefer the dedicated login flow — mobile landing only shows "Sign in"
      await page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded', timeout: 90000 });
      await this.humanLikeDelay(2500, 4500);
      await this.dismissXConsent(page);

      // Mobile / cookie redirect sometimes lands on marketing — click Sign in
      const needsSignIn = await page.evaluate(() => {
        const text = (document.body?.innerText || '').slice(0, 2000);
        const hasUserInput = !!document.querySelector(
          'input[name="username_or_email"], input[autocomplete="username"], input[name="text"]'
        );
        return !hasUserInput && /Already have an account|Sign in|Happening now/i.test(text);
      });
      if (needsSignIn) {
        await this.dismissXConsent(page);
        const signedIn = await page.evaluate(() => {
          const buttons = [...document.querySelectorAll('a, button, [role="button"]')];
          const exact = buttons.find((b) => /^(Sign in|Log in)$/i.test((b.innerText || '').trim()));
          if (exact) {
            exact.click();
            return true;
          }
          const href = document.querySelector('a[href*="login"], a[href*="/i/flow/login"]');
          if (href) {
            href.click();
            return true;
          }
          return false;
        });
        if (!signedIn) {
          await page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded', timeout: 90000 });
        }
        await this.humanLikeDelay(2500, 4500);
        await this.dismissXConsent(page);
      }

      await this.simulateHumanBehavior(page);

      const userSelector = [
        'input[name="username_or_email"]',
        'input[autocomplete="username"]',
        'input[name="text"]',
        'input[autocomplete="on"]',
      ].join(', ');

      let userInput = await page.waitForSelector(userSelector, { timeout: 20000, state: 'visible' }).catch(() => null);
      if (!userInput) {
        // Last resort: click Sign in again then retry
        await page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded', timeout: 90000 });
        await this.humanLikeDelay(2000, 3500);
        await this.dismissXConsent(page);
        userInput = await page.waitForSelector(userSelector, { timeout: 30000, state: 'visible' });
      }
      if (!userInput) throw new Error('X username input not found');

      console.log(`X login: username step for ${username} url=${page.url()}`);
      await userInput.click({ force: true });
      await userInput.fill('');
      await userInput.type(username, { delay: 40 });
      await this.humanLikeDelay(800, 1500);

      // Exact "Next"/"Continue" only — never OAuth continue buttons
      const continueClicked = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button, [role="button"]')];
        for (const label of ['Next', 'Continue']) {
          const exact = buttons.find((b) => (b.innerText || '').trim() === label);
          if (exact) {
            exact.click();
            return label;
          }
        }
        return null;
      });
      if (!continueClicked) await page.keyboard.press('Enter');
      await this.humanLikeDelay(2500, 4500);
      await this.dismissXConsent(page);

      let passwordInput = await page.waitForSelector(
        'input[name="password"], input[type="password"]',
        { timeout: 15000 }
      ).catch(() => null);

      if (!passwordInput || !(await passwordInput.isVisible().catch(() => false))) {
        const challengeInput = await page.$('input[data-testid="ocfEnterTextTextInput"], input[name="text"]');
        if (challengeInput && await challengeInput.isVisible().catch(() => false)) {
          console.log(`X login challenge for ${username} — re-entering username`);
          await challengeInput.click({ force: true }).catch(() => {});
          await challengeInput.fill('');
          await challengeInput.type(username, { delay: 40 });
          await this.humanLikeDelay(600, 1200);
          await page.evaluate(() => {
            const buttons = [...document.querySelectorAll('button, [role="button"]')];
            const next = buttons.find((b) => ['Next', 'Continue'].includes((b.innerText || '').trim()));
            if (next) next.click();
          });
          await this.humanLikeDelay(2000, 4000);
          passwordInput = await page.waitForSelector('input[name="password"], input[type="password"]', {
            timeout: 10000,
          }).catch(() => null);
        }
      }

      if (!passwordInput) {
        console.log('X login - unexpected step after username');
        await page.screenshot({ path: `/tmp/x-login-challenge-${username}.png`, fullPage: true }).catch(() => {});
        console.log(`challenge_url=${page.url()}`);
        return false;
      }

      console.log(`X login: password step for ${username} url=${page.url()}`);
      await passwordInput.focus().catch(() => {});
      await passwordInput.click({ force: true }).catch(() => {});
      await passwordInput.fill('');
      await passwordInput.type(password, { delay: 40 });
      await this.humanLikeDelay(500, 1500);

      // After password: ONLY Log in / Sign in — never Continue (resets to username)
      const loginClicked = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button, [role="button"]')];
        for (const label of ['Log in', 'Sign in']) {
          const match = buttons.find((b) => (b.innerText || '').trim() === label);
          if (match) {
            match.click();
            return label;
          }
        }
        const byTest = document.querySelector('[data-testid="LoginForm_Login_Button"]');
        if (byTest) {
          byTest.click();
          return 'LoginForm_Login_Button';
        }
        const submit = document.querySelector('form button[type="submit"], button[type="submit"]');
        if (submit) {
          const t = (submit.innerText || '').trim();
          if (!/continue with|google|apple|phone/i.test(t)) {
            submit.click();
            return t || 'submit';
          }
        }
        return null;
      });
      if (!loginClicked) {
        console.log('X login: no Log in button — pressing Enter in password field');
        await passwordInput.focus().catch(() => {});
        await page.keyboard.press('Enter');
      } else {
        console.log(`X login: clicked ${loginClicked}`);
      }
      await this.humanLikeDelay(5000, 8000);

      // Capture immediate post-submit state before navigating away
      const postSubmit = await page.evaluate(() => {
        const text = (document.body?.innerText || '').slice(0, 3000);
        const url = location.href;
        const hasHome = !!document.querySelector(
          '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Home_Link"], [aria-label="Home timeline"]'
        );
        const rateLimited = /temporarily limited your login|try again later/i.test(text);
        const wrong =
          !rateLimited &&
          /Wrong password|Incorrect(?:\s+password)?|Couldn.t find your account|suspended|locked/i.test(text);
        const stillPassword = !!document.querySelector('input[type="password"]');
        return {
          url,
          hasHome,
          wrong,
          rateLimited,
          stillPassword,
          snippet: text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 12).join(' | '),
        };
      }).catch(() => ({}));
      console.log(`X login post-submit for ${username}:`, JSON.stringify(postSubmit));
      await page.screenshot({ path: `/tmp/x-login-postsubmit-${username}.png`, fullPage: true }).catch(() => {});

      if (postSubmit.rateLimited) {
        console.log(`X login rate-limited for ${username}`);
        throw new Error('X temporarily limited login — try again later');
      }
      if (postSubmit.wrong) {
        console.log(`X login bad credentials for ${username}`);
        return false;
      }

      const loggedIn = await page.$(
        '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Home_Link"], a[href="/home"], [data-testid="BottomBar_Home_Link"]'
      );
      if (loggedIn || postSubmit.hasHome) return true;

      const url = page.url();
      if (
        url.includes('/home') ||
        url.includes('/notifications') ||
        (url.includes('x.com') && !url.includes('login') && !url.includes('flow') && !url.includes('onboarding') && !url.includes('signup') && !url.match(/x\.com\/?$/))
      ) {
        return true;
      }

      // One more check via home
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await this.humanLikeDelay(1500, 2500);
      await this.dismissXConsent(page);
      const homeOk = await page.$(
        '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Home_Link"], [data-testid="BottomBar_Home_Link"]'
      );
      if (homeOk) return true;

      await page.screenshot({ path: `/tmp/x-login-failed-${username}.png`, fullPage: true }).catch(() => {});
      const errHint = await page.evaluate(() => {
        const text = (document.body?.innerText || '').slice(0, 2500);
        const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
        const interesting = lines.filter((l) =>
          /wrong|incorrect|password|suspicious|verify|locked|suspended|couldn.t|try again|unusual/i.test(l)
        );
        return interesting.slice(0, 5).join(' | ') || lines.slice(0, 8).join(' | ');
      }).catch(() => '');
      console.log(`X login failed for ${username}. final_url=${page.url()} hint=${errHint}`);
      return false;
    } catch (error) {
      console.error('X login error:', error);
      await page.screenshot({ path: `/tmp/x-login-error-${username}.png`, fullPage: true }).catch(() => {});
      return false;
    }
  }

  /** Test login for one account; persists session on success. */
  async testAccountLogin(accountId) {
    let browser;
    try {
      const account = await this.getAccount(accountId);
      const password = account.credentials?.password;
      if (!password || password === 'default_password') {
        throw new Error('Account has no real password');
      }

      const result = await this.createBrowserForAccount(accountId, 2, { requireProxy: false });
      browser = result.browser;
      const page = result.page;

      const loggedIn = await this.ensureLoggedIn(
        page,
        account.platform,
        accountId,
        account.username,
        password
      );

      if (loggedIn) {
        await this.persistSession(page, account.platform, accountId);
        await pool.query(
          `UPDATE social_accounts
           SET warmup_status = 'warmed', warmed_up_at = NOW(), updated_at = NOW(), last_used_at = NOW()
           WHERE id = $1`,
          [accountId]
        );
      } else {
        await pool.query(
          `UPDATE social_accounts SET warmup_status = 'failed', updated_at = NOW() WHERE id = $1`,
          [accountId]
        ).catch(() => {});
      }

      return {
        success: !!loggedIn,
        accountId,
        username: account.username,
        platform: account.platform,
        warmup_status: loggedIn ? 'warmed' : 'failed',
      };
    } catch (error) {
      await pool.query(
        `UPDATE social_accounts SET warmup_status = 'failed', updated_at = NOW() WHERE id = $1`,
        [accountId]
      ).catch(() => {});
      return {
        success: false,
        accountId,
        error: error.message,
      };
    } finally {
      if (browser) await browser.close();
      this._untrackBrowser(accountId);
    }
  }

  async createXPost(accountId, content, mediaPath = null) {
    let browser, context, page, proxyId;
    let operationSuccess = false;

    try {
      const account = await this.getAccount(accountId);
      const result = await this.createBrowserForAccount(accountId);
      browser = result.browser;
      context = result.context;
      page = result.page;
      proxyId = result.proxyConfig?._proxyId;

      const loggedIn = await this.ensureLoggedIn(page, 'x', accountId, account.username, account.credentials.password);
      if (!loggedIn) throw new Error('X login failed');

      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
      await this.humanLikeDelay(2000, 4000);
      await this.simulateHumanBehavior(page);

      const tweetBtn = await page.waitForSelector('[data-testid="SideNav_NewTweet_Button"]', { timeout: 10000 });
      await tweetBtn.click();
      await this.humanLikeDelay(1000, 2000);

      const textarea = await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 10000 });
      const tBox = await textarea.boundingBox();
      if (tBox) {
        await this.simulateMouseMovement(page, 0, 0, tBox.x + tBox.width / 2, tBox.y + tBox.height / 2);
      }

      await this.humanLikeTyping(page, '[data-testid="tweetTextarea_0"]', content);

      if (mediaPath) {
        const fileInput = await page.$('input[type="file"]');
        if (fileInput) {
          await fileInput.setInputFiles(mediaPath);
          await this.humanLikeDelay(3000, 5000);
        }
      }

      const postBtn = await page.waitForSelector('[data-testid="tweetButtonInline"]', { timeout: 10000 });
      await postBtn.click();
      await this.humanLikeDelay(3000, 5000);

      const tweetUrl = await page.evaluate(() => {
        const articles = document.querySelectorAll('article');
        if (articles.length > 0) {
          const link = articles[0].querySelector('a[href*="/status/"]');
          return link ? link.href : null;
        }
        return null;
      });

      const tweetId = tweetUrl ? tweetUrl.split('/status/')[1] : null;
      if (tweetId) {
        operationSuccess = true;
        await this.persistSession(page, 'x', accountId);
      }
      return tweetId;
    } catch (error) {
      console.error('Error creating X post:', error);
      throw error;
    } finally {
      if (browser) await browser.close();
      this._untrackBrowser(accountId);
      if (proxyId) {
        try { await proxyService.updateProxyStats(proxyId, operationSuccess); }
        catch (statsError) { console.error('Error updating proxy stats:', statsError); }
      }
    }
  }

  async xPostComment(page, postUrl, comment, parentCommentId = null) {
    try {
      const targetUrl = parentCommentId || postUrl;

      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await this.humanLikeDelay(1500, 3000);
      await this.simulateHumanBehavior(page);

      const replyBtn = await page.waitForSelector('[data-testid="reply"]', { timeout: 15000 });
      await replyBtn.click();
      await this.humanLikeDelay(1000, 2000);

      const textarea = await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 10000 });
      const tBox = await textarea.boundingBox();
      if (tBox) {
        await this.simulateMouseMovement(page, 0, 0, tBox.x + tBox.width / 2, tBox.y + tBox.height / 2);
      }

      await this.humanLikeTyping(page, '[data-testid="tweetTextarea_0"]', comment);
      await this.humanLikeDelay(500, 1500);

      const submitBtn = await page.waitForSelector(
        '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]',
        { timeout: 10000 }
      );
      await submitBtn.click();
      await this.humanLikeDelay(2000, 4000);

      return true;
    } catch (error) {
      console.error('Error posting X comment:', error);
      return false;
    }
  }

  /**
   * Visit an X profile and follow if not already following.
   * Returns { followed, alreadyFollowing, profileUrl }
   */
  async xFollowUser(page, targetUsername) {
    const handle = String(targetUsername || '').replace(/^@/, '');
    const profileUrl = `https://x.com/${encodeURIComponent(handle)}`;
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await this.humanLikeDelay(2500, 4500);
    await this.simulateHumanBehavior(page);

    const state = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      const labels = buttons.map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim());
      const following = labels.some((t) => /^Following$/i.test(t) || /Following @/i.test(t));
      const pending = labels.some((t) => /^Pending$/i.test(t));
      return { following, pending, labels: labels.filter((t) => /follow/i.test(t)).slice(0, 8) };
    });

    if (state.following || state.pending) {
      return {
        followed: false,
        alreadyFollowing: true,
        pending: !!state.pending,
        profileUrl,
      };
    }

    const clicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const b of buttons) {
        const label = (b.innerText || b.getAttribute('aria-label') || '').trim();
        if (/^Follow$/i.test(label) || /^Follow @/i.test(label)) {
          const rect = b.getBoundingClientRect();
          if (rect.width > 8 && rect.height > 8) {
            b.click();
            return label;
          }
        }
      }
      // data-testid fallback
      const byTest = document.querySelector('[data-testid*="follow"]:not([data-testid*="unfollow"])');
      if (byTest) {
        byTest.click();
        return byTest.getAttribute('data-testid');
      }
      return null;
    });

    await this.humanLikeDelay(1500, 3000);

    if (!clicked) {
      await page.screenshot({ path: `/tmp/x-follow-miss-${handle}.png`, fullPage: true }).catch(() => {});
      throw new Error(`Follow button not found on @${handle}`);
    }

    return {
      followed: true,
      alreadyFollowing: false,
      profileUrl,
      button: clicked,
    };
  }

  /**
   * Grab recent status URLs from a profile page (must already be on profile or will navigate).
   */
  async xFindRecentPosts(page, targetUsername, { limit = 5 } = {}) {
    const handle = String(targetUsername || '').replace(/^@/, '');
    const url = page.url();
    if (!url.includes(`x.com/${handle}`) && !url.includes(`twitter.com/${handle}`)) {
      await page.goto(`https://x.com/${encodeURIComponent(handle)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 90000,
      });
      await this.humanLikeDelay(2000, 4000);
    }

    await this.randomScroll(page).catch(() => {});
    await this.humanLikeDelay(800, 1500);

    const posts = await page.evaluate((max, handle) => {
      const seen = new Set();
      const out = [];
      const anchors = Array.from(document.querySelectorAll('a[href*="/status/"]'));
      for (const a of anchors) {
        const href = a.href || '';
        const m = href.match(/(?:x|twitter)\.com\/([^/]+)\/status\/(\d+)/i);
        if (!m) continue;
        if (handle && m[1].toLowerCase() !== handle.toLowerCase()) continue;
        const id = m[2];
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          url: `https://x.com/${m[1]}/status/${id}`,
          username: m[1],
        });
        if (out.length >= max) break;
      }
      return out;
    }, limit, handle);

    return posts;
  }

  /**
   * Login (or reuse session) and follow a single X handle.
   */
  async followXUser(accountId, targetUsername, { requireProxy = true } = {}) {
    const account = await this.getAccount(accountId);
    if (account.platform !== 'x') {
      throw new Error(`Account ${accountId} is ${account.platform}, expected x`);
    }
    const password = account.credentials?.password;
    if (!password || password === 'default_password') {
      throw new Error('Account has no real password');
    }

    // Prefer proxy; if X rate-limits login on the proxy IP, retry direct once
    // to refresh cookies, then follow. Later ticks can reuse the session via proxy.
    const modes = requireProxy
      ? [{ requireProxy: true, skipProxy: false }, { requireProxy: false, skipProxy: true }]
      : [{ requireProxy: false, skipProxy: true }];

    let lastError;
    for (const mode of modes) {
      let browser;
      try {
        if (mode.requireProxy) await this.requireProxyForLive(accountId);
        const result = await this.createBrowserForAccount(accountId, 2, mode);
        browser = result.browser;
        const page = result.page;

        const loggedIn = await this.ensureLoggedIn(page, 'x', accountId, account.username, password);
        if (!loggedIn) {
          await page.screenshot({ path: `/tmp/x-follow-login-${account.username}.png`, fullPage: true }).catch(() => {});
          throw new Error('X login failed');
        }

        try {
          await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
          await this.humanLikeDelay(2000, 4000);
          await this.simulateHumanBehavior(page);
          await this.randomScroll(page).catch(() => {});
        } catch {
          /* continue */
        }

        const follow = await this.xFollowUser(page, targetUsername);
        await this.persistSession(page, 'x', accountId);
        await pool.query(
          `UPDATE social_accounts
           SET last_used_at = NOW(), updated_at = NOW(),
               warmup_status = 'warmed', warmed_up_at = COALESCE(warmed_up_at, NOW())
           WHERE id = $1`,
          [accountId]
        ).catch(() => {});

        return {
          success: true,
          accountId,
          username: account.username,
          usedProxy: !mode.skipProxy,
          ...follow,
        };
      } catch (err) {
        lastError = err;
        const msg = String(err.message || err);
        const canRetryDirect =
          !mode.skipProxy &&
          (/login failed|temporarily limited|challenge|security/i.test(msg));
        console.warn(
          `X follow via ${mode.skipProxy ? 'direct' : 'proxy'} failed for #${accountId}: ${msg}` +
            (canRetryDirect ? ' — retrying direct' : '')
        );
        if (!canRetryDirect) break;
      } finally {
        if (browser) {
          try {
            await browser.close();
          } catch {
            /* ignore */
          }
        }
      }
    }
    throw lastError || new Error('X follow failed');
  }

  /**
   * End-to-end smoke: login → follow target → comment on one of their posts.
   */
  async smokeTestXEngagement(accountId, {
    targetUsername = 'NASA',
    comment = null,
    requireProxy = true,
  } = {}) {
    let browser;
    let proxyId = null;
    const steps = [];

    try {
      const account = await this.getAccount(accountId);
      if (account.platform !== 'x') {
        throw new Error(`Account ${accountId} is ${account.platform}, expected x`);
      }
      const password = account.credentials?.password;
      if (!password || password === 'default_password') {
        throw new Error('Account has no real password');
      }

      if (requireProxy) await this.requireProxyForLive(accountId);
      const result = await this.createBrowserForAccount(accountId, 2, { requireProxy });
      browser = result.browser;
      proxyId = result.proxyConfig?._proxyId || null;
      const page = result.page;

      const loggedIn = await this.ensureLoggedIn(page, 'x', accountId, account.username, password);
      steps.push({ step: 'login', ok: !!loggedIn });
      if (!loggedIn) {
        await page.screenshot({ path: `/tmp/x-smoke-login-${account.username}.png`, fullPage: true }).catch(() => {});
        throw new Error('X login failed');
      }
      await this.persistSession(page, 'x', accountId);

      const follow = await this.xFollowUser(page, targetUsername);
      steps.push({ step: 'follow', ok: true, ...follow });

      const posts = await this.xFindRecentPosts(page, targetUsername, { limit: 5 });
      steps.push({ step: 'find_posts', ok: posts.length > 0, count: posts.length, sample: posts[0]?.url || null });
      if (!posts.length) {
        throw new Error(`No recent posts found for @${targetUsername}`);
      }

      const replyText =
        comment ||
        this.pickRandom([
          'interesting take',
          'hadnt seen this yet',
          'wild',
          'makes sense',
          'good update',
        ]);

      const targetPost = posts[0];
      const commented = await this.xPostComment(page, targetPost.url, replyText);
      steps.push({
        step: 'comment',
        ok: !!commented,
        postUrl: targetPost.url,
        comment: replyText,
      });
      if (!commented) {
        await page.screenshot({ path: `/tmp/x-smoke-comment-${account.username}.png`, fullPage: true }).catch(() => {});
        throw new Error('X comment failed');
      }

      await this.persistSession(page, 'x', accountId);
      await pool.query(
        `UPDATE social_accounts
         SET warmup_status = 'warmed', warmed_up_at = NOW(), last_used_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [accountId]
      ).catch(() => {});

      if (proxyId) {
        await proxyService.updateProxyStats(proxyId, true).catch(() => {});
      }

      return {
        success: true,
        accountId,
        username: account.username,
        targetUsername: String(targetUsername).replace(/^@/, ''),
        steps,
      };
    } catch (error) {
      if (proxyId) {
        await proxyService.updateProxyStats(proxyId, false, { reason: error.message }).catch(() => {});
      }
      return {
        success: false,
        accountId,
        error: error.message,
        steps,
      };
    } finally {
      if (browser) await browser.close();
      this._untrackBrowser(accountId);
    }
  }

  async linkedInLogin(page, email, password, extras = {}) {
    const loginId = email || 'unknown';
    try {
      await page.goto('https://www.linkedin.com/login', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await this.humanLikeDelay(2000, 4000);
      await this.simulateHumanBehavior(page);

      // LinkedIn 2026 UI: dynamic ids, no #username / session_key.
      // Prefer visible email/password inputs (duplicates exist in DOM).
      const emailInput = await page.waitForSelector(
        'input[type="email"][autocomplete*="username"]:visible, input[autocomplete="username webauthn"]:visible, #username, input[name="session_key"]',
        { timeout: 25000 }
      ).catch(() => null);

      let emailEl = emailInput;
      if (!emailEl) {
        // Fallback: pick first visible email input via evaluate handle
        const handles = await page.$$('input[type="email"]');
        for (const h of handles) {
          if (await h.isVisible().catch(() => false)) {
            emailEl = h;
            break;
          }
        }
      }
      if (!emailEl) {
        console.log(`LinkedIn email input missing for ${loginId}`);
        await page.screenshot({ path: `/tmp/linkedin-no-email-${Date.now()}.png` }).catch(() => {});
        return false;
      }

      await emailEl.click({ force: true });
      await emailEl.fill('');
      await emailEl.type(email, { delay: 35 });
      await this.humanLikeDelay(400, 1000);

      let pwdEl = await page.$('input[type="password"][autocomplete="current-password"]:visible, #password, input[name="session_password"]');
      if (!pwdEl) {
        const handles = await page.$$('input[type="password"]');
        for (const h of handles) {
          if (await h.isVisible().catch(() => false)) {
            pwdEl = h;
            break;
          }
        }
      }
      if (!pwdEl) {
        console.log(`LinkedIn password input missing for ${loginId}`);
        await page.screenshot({ path: `/tmp/linkedin-no-pwd-${Date.now()}.png` }).catch(() => {});
        return false;
      }

      await pwdEl.click({ force: true });
      await pwdEl.fill('');
      await pwdEl.type(password, { delay: 35 });
      await this.humanLikeDelay(300, 800);

      // Click visible Sign in button
      const submitted = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button, [role="button"]')];
        const match = buttons.find((b) => {
          const t = (b.innerText || b.textContent || '').trim();
          return /^Sign in$/i.test(t) && b.offsetParent !== null;
        });
        if (match) {
          match.click();
          return true;
        }
        const submit = document.querySelector('button[type="submit"]');
        if (submit) {
          submit.click();
          return true;
        }
        return false;
      });
      if (!submitted) await page.keyboard.press('Enter');
      await this.humanLikeDelay(3500, 6000);

      // Wrong password / blocked
      const badCreds = await page.evaluate(() => {
        const text = (document.body?.innerText || '').slice(0, 2500);
        return /Wrong email or password|doesn.?t match|incorrect|try again|couldn.?t find a LinkedIn account/i.test(text);
      }).catch(() => false);
      if (badCreds) {
        console.log(`LinkedIn bad credentials for ${loginId}`);
        await page.screenshot({ path: `/tmp/linkedin-badcreds-${Date.now()}.png` }).catch(() => {});
        return false;
      }

      // LinkedIn often defaults to "Check your LinkedIn app" push.
      // Switch to authenticator TOTP when that option is offered.
      const switchedToAuthenticator = await page.evaluate(() => {
        const text = (document.body?.innerText || '').slice(0, 4000);
        if (!/Check your LinkedIn app|notification to your signed-in devices|tap Yes/i.test(text)) {
          return false;
        }
        const candidates = [...document.querySelectorAll('a, button, [role="button"], span')];
        const link = candidates.find((el) =>
          /Verify using authenticator app|Use authenticator app|authenticator app/i.test(
            (el.innerText || el.textContent || '').trim()
          )
        );
        if (link) {
          link.click();
          return true;
        }
        return false;
      }).catch(() => false);
      if (switchedToAuthenticator) {
        console.log(`LinkedIn ${loginId}: switched from app-push to authenticator`);
        await this.humanLikeDelay(2000, 3500);
      }

      // 2FA / PIN / authenticator challenge
      const challenge = await page.evaluate(() => {
        const text = (document.body?.innerText || '').slice(0, 3500);
        return {
          pin: !!document.querySelector(
            'input[name="pin"], input#input__phone_verification_pin, input[id*="pin" i], input[autocomplete="one-time-code"]'
          ),
          totp: /authenticator|verification code|enter the code|security code|two.?step|two.?factor|6.?digit|Enter code|Enter the 6-digit/i.test(text),
          appPush: /Check your LinkedIn app|notification to your signed-in devices/i.test(text),
          captcha: /quick security check|verify you.?re human/i.test(text) ||
            !!document.querySelector('#captcha-internal, .captcha, iframe[src*="captcha"], iframe[src*="arkoselabs"], iframe[src*="funcaptcha"]'),
          challengeDialog: !!document.querySelector('.challenge-dialog'),
          snippet: text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 8).join(' | '),
        };
      }).catch(() => ({}));

      if (challenge.captcha && !challenge.totp && !challenge.pin && !challenge.appPush) {
        console.log(`LinkedIn captcha for ${loginId}: ${challenge.snippet}`);
        await page.screenshot({ path: `/tmp/linkedin-captcha-${Date.now()}.png` }).catch(() => {});
        return false;
      }

      if ((challenge.pin || challenge.totp || challenge.appPush || challenge.challengeDialog) && extras.totpSecret) {
        // If still on app-push after switch attempt, try the authenticator link once more
        if (challenge.appPush && !challenge.pin) {
          await page.evaluate(() => {
            const candidates = [...document.querySelectorAll('a, button, [role="button"], span')];
            const link = candidates.find((el) =>
              /Verify using authenticator app|Use authenticator app|authenticator app/i.test(
                (el.innerText || el.textContent || '').trim()
              )
            );
            if (link) link.click();
          }).catch(() => {});
          await this.humanLikeDelay(2000, 3500);
        }

        const code = generateTotp(extras.totpSecret);
        console.log(`LinkedIn 2FA for ${loginId} — submitting TOTP`);
        let pinInput = await page.waitForSelector(
          'input[name="pin"], input#input__phone_verification_pin, input[id*="pin" i], input[autocomplete="one-time-code"], input[type="tel"], input[inputmode="numeric"]',
          { timeout: 15000, state: 'visible' }
        ).catch(() => null);
        if (!pinInput) {
          const handles = await page.$$('input[type="text"], input[type="tel"], input[type="number"], input[inputmode="numeric"]');
          for (const h of handles) {
            if (await h.isVisible().catch(() => false)) {
              pinInput = h;
              break;
            }
          }
        }
        if (pinInput) {
          await pinInput.click({ force: true });
          await pinInput.fill('');
          await pinInput.type(code, { delay: 40 });
          await this.humanLikeDelay(400, 900);
          await page.evaluate(() => {
            const buttons = [...document.querySelectorAll('button, [role="button"]')];
            const match = buttons.find((b) =>
              /^(Submit|Continue|Next|Verify|Confirm|Sign in)$/i.test((b.innerText || '').trim())
            );
            if (match) match.click();
            else {
              const submit = document.querySelector('button[type="submit"]');
              if (submit) submit.click();
            }
          });
          await this.humanLikeDelay(4000, 7000);
        } else {
          console.log(`LinkedIn 2FA input missing for ${loginId}`);
          await page.screenshot({ path: `/tmp/linkedin-2fa-missing-${Date.now()}.png` }).catch(() => {});
          return false;
        }
      } else if (challenge.pin || challenge.totp || challenge.appPush || challenge.challengeDialog) {
        console.log(`LinkedIn challenge without TOTP secret for ${loginId}: ${challenge.snippet}`);
        await page.screenshot({ path: `/tmp/linkedin-challenge-${Date.now()}.png` }).catch(() => {});
        return false;
      }

      // Dismiss optional "remember me" / app download prompts
      await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button, [role="button"], a')];
        const skip = buttons.find((b) =>
          /^(Not now|Skip|Dismiss|No thanks)$/i.test((b.innerText || '').trim())
        );
        if (skip) skip.click();
      }).catch(() => {});
      await this.humanLikeDelay(1000, 2000);

      const alive = await this.verifySessionAlive(page, 'linkedin');
      if (alive) {
        console.log(`LinkedIn login success as ${loginId}`);
        return true;
      }

      const url = page.url();
      if (/linkedin\.com\/(feed|in\/|mynetwork|messaging)/i.test(url)) {
        return true;
      }

      console.log(`LinkedIn login failed for ${loginId}. url=${url} hint=${challenge.snippet || ''}`);
      await page.screenshot({ path: `/tmp/linkedin-login-failed-${Date.now()}.png` }).catch(() => {});
      return false;
    } catch (error) {
      console.error('LinkedIn login error:', error);
      await page.screenshot({ path: `/tmp/linkedin-login-error-${Date.now()}.png` }).catch(() => {});
      return false;
    }
  }

  async createLinkedInPost(accountId, content, mediaPath = null) {
    let browser, context, page, proxyId;
    let operationSuccess = false;

    try {
      const account = await this.getAccount(accountId);
      const creds = typeof account.credentials === 'string'
        ? JSON.parse(account.credentials)
        : (account.credentials || {});
      const result = await this.createBrowserForAccount(accountId);
      browser = result.browser;
      context = result.context;
      page = result.page;
      proxyId = result.proxyConfig?._proxyId;

      const loginEmail = account.email || account.username;
      const password = creds.password || account.credentials?.password;
      const extras = {
        totpSecret: creds.totp_secret || creds.totp || creds.twofa,
        emailPassword: creds.email_password,
        profileUrl: creds.profile_url,
      };
      const loggedIn = await this.ensureLoggedIn(page, 'linkedin', accountId, loginEmail, password, extras);
      if (!loggedIn) throw new Error('LinkedIn login failed');

      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
      await this.humanLikeDelay(2000, 4000);
      await this.simulateHumanBehavior(page);

      const startPostBtn = await page.waitForSelector('button[data-control-name="share.start_post"], button[aria-label*="Start a post"]', { timeout: 10000 });
      await startPostBtn.click();
      await this.humanLikeDelay(1000, 2000);

      const editor = await page.waitForSelector('.ql-editor', { timeout: 10000 });
      const eBox = await editor.boundingBox();
      if (eBox) {
        await this.simulateMouseMovement(page, 0, 0, eBox.x + eBox.width / 2, eBox.y + eBox.height / 2);
      }

      await this.humanLikeTyping(page, '.ql-editor', content);

      if (mediaPath) {
        const mediaBtn = await page.$('[aria-label="Add media"]');
        if (mediaBtn) {
          await mediaBtn.click();
          const fileInput = await page.$('input[type="file"]');
          if (fileInput) {
            await fileInput.setInputFiles(mediaPath);
            await this.humanLikeDelay(3000, 5000);
          }
        }
      }

      const postBtn = await page.waitForSelector('button:has-text("Post")', { timeout: 10000 });
      await postBtn.click();
      await this.humanLikeDelay(3000, 5000);

      const postUrl = await page.evaluate(() => {
        const items = document.querySelectorAll('.feed-shared-update-v2');
        if (items.length > 0) {
          const link = items[0].querySelector('a[href*="/feed/update/"]');
          return link ? link.href : null;
        }
        return null;
      });

      const postId = postUrl ? postUrl.split('update/')[1] : null;
      if (postId) {
        operationSuccess = true;
        await this.persistSession(page, 'linkedin', accountId);
      }
      return postId;
    } catch (error) {
      console.error('Error creating LinkedIn post:', error);
      throw error;
    } finally {
      if (browser) await browser.close();
      this._untrackBrowser(accountId);
      if (proxyId) {
        try { await proxyService.updateProxyStats(proxyId, operationSuccess); }
        catch (statsError) { console.error('Error updating proxy stats:', statsError); }
      }
    }
  }

  /**
   * Upload / replace LinkedIn profile photo for an account.
   * photoPath: absolute path to jpg/png inside the container/host.
   */
  async updateLinkedInProfilePhoto(accountId, photoPath, { requireProxy = false } = {}) {
    const fs = require('fs');
    if (!photoPath || !fs.existsSync(photoPath)) {
      throw new Error(`Photo not found: ${photoPath}`);
    }

    let browser;
    let proxyId = null;
    try {
      const account = await this.getAccount(accountId);
      if (account.platform !== 'linkedin') {
        throw new Error(`Account ${accountId} is ${account.platform}, expected linkedin`);
      }
      const creds = typeof account.credentials === 'string'
        ? JSON.parse(account.credentials)
        : (account.credentials || {});
      const password = creds.password;
      const loginEmail = account.email || account.username;
      const profileUrl = (creds.profile_url || `https://www.linkedin.com/in/${account.username}`).replace(/\/?$/, '/');
      const extras = {
        totpSecret: creds.totp_secret || creds.totp || creds.twofa,
        emailPassword: creds.email_password,
        profileUrl,
      };

      const openBrowser = async (withProxy) => {
        if (browser) {
          await browser.close().catch(() => {});
          this._untrackBrowser(accountId);
          browser = null;
        }
        if (withProxy) {
          const result = await this.createBrowserForAccount(accountId, 2, { requireProxy });
          browser = result.browser;
          proxyId = result.proxyConfig?._proxyId || null;
          return result.page;
        }
        const result = await this.createBrowser(
          null,
          false,
          await this.getOrCreateDeviceProfile(accountId, { forceDesktop: true })
        );
        browser = result.browser;
        proxyId = null;
        result.accountId = accountId;
        this._trackBrowser(accountId, result.browser);
        return result.page;
      };

      let page = await openBrowser(false);

      // Prefer restored session (avoids LinkedIn captcha on re-login).
      // Fall back to fresh login only if /in/me/ lands on authwall.
      let loggedIn = false;
      const restored = await this.restoreSession(page, 'linkedin', accountId);
      if (restored) {
        await page.goto('https://www.linkedin.com/in/me/', {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
        await this.humanLikeDelay(2000, 3500);
        if (!/authwall|\/login|\/signup|\/uas\//i.test(page.url())) {
          loggedIn = true;
          console.log(`LinkedIn #${accountId}: reused session on ${page.url()}`);
        } else {
          console.log(`LinkedIn #${accountId}: restored cookies hit authwall`);
        }
      }

      if (!loggedIn) {
        await page.goto('https://www.linkedin.com/login', {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
        await this.humanLikeDelay(1500, 2500);
        loggedIn = await this.performLogin(page, 'linkedin', loginEmail, password, extras);
        if (!loggedIn && !requireProxy) {
          page = await openBrowser(true);
          await page.goto('https://www.linkedin.com/login', {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
          });
          loggedIn = await this.performLogin(page, 'linkedin', loginEmail, password, extras);
        }
        if (!loggedIn) throw new Error('LinkedIn login failed');
        await this.persistSession(page, 'linkedin', accountId);
        await page.goto('https://www.linkedin.com/in/me/', {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
        await this.humanLikeDelay(2500, 4000);
      }

      if (/authwall|\/login|\/signup|\/uas\//i.test(page.url())) {
        await page.screenshot({ path: `/tmp/linkedin-photo-authwall-${accountId}.png` }).catch(() => {});
        throw new Error(`Still on authwall after login: ${page.url()}`);
      }
      console.log(`LinkedIn #${accountId}: on profile ${page.url()}`);

      // Open Add/Edit photo modal (prefer visible control — duplicates exist in DOM)
      let opened = false;
      const addCandidates = await page.$$(
        'a[aria-label="Add photo"], button[aria-label="Add photo"], a[aria-label*="Edit profile photo" i], button[aria-label*="Edit profile photo" i], a[aria-label*="Change photo" i], button[aria-label*="Change photo" i], a[aria-label*="profile photo" i], button[aria-label*="profile photo" i], button[aria-label*="Edit photo" i], a[aria-label*="Edit photo" i]'
      );
      for (const el of addCandidates) {
        if (await el.isVisible().catch(() => false)) {
          await el.click({ force: true });
          opened = true;
          break;
        }
      }
      if (!opened) {
        opened = await page.evaluate(() => {
          const els = [...document.querySelectorAll('a, button, [role="button"]')];
          const el =
            els.find((e) => {
              const label = `${e.getAttribute('aria-label') || ''} ${e.innerText || ''}`;
              if (!/add photo|edit (your )?profile photo|change photo|profile photo/i.test(label)) return false;
              const r = e.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            }) ||
            els.find((e) =>
              /add photo|edit (your )?profile photo|change photo/i.test(
                `${e.getAttribute('aria-label') || ''} ${e.innerText || ''}`
              )
            );
          if (el) {
            el.scrollIntoView({ block: 'center' });
            el.click();
            return true;
          }
          return false;
        });
      }
      if (!opened) {
        await page.screenshot({ path: `/tmp/linkedin-photo-no-add-${accountId}.png` }).catch(() => {});
        throw new Error('Add photo control not found');
      }
      await this.humanLikeDelay(1500, 2500);

      // Upload via filechooser (LinkedIn "Upload photo" button)
      try {
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 12000 }),
          page.evaluate(() => {
            const b = [...document.querySelectorAll('button, [role="button"]')].find((x) =>
              /^Upload photo$/i.test((x.innerText || '').trim())
            );
            if (b) b.click();
          }),
        ]);
        await chooser.setFiles(photoPath);
        console.log(`LinkedIn #${accountId}: file set via chooser`);
      } catch (e) {
        console.warn(`LinkedIn #${accountId}: filechooser failed (${e.message}), trying input`);
        const input = await page.$('input[type="file"]');
        if (!input) {
          await page.screenshot({ path: `/tmp/linkedin-photo-no-input-${accountId}.png` }).catch(() => {});
          throw new Error('LinkedIn photo file input not found');
        }
        await input.setInputFiles(photoPath);
      }

      await this.humanLikeDelay(3000, 5000);

      // Dismiss content-credentials tip if present (can block Save)
      for (let i = 0; i < 2; i++) {
        await page.evaluate(() => {
          const b = [...document.querySelectorAll('button')].find((x) =>
            /^Got it$/i.test((x.innerText || '').trim())
          );
          if (b) b.click();
        }).catch(() => {});
        await this.humanLikeDelay(400, 800);
      }

      await page.screenshot({ path: `/tmp/linkedin-photo-before-save-${accountId}.png` }).catch(() => {});

      // Crop editor → Save changes (may need a couple confirms / skip feed share)
      for (let i = 0; i < 6; i++) {
        const clicked = await page.evaluate(() => {
          const buttons = [...document.querySelectorAll('button, [role="button"]')];
          const order = [
            /^Save changes$/i,
            /^Save photo$/i,
            /^Save to profile$/i,
            /^Apply$/i,
            /^Done$/i,
            /^Save$/i,
            /^Skip$/i,
            /^Not now$/i,
          ];
          for (const re of order) {
            const b = buttons.find((x) => {
              if (!re.test((x.innerText || '').trim()) || x.disabled) return false;
              const r = x.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            });
            if (b) {
              b.click();
              return (b.innerText || '').trim();
            }
          }
          return null;
        });
        if (!clicked) break;
        console.log(`LinkedIn #${accountId}: clicked "${clicked}"`);
        await this.humanLikeDelay(3000, 5000);
        await page.screenshot({ path: `/tmp/linkedin-photo-after-save-${accountId}-${i}.png` }).catch(() => {});

        // Detect rejection / error toast
        const err = await page.evaluate(() => {
          const text = (document.body?.innerText || '').slice(0, 2500);
          if (/couldn.?t (save|upload)|failed|not allowed|try again|content credential/i.test(text) &&
              /error|unable|problem/i.test(text)) {
            return text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 8).join(' | ');
          }
          return null;
        }).catch(() => null);
        if (err) console.warn(`LinkedIn #${accountId}: possible error — ${err}`);
      }

      // Extra settle time for CDN photo propagation
      await this.humanLikeDelay(4000, 6000);

      await page.goto('https://www.linkedin.com/in/me/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await this.humanLikeDelay(2500, 4000);
      await page.screenshot({ path: `/tmp/linkedin-photo-done-${accountId}.png` }).catch(() => {});

      const photoInfo = await page.evaluate(() => {
        const addStill = [...document.querySelectorAll('a, button')].some((e) =>
          /^Add photo$/i.test((e.getAttribute('aria-label') || '').trim())
        );
        const imgs = [...document.querySelectorAll('img')].filter((i) => i.width >= 72);
        const profileImg =
          imgs.find((i) =>
            /profile-displayphoto|profile-display|EntityPhoto|presencephoto|eprofile/i.test(
              `${i.className} ${i.alt} ${i.src}`
            )
          ) || imgs.find((i) => /media\.licdn\.com.*profile/i.test(i.src));
        return {
          addStill,
          src: profileImg?.src || null,
          alt: profileImg?.alt || null,
          url: location.href,
        };
      }).catch(() => ({}));

      await this.persistSession(page, 'linkedin', accountId);

      const success =
        !/authwall|\/login/i.test(photoInfo.url || '') &&
        !!(photoInfo.src && /media\.licdn\.com/i.test(photoInfo.src));
      return {
        success,
        accountId,
        email: loginEmail,
        profileUrl,
        finalUrl: photoInfo.url || null,
        photoSrc: photoInfo.src || null,
        usedProxy: !!proxyId,
      };
    } catch (error) {
      console.error(`LinkedIn photo update failed for ${accountId}:`, error.message);
      return { success: false, accountId, error: error.message, usedProxy: !!proxyId };
    } finally {
      if (browser) await browser.close();
      this._untrackBrowser(accountId);
    }
  }

  /**
   * Update LinkedIn intro (headline/industry), About, and current experience
   * for an HR/Talent persona (InsightHire advocacy).
   */
  async updateLinkedInHiringPersona(accountId, persona, { requireProxy = false } = {}) {
    const steps = [];
    let browser;
    try {
      const account = await this.getAccount(accountId);
      if (account.platform !== 'linkedin') {
        throw new Error(`Account ${accountId} is ${account.platform}, expected linkedin`);
      }
      const creds = typeof account.credentials === 'string'
        ? JSON.parse(account.credentials)
        : (account.credentials || {});
      const password = creds.password;
      const loginEmail = account.email || account.username;
      const extras = {
        totpSecret: creds.totp_secret || creds.totp || creds.twofa,
        emailPassword: creds.email_password,
        profileUrl: creds.profile_url,
      };

      const openBrowser = async (withProxy) => {
        if (browser) {
          await browser.close().catch(() => {});
          this._untrackBrowser(accountId);
          browser = null;
        }
        if (withProxy) {
          const result = await this.createBrowserForAccount(accountId, 2, { requireProxy });
          browser = result.browser;
          return result.page;
        }
        const result = await this.createBrowser(
          null,
          false,
          await this.getOrCreateDeviceProfile(accountId, { forceDesktop: true })
        );
        browser = result.browser;
        result.accountId = accountId;
        this._trackBrowser(accountId, result.browser);
        return result.page;
      };

      let page = await openBrowser(false);
      let loggedIn = false;
      const restored = await this.restoreSession(page, 'linkedin', accountId);
      if (restored) {
        await page.goto('https://www.linkedin.com/in/me/', {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
        await this.humanLikeDelay(2000, 3500);
        if (!/authwall|\/login|\/signup|\/uas\//i.test(page.url())) loggedIn = true;
      }
      if (!loggedIn) {
        loggedIn = await this.performLogin(page, 'linkedin', loginEmail, password, extras);
        if (!loggedIn && !requireProxy) {
          page = await openBrowser(true);
          loggedIn = await this.performLogin(page, 'linkedin', loginEmail, password, extras);
        }
        if (!loggedIn) throw new Error('LinkedIn login failed');
        await this.persistSession(page, 'linkedin', accountId);
        await page.goto('https://www.linkedin.com/in/me/', {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
        await this.humanLikeDelay(2000, 3500);
      }
      if (/authwall|\/login/i.test(page.url())) {
        throw new Error(`Authwall: ${page.url()}`);
      }

      const clickSave = async () => {
        const clicked = await page.evaluate(() => {
          const buttons = [...document.querySelectorAll('button, [role="button"]')];
          const order = [/^Save$/i, /^Save changes$/i, /^Done$/i, /^Continue$/i];
          for (const re of order) {
            const b = buttons.find((x) => {
              if (!re.test((x.innerText || '').trim()) || x.disabled) return false;
              const r = x.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            });
            if (b) {
              b.click();
              return (b.innerText || '').trim();
            }
          }
          return null;
        });
        if (clicked) await this.humanLikeDelay(2500, 4000);
        return clicked;
      };

      const fillContentEditable = async (text) => {
        const handle = await page.$('div[role="textbox"][contenteditable="true"]');
        if (!handle) return false;
        await handle.click({ force: true });
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
        await page.keyboard.press('Backspace');
        await handle.type(text, { delay: 12 });
        return true;
      };

      // --- Intro: headline + industry ---
      await page.goto('https://www.linkedin.com/in/me/edit/intro/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await this.humanLikeDelay(2500, 4000);

      const headlineOk = await fillContentEditable(persona.headline);
      if (headlineOk) steps.push('headline');
      else console.warn(`LinkedIn #${accountId}: headline field missing`);

      // Industry typeahead
      const industryInput = await page.$('input[aria-label="Industry*"], input[aria-label*="Industry" i]');
      if (industryInput) {
        await industryInput.click({ force: true });
        await industryInput.fill('');
        await industryInput.type('Staffing and Recruiting', { delay: 25 });
        await this.humanLikeDelay(1200, 2000);
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        steps.push('industry');
        await this.humanLikeDelay(800, 1500);
      }

      // Prefer adding a new current position from intro dropdown if present
      const addedPositionFromIntro = await page.evaluate(() => {
        const select = [...document.querySelectorAll('select')].find((s) =>
          /Position/i.test(s.labels?.[0]?.innerText || '')
        );
        if (!select) return false;
        const opt = [...select.options].find((o) => /add new position/i.test(o.textContent || ''));
        if (!opt) return false;
        select.value = opt.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }).catch(() => false);

      const savedIntro = await clickSave();
      if (savedIntro) steps.push(`intro:${savedIntro}`);
      await page.screenshot({ path: `/tmp/linkedin-persona-intro-${accountId}.png` }).catch(() => {});

      // If intro "Add new position" opened a modal, fill it; otherwise use experience form
      await this.humanLikeDelay(1500, 2500);
      const onPositionForm = await page.evaluate(() =>
        /Title|Company name|Employment type|Add experience|Add position/i.test(
          (document.body?.innerText || '').slice(0, 2000)
        ) && !!document.querySelector('input, textarea, div[contenteditable="true"]')
      );

      const fillPositionForm = async () => {
        // Title
        let titleInput = await page.$('input[aria-label*="Title" i], input[id*="title" i]');
        if (!titleInput) {
          titleInput = await page.evaluateHandle(() => {
            const labeled = [...document.querySelectorAll('input')].find((i) =>
              /Title/i.test(i.labels?.[0]?.innerText || i.getAttribute('aria-label') || '')
            );
            return labeled || null;
          });
          if (titleInput && titleInput.asElement) titleInput = titleInput.asElement();
          else titleInput = null;
        }
        if (titleInput) {
          await titleInput.click({ force: true });
          await titleInput.fill('');
          await titleInput.type(persona.title, { delay: 20 });
        }

        // Company typeahead
        let companyInput = await page.$('input[aria-label*="Company" i], input[id*="company" i]');
        if (!companyInput) {
          companyInput = await page.evaluateHandle(() => {
            const labeled = [...document.querySelectorAll('input')].find((i) =>
              /Company/i.test(i.labels?.[0]?.innerText || i.getAttribute('aria-label') || '')
            );
            return labeled || null;
          });
          if (companyInput && companyInput.asElement) companyInput = companyInput.asElement();
          else companyInput = null;
        }
        if (companyInput) {
          await companyInput.click({ force: true });
          await companyInput.fill('');
          await companyInput.type(persona.company, { delay: 20 });
          await this.humanLikeDelay(1200, 2000);
          // Pick first suggestion or confirm typed company
          await page.keyboard.press('ArrowDown').catch(() => {});
          await page.keyboard.press('Enter').catch(() => {});
        }

        // Mark as current role if checkbox exists
        await page.evaluate(() => {
          const boxes = [...document.querySelectorAll('input[type="checkbox"]')];
          const current = boxes.find((c) =>
            /I am currently working|currently work/i.test(
              `${c.labels?.[0]?.innerText || ''} ${c.parentElement?.innerText || ''}`
            )
          );
          if (current && !current.checked) current.click();
        }).catch(() => {});

        // Start date rough defaults (year/month selects)
        await page.evaluate(() => {
          const selects = [...document.querySelectorAll('select')];
          const year = selects.find((s) => /Year/i.test(s.getAttribute('aria-label') || s.labels?.[0]?.innerText || ''));
          const month = selects.find((s) => /Month/i.test(s.getAttribute('aria-label') || s.labels?.[0]?.innerText || ''));
          if (year) {
            const opt = [...year.options].find((o) => o.textContent.trim() === '2024') ||
              [...year.options].find((o) => /^\d{4}$/.test(o.textContent.trim()));
            if (opt) {
              year.value = opt.value;
              year.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
          if (month) {
            const opt = [...month.options].find((o) => /Jan|February|Mar/i.test(o.textContent)) || month.options[1];
            if (opt) {
              month.value = opt.value;
              month.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
        }).catch(() => {});

        const saved = await clickSave();
        return !!saved;
      };

      if (onPositionForm || addedPositionFromIntro) {
        const ok = await fillPositionForm();
        if (ok) steps.push('experience');
      } else {
        // Dedicated experience add URL patterns LinkedIn uses
        await page.goto('https://www.linkedin.com/in/me/', {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
        await this.humanLikeDelay(1500, 2500);
        const openedExp = await page.evaluate(() => {
          const links = [...document.querySelectorAll('a, button')];
          const add = links.find((e) =>
            /add (a )?position|add experience|add employment/i.test(
              `${e.getAttribute('aria-label') || ''} ${e.innerText || ''}`
            ) || /\/edit\/forms\/position/i.test(e.getAttribute('href') || '')
          );
          if (add) {
            add.click();
            return true;
          }
          return false;
        });
        if (openedExp) {
          await this.humanLikeDelay(2500, 4000);
          const ok = await fillPositionForm();
          if (ok) steps.push('experience');
        } else {
          // Try known path
          const profilePath = page.url().split('?')[0].replace(/\/?$/, '');
          await page.goto(`${profilePath}/edit/forms/position/new/`, {
            waitUntil: 'domcontentloaded',
            timeout: 45000,
          }).catch(() => {});
          await this.humanLikeDelay(2500, 4000);
          if (await page.$('input, div[contenteditable="true"]')) {
            const ok = await fillPositionForm();
            if (ok) steps.push('experience');
          } else {
            console.warn(`LinkedIn #${accountId}: experience form not found`);
          }
        }
      }
      await page.screenshot({ path: `/tmp/linkedin-persona-exp-${accountId}.png` }).catch(() => {});

      // --- About / Summary ---
      await page.goto('https://www.linkedin.com/in/me/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await this.humanLikeDelay(2000, 3500);
      const openedAbout = await page.evaluate(() => {
        const el = [...document.querySelectorAll('a, button')].find((e) => {
          const label = `${e.getAttribute('aria-label') || ''} ${e.innerText || ''}`;
          const href = e.getAttribute('href') || '';
          return /add a summary|edit about|edit summary|add about/i.test(label) ||
            /\/edit\/forms\/summary/i.test(href) ||
            /\/edit\/forms\/about/i.test(href);
        });
        if (el) {
          el.click();
          return true;
        }
        return false;
      });
      if (!openedAbout) {
        const base = page.url().split('?')[0].replace(/\/?$/, '');
        await page.goto(`${base}/edit/forms/summary/new/?profileFormEntryPoint=GUIDANCE_CARD`, {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        }).catch(() => {});
      }
      await this.humanLikeDelay(2500, 4000);

      // About is usually textarea or contenteditable
      let aboutFilled = false;
      const aboutArea = await page.$('textarea, div[role="textbox"][contenteditable="true"], .ql-editor');
      if (aboutArea) {
        const tag = await aboutArea.evaluate((el) => el.tagName);
        await aboutArea.click({ force: true });
        if (tag === 'TEXTAREA') {
          await aboutArea.fill('');
          await aboutArea.type(persona.about, { delay: 8 });
        } else {
          await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
          await page.keyboard.press('Backspace');
          await aboutArea.type(persona.about, { delay: 8 });
        }
        aboutFilled = true;
      }
      if (aboutFilled) {
        const saved = await clickSave();
        if (saved) steps.push('about');
      } else {
        console.warn(`LinkedIn #${accountId}: about field missing`);
      }
      await page.screenshot({ path: `/tmp/linkedin-persona-about-${accountId}.png` }).catch(() => {});

      // Store persona on account credentials for later organic posting
      const nextCreds = {
        ...creds,
        hiring_persona: {
          headline: persona.headline,
          title: persona.title,
          company: persona.company,
          about: persona.about,
          product: 'InsightHire',
          updated_at: new Date().toISOString(),
        },
      };
      await pool.query(
        `UPDATE social_accounts
         SET credentials = $2::jsonb, updated_at = NOW()
         WHERE id = $1`,
        [accountId, JSON.stringify(nextCreds)]
      );

      await this.persistSession(page, 'linkedin', accountId);
      await page.goto('https://www.linkedin.com/in/me/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await this.humanLikeDelay(2000, 3500);
      await page.screenshot({ path: `/tmp/linkedin-persona-done-${accountId}.png` }).catch(() => {});

      const snapshot = await page.evaluate(() => {
        const text = (document.body?.innerText || '').slice(0, 2500);
        return {
          url: location.href,
          hasHeadlineHint: /Talent|Recruit|People Ops|HR Director|Sourcer|Hiring/i.test(text),
          snippet: text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 12).join(' | '),
        };
      }).catch(() => ({}));

      const success = steps.includes('headline') || steps.includes('about') || snapshot.hasHeadlineHint;
      return {
        success,
        accountId,
        name: persona.name,
        steps,
        profileUrl: creds.profile_url || snapshot.url,
        snippet: snapshot.snippet || null,
      };
    } catch (error) {
      console.error(`LinkedIn persona update failed for ${accountId}:`, error.message);
      return { success: false, accountId, name: persona?.name, steps, error: error.message };
    } finally {
      if (browser) await browser.close();
      this._untrackBrowser(accountId);
    }
  }

  async linkedInPostComment(page, postUrl, comment, parentCommentId = null) {
    try {
      const targetUrl = parentCommentId
        ? postUrl + '?commentUrn=urn:li:comment:' + parentCommentId
        : postUrl;

      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
      await this.humanLikeDelay(1500, 3000);
      await this.simulateHumanBehavior(page);

      const commentBtn = await page.$('button[aria-label*="Comment"]');
      if (commentBtn) {
        await commentBtn.click();
        await this.humanLikeDelay(1000, 2000);
      }

      const editor = await page.waitForSelector('.ql-editor', { timeout: 10000 });
      const eBox = await editor.boundingBox();
      if (eBox) {
        await this.simulateMouseMovement(page, 0, 0, eBox.x + eBox.width / 2, eBox.y + eBox.height / 2);
      }

      await this.humanLikeTyping(page, '.ql-editor', comment);
      await this.humanLikeDelay(500, 1500);

      const postCommentBtn = await page.$('button:has-text("Post")');
      if (postCommentBtn) {
        await postCommentBtn.click();
        await this.humanLikeDelay(2000, 4000);
        return true;
      }
      return false;
    } catch (error) {
      console.error('Error posting LinkedIn comment:', error);
      return false;
    }
  }

  async createTikTokPost(accountId, videoPath, caption) {
    console.log('TikTok posting requires mobile app automation or their business API');
    throw new Error('TikTok automation not implemented - use their business API instead');
  }

  /**
   * TikTok web login (email/username + password).
   * Note: TikTok frequently serves captcha / app-push; success is best-effort.
   */
  async tiktokLogin(page, username, password, extras = {}) {
    const loginId = username || extras.email;
    try {
      await page.goto('https://www.tiktok.com/login/phone-or-email/email', {
        waitUntil: 'domcontentloaded',
        timeout: 90000,
      });
      await this.humanLikeDelay(2500, 4000);

      // Cookie / consent
      await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button, [role="button"]')];
        const accept = buttons.find((b) =>
          /^(Accept all|Allow all|Got it|Accept)$/i.test((b.innerText || '').trim())
        );
        if (accept) accept.click();
      }).catch(() => {});
      await this.humanLikeDelay(800, 1500);

      // Sometimes land on generic login — click through to email/username
      const onEmailForm = await page.$('input[name="username"], input[placeholder*="Email" i], input[placeholder*="Username" i]');
      if (!onEmailForm) {
        await page.evaluate(() => {
          const links = [...document.querySelectorAll('a, div, button, span')];
          const emailPath = links.find((el) =>
            /email|username|phone \/ email|use phone/i.test((el.innerText || '').trim())
          );
          if (emailPath) emailPath.click();
        }).catch(() => {});
        await this.humanLikeDelay(1500, 2500);
        // Prefer email tab if phone/email tabs exist
        await page.evaluate(() => {
          const tabs = [...document.querySelectorAll('a, div, span, button')];
          const emailTab = tabs.find((el) => /^(Email|Email \/ Username|Log in with email or username)$/i.test((el.innerText || '').trim()));
          if (emailTab) emailTab.click();
        }).catch(() => {});
        await this.humanLikeDelay(1000, 2000);
      }

      // Username / email
      let userInput = await page.waitForSelector(
        'input[name="username"], input[placeholder*="Email" i], input[placeholder*="Username" i], input[type="text"]',
        { timeout: 20000, state: 'visible' }
      ).catch(() => null);
      if (!userInput) {
        const handles = await page.$$('input[type="text"], input[type="email"]');
        for (const h of handles) {
          if (await h.isVisible().catch(() => false)) {
            userInput = h;
            break;
          }
        }
      }
      if (!userInput) {
        console.log(`TikTok username input missing for ${loginId}`);
        await page.screenshot({ path: `/tmp/tiktok-no-user-${Date.now()}.png` }).catch(() => {});
        return false;
      }
      await userInput.click({ force: true });
      await userInput.fill('');
      await userInput.type(loginId, { delay: 35 });
      await this.humanLikeDelay(400, 900);

      // Password
      let pwdInput = await page.$('input[type="password"]');
      if (!pwdInput) {
        const handles = await page.$$('input[type="password"]');
        for (const h of handles) {
          if (await h.isVisible().catch(() => false)) {
            pwdInput = h;
            break;
          }
        }
      }
      if (!pwdInput) {
        console.log(`TikTok password input missing for ${loginId}`);
        await page.screenshot({ path: `/tmp/tiktok-no-pwd-${Date.now()}.png` }).catch(() => {});
        return false;
      }
      await pwdInput.click({ force: true });
      await pwdInput.fill('');
      await pwdInput.type(password, { delay: 35 });
      await this.humanLikeDelay(400, 900);

      await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button, [role="button"]')];
        const submit = buttons.find((b) => /^(Log in|Sign in|Continue)$/i.test((b.innerText || '').trim()));
        if (submit) submit.click();
        else {
          const typed = document.querySelector('button[type="submit"]');
          if (typed) typed.click();
        }
      });
      await this.humanLikeDelay(4500, 7000);

      const state = await page.evaluate(() => {
        const text = (document.body?.innerText || '').slice(0, 3500);
        return {
          captcha: /captcha|verify you|drag the|security check|unusual activity/i.test(text) ||
            !!document.querySelector('iframe[src*="captcha"], #captcha-verify-container, .captcha-verify-container'),
          rateLimited: /maximum number of attempts|too many (attempts|tries)|try again later/i.test(text),
          badCreds: /incorrect|wrong password|couldn.?t find|invalid username|username or password/i.test(text),
          snippet: text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 10).join(' | '),
        };
      }).catch(() => ({}));

      if (state.rateLimited) {
        console.log(`TikTok rate-limited for ${loginId}: ${state.snippet}`);
        await page.screenshot({ path: `/tmp/tiktok-ratelimit-${Date.now()}.png` }).catch(() => {});
        return false;
      }
      if (state.badCreds) {
        console.log(`TikTok bad credentials for ${loginId}: ${state.snippet}`);
        await page.screenshot({ path: `/tmp/tiktok-badcreds-${Date.now()}.png` }).catch(() => {});
        return false;
      }
      if (state.captcha) {
        console.log(`TikTok captcha for ${loginId}: ${state.snippet}`);
        await page.screenshot({ path: `/tmp/tiktok-captcha-${Date.now()}.png` }).catch(() => {});
        return false;
      }

      const alive = await this.verifySessionAlive(page, 'tiktok');
      if (alive) {
        console.log(`TikTok login success as ${loginId}`);
        return true;
      }

      // Soft success: left login URL and landed on feed/profile
      const url = page.url();
      if (/tiktok\.com/i.test(url) && !/\/login/i.test(url)) {
        console.log(`TikTok login likely success for ${loginId} url=${url}`);
        return true;
      }

      console.log(`TikTok login failed for ${loginId}. url=${url} hint=${state.snippet || ''}`);
      await page.screenshot({ path: `/tmp/tiktok-login-failed-${Date.now()}.png` }).catch(() => {});
      return false;
    } catch (error) {
      console.error('TikTok login error:', error);
      await page.screenshot({ path: `/tmp/tiktok-login-error-${Date.now()}.png` }).catch(() => {});
      return false;
    }
  }

  /**
   * Smoke-test TikTok login (username, with email fallback).
   */
  async smokeTestTikTokLogin(accountId, { requireProxy = false } = {}) {
    let browser;
    let proxyId = null;
    try {
      const account = await this.getAccount(accountId);
      if (account.platform !== 'tiktok') {
        throw new Error(`Account ${accountId} is ${account.platform}, expected tiktok`);
      }
      const creds = typeof account.credentials === 'string'
        ? JSON.parse(account.credentials)
        : (account.credentials || {});
      const password = creds.password;
      if (!password || password === 'default_password') {
        throw new Error('Account has no real password');
      }

      const extras = {
        email: creds.email || account.email,
      };

      const tryOnce = async (withProxy, loginAs) => {
        if (browser) {
          await browser.close().catch(() => {});
          this._untrackBrowser(accountId);
          browser = null;
        }
        if (withProxy) {
          if (requireProxy) await this.requireProxyForLive(accountId);
          const result = await this.createBrowserForAccount(accountId, 2, { requireProxy });
          browser = result.browser;
          proxyId = result.proxyConfig?._proxyId || null;
          return this.ensureLoggedIn(result.page, 'tiktok', accountId, loginAs, password, extras);
        }
        const result = await this.createBrowser(
          null,
          false,
          await this.getOrCreateDeviceProfile(accountId, { forceDesktop: true })
        );
        browser = result.browser;
        proxyId = null;
        result.accountId = accountId;
        this._trackBrowser(accountId, result.browser);
        return this.ensureLoggedIn(result.page, 'tiktok', accountId, loginAs, password, extras);
      };

      // Try username only first (email login often hits rate limits on these dumps)
      const loginOrder = [account.username];
      if (extras.email && extras.email !== account.username) {
        // email as secondary attempt only
        loginOrder.push(extras.email);
      }

      let loggedIn = false;
      let lastHint = null;
      for (const loginAs of loginOrder) {
        // Prefer direct first for TikTok — residential proxies often get hard-blocked
        try {
          loggedIn = await tryOnce(false, loginAs);
        } catch (err) {
          lastHint = err.message;
          console.warn(`TikTok direct login failed for ${loginAs} (${err.message})`);
        }
        if (!loggedIn) {
          try {
            loggedIn = await tryOnce(true, loginAs);
          } catch (err) {
            lastHint = err.message;
            console.warn(`TikTok proxy login failed for ${loginAs} (${err.message})`);
          }
        }
        if (loggedIn) break;
        // Cool down between identifier attempts
        await new Promise((r) => setTimeout(r, 8000));
      }

      if (loggedIn) {
        await pool.query(
          `UPDATE social_accounts
           SET warmup_status = 'warmed', warmed_up_at = NOW(), last_used_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [accountId]
        ).catch(() => {});
      }

      if (proxyId) {
        await proxyService.updateProxyStats(proxyId, !!loggedIn, {
          reason: loggedIn ? null : 'tiktok_login_failed',
        }).catch(() => {});
      }

      return {
        success: !!loggedIn,
        accountId,
        username: account.username,
        email: extras.email || null,
        usedProxy: !!proxyId,
      };
    } catch (error) {
      if (proxyId) {
        await proxyService.updateProxyStats(proxyId, false, { reason: error.message }).catch(() => {});
      }
      return { success: false, accountId, error: error.message };
    } finally {
      if (browser) await browser.close();
      this._untrackBrowser(accountId);
    }
  }

  async postComment(platform, accountId, postUrl, comment, parentCommentId = null, { requireProxy = false } = {}) {
    let browser, context, page, proxyId;
    let operationSuccess = false;
    let lastErrorMsg = null;

    try {
      if (!postUrl || !String(postUrl).startsWith('http')) {
        throw new Error(`postComment requires a full URL, got: ${postUrl}`);
      }

      const account = await this.getAccount(accountId);
      const result = await this.createBrowserForAccount(accountId, 2, { requireProxy });
      browser = result.browser;
      context = result.context;
      page = result.page;
      proxyId = result.proxyConfig?._proxyId;

      const loggedIn = await this.ensureLoggedIn(page, platform, accountId, account.username, account.credentials.password);
      if (!loggedIn) throw new Error('Login failed');

      let platformCommentId = null;
      switch (platform) {
        case 'reddit':
          platformCommentId = await this.redditPostComment(page, postUrl, comment, parentCommentId);
          break;
        case 'x':
          platformCommentId = await this.xPostComment(page, postUrl, comment, parentCommentId);
          break;
        case 'linkedin':
          platformCommentId = await this.linkedInPostComment(page, postUrl, comment, parentCommentId);
          break;
        default:
          throw new Error(`Platform ${platform} not supported for comments`);
      }

      if (!platformCommentId) {
        throw new Error('Comment submit failed — no platform comment id');
      }

      await this.persistSession(page, platform, accountId);
      operationSuccess = true;
      return platformCommentId;
    } catch (error) {
      lastErrorMsg = error.message || String(error);
      console.error('Error in postComment:', error);
      throw error;
    } finally {
      if (browser) await browser.close();
      this._untrackBrowser(accountId);
      if (proxyId) {
        try {
          await proxyService.updateProxyStats(proxyId, operationSuccess, {
            reason: lastErrorMsg,
          });
        } catch (statsError) {
          console.error('Error updating proxy stats:', statsError);
        }
      }
    }
  }

  /**
   * Browse a subreddit listing via the account's dedicated proxy to find threads.
   * Reddit blocks JSON APIs through many proxies; scrape the public HTML feed instead.
   * Login is not required for discovery (posting still logs in separately).
   */
  async listRedditSubredditPosts(accountId, subreddit, { sort = 'hot', limit = 20 } = {}) {
    let browser;
    let proxyId = null;
    try {
      await this.requireProxyForLive(accountId);
      const result = await this.createBrowserForAccount(accountId, 2, { requireProxy: true });
      browser = result.browser;
      proxyId = result.proxyConfig?._proxyId || null;
      const page = result.page;

      try {
        await this.restoreSession(page, 'reddit', accountId);
      } catch { /* optional */ }

      const cleanSub = String(subreddit || '').replace(/^r\//i, '');
      const url = `https://www.reddit.com/r/${encodeURIComponent(cleanSub)}/${sort}/`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
      await this.humanLikeDelay(2500, 4500);
      try { await this.randomScroll(page); } catch { /* ignore */ }

      const posts = await page.evaluate((max) => {
        const seen = new Set();
        const out = [];
        const anchors = Array.from(document.querySelectorAll('a[href*="/comments/"]'));
        for (const a of anchors) {
          const href = a.href || '';
          const m = href.match(/reddit\.com\/r\/([^/]+)\/comments\/([a-z0-9]+)/i);
          if (!m) continue;
          const key = m[2];
          if (seen.has(key)) continue;
          seen.add(key);

          let title = (a.textContent || '').trim();
          const article = a.closest('article, shreddit-post, [data-testid="post-container"]');
          if (!title || title.length < 5) {
            const titleEl = article?.querySelector('h1, h2, h3, a[slot="title"], [id^="post-title"]');
            title = (titleEl?.textContent || '').trim();
          }
          if (!title || title.length < 5) continue;
          // Skip nav/sidebar noise
          if (/^(comment|comments|share|award|reply)$/i.test(title)) continue;

          let selftext = '';
          const body = article?.querySelector('[data-click-id="text"], [slot="text-body"], .md');
          if (body) selftext = (body.textContent || '').trim().slice(0, 1200);

          const scoreAttr = article?.getAttribute?.('score')
            || article?.getAttribute?.('data-score')
            || '';
          const commentsAttr = article?.getAttribute?.('comment-count')
            || article?.getAttribute?.('data-comment-count')
            || '';

          out.push({
            subreddit: m[1],
            platform_post_id: key,
            title,
            selftext,
            post_url: `https://www.reddit.com/r/${m[1]}/comments/${key}/`,
            score: Number(scoreAttr) || 0,
            num_comments: Number(commentsAttr) || 0,
            created_utc: Date.now() / 1000,
          });
          if (out.length >= max) break;
        }
        return out;
      }, limit);

      return posts;
    } finally {
      if (browser) await browser.close();
      this._untrackBrowser(accountId);
      if (proxyId != null) {
        try { await proxyService.updateProxyStats(proxyId, true); }
        catch { /* ignore */ }
      }
    }
  }

  /** Lightweight warm-up: login + browse without posting. Platform from account if omitted. */
  async warmUpAccount(accountId, platform = null) {
    let browser;
    try {
      const account = await this.getAccount(accountId);
      platform = platform || account.platform;
      const creds = typeof account.credentials === 'string'
        ? JSON.parse(account.credentials)
        : (account.credentials || {});
      const password = creds.password || account.credentials?.password;
      const extras = {
        email: creds.email || account.email,
        totpSecret: creds.totp_secret || creds.totp || creds.twofa,
      };

      // TikTok: prefer direct; others use assigned proxy when available
      const skipProxy = platform === 'tiktok';
      const result = await this.createBrowserForAccount(accountId, 2, {
        requireProxy: platform !== 'tiktok',
        skipProxy,
      }).catch(async () =>
        this.createBrowserForAccount(accountId, 2, { requireProxy: false, skipProxy: true })
      );
      browser = result.browser;
      const page = result.page;

      const loginAs =
        platform === 'linkedin'
          ? (creds.email || account.email || account.username)
          : account.username;

      const loggedIn = await this.ensureLoggedIn(
        page, platform, accountId, loginAs, password, extras
      );
      if (!loggedIn) throw new Error('Warm-up login failed');

      await this.browseWarmFeed(page, platform);

      await this.persistSession(page, platform, accountId);
      await pool.query(
        `UPDATE social_accounts
         SET warmup_status = 'warmed', warmed_up_at = NOW(), last_used_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [accountId]
      );
      return { success: true, accountId, platform, warmup_status: 'warmed' };
    } catch (error) {
      await pool.query(
        `UPDATE social_accounts SET warmup_status = 'failed', updated_at = NOW() WHERE id = $1`,
        [accountId]
      ).catch(() => {});
      throw error;
    } finally {
      if (browser) await browser.close();
      this._untrackBrowser(accountId);
    }
  }

  async browseWarmFeed(page, platform) {
    if (platform === 'reddit') {
      await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.humanLikeDelay(2000, 4000);
      await this.simulateHumanBehavior(page);
      await page.goto('https://www.reddit.com/r/popular/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.humanLikeDelay(2000, 5000);
      await this.simulateHumanBehavior(page);
      return;
    }
    if (platform === 'instagram') {
      await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 90000 });
      await this.humanLikeDelay(2500, 4500);
      await this.dismissInstagramOverlays(page).catch(() => {});
      await this.simulateHumanBehavior(page);
      await this.randomScroll(page).catch(() => {});
      await page.goto('https://www.instagram.com/explore/', { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
      await this.humanLikeDelay(2000, 4000);
      await this.simulateHumanBehavior(page);
      return;
    }
    if (platform === 'tiktok') {
      await page.goto('https://www.tiktok.com/foryou', { waitUntil: 'domcontentloaded', timeout: 90000 });
      await this.humanLikeDelay(3000, 5000);
      for (let i = 0; i < 3; i++) {
        await this.humanLikeDelay(2500, 5000);
        await page.keyboard.press('ArrowDown').catch(() => {});
        await this.simulateHumanBehavior(page);
      }
      return;
    }
    if (platform === 'x') {
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 90000 });
      await this.humanLikeDelay(2500, 4500);
      await this.simulateHumanBehavior(page);
      await this.randomScroll(page).catch(() => {});
      return;
    }
    // linkedin / default — just sit on feed
    const home =
      platform === 'linkedin' ? 'https://www.linkedin.com/feed/' : 'https://www.google.com/';
    await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
    await this.humanLikeDelay(2000, 4000);
    await this.simulateHumanBehavior(page);
  }

  async instagramFollowUser(page, targetUsername) {
    const handle = String(targetUsername || '').replace(/^@/, '');
    const profileUrl = `https://www.instagram.com/${encodeURIComponent(handle)}/`;
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await this.humanLikeDelay(3000, 5000);
    await this.dismissInstagramOverlays(page).catch(() => {});
    await this.simulateHumanBehavior(page);

    // EN + common locales (ID/ES/PT/FR/DE)
    const followRe = /^(Follow|Follow back|Ikuti|Seguir|Suivre|Folgen|フォローする)$/i;
    const followingRe = /^(Following|Requested|Mengikuti|Siguiendo|Abonné|Gefolgt|フォロー中)$/i;

    const state = await page.evaluate(({ followReSource, followingReSource }) => {
      const followRe = new RegExp(followReSource, 'i');
      const followingRe = new RegExp(followingReSource, 'i');
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], div[role="button"]'));
      const labels = buttons.map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim());
      const following = labels.some((t) => followingRe.test(t.split('\n')[0]));
      return {
        following,
        followLabels: labels.filter((t) => /follow|ikuti|seguir|suivre|folgen|フォロー/i.test(t)).slice(0, 10),
        header: (document.body?.innerText || '').slice(0, 200),
      };
    }, { followReSource: followRe.source, followingReSource: followingRe.source });

    if (state.following) {
      return { followed: false, alreadyFollowing: true, profileUrl };
    }

    const clicked = await page.evaluate(({ followReSource }) => {
      const followRe = new RegExp(followReSource, 'i');
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], div[role="button"]'));
      for (const b of buttons) {
        const label = (b.innerText || b.getAttribute('aria-label') || '').trim().split('\n')[0];
        if (followRe.test(label)) {
          const rect = b.getBoundingClientRect();
          if (rect.width > 8 && rect.height > 8) {
            b.click();
            return label;
          }
        }
      }
      return null;
    }, { followReSource: followRe.source });
    await this.humanLikeDelay(1500, 3000);
    if (!clicked) {
      await page.screenshot({ path: `/tmp/ig-follow-miss-${handle}.png`, fullPage: true }).catch(() => {});
      throw new Error(
        `IG Follow button not found on @${handle} (saw: ${(state.followLabels || []).join(', ') || 'none'})`
      );
    }
    return { followed: true, alreadyFollowing: false, profileUrl, button: clicked };
  }

  async instagramLikeOnProfile(page, targetUsername) {
    const handle = String(targetUsername || '').replace(/^@/, '');
    if (!page.url().includes(`instagram.com/${handle}`)) {
      await page.goto(`https://www.instagram.com/${encodeURIComponent(handle)}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 90000,
      });
      await this.humanLikeDelay(2000, 4000);
    }
    await this.dismissInstagramOverlays(page).catch(() => {});

    const opened = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]'));
      for (const a of links) {
        const rect = a.getBoundingClientRect();
        if (rect.width > 40 && rect.height > 40) {
          a.click();
          return a.getAttribute('href');
        }
      }
      return null;
    });
    if (!opened) return { liked: false, reason: 'no_posts' };
    await this.humanLikeDelay(2000, 4000);

    const liked = await page.evaluate(() => {
      const likeBtn =
        document.querySelector('svg[aria-label="Like"]')?.closest('button, [role="button"]') ||
        document.querySelector('button[aria-label="Like"], [aria-label="Like"]');
      if (likeBtn) {
        likeBtn.click();
        return true;
      }
      // already liked
      if (document.querySelector('svg[aria-label="Unlike"]')) return 'already';
      return false;
    });
    await this.humanLikeDelay(1000, 2000);
    await page.keyboard.press('Escape').catch(() => {});
    return {
      liked: liked === true || liked === 'already',
      alreadyLiked: liked === 'already',
      postPath: opened,
    };
  }

  async tiktokFollowUser(page, targetUsername) {
    const handle = String(targetUsername || '').replace(/^@/, '');
    const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(handle)}`;
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await this.humanLikeDelay(3000, 5000);
    await this.simulateHumanBehavior(page);

    const state = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      const labels = buttons.map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim());
      const following = labels.some((t) => /^(Following|Friends|Requested)$/i.test(t));
      return { following };
    });
    if (state.following) {
      return { followed: false, alreadyFollowing: true, profileUrl };
    }

    const clicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const b of buttons) {
        const label = (b.innerText || b.getAttribute('aria-label') || '').trim();
        if (/^Follow$/i.test(label)) {
          const rect = b.getBoundingClientRect();
          if (rect.width > 8 && rect.height > 8) {
            b.click();
            return label;
          }
        }
      }
      return null;
    });
    await this.humanLikeDelay(1500, 3000);
    if (!clicked) {
      await page.screenshot({ path: `/tmp/tt-follow-miss-${handle}.png`, fullPage: true }).catch(() => {});
      throw new Error(`TikTok Follow button not found on @${handle}`);
    }
    return { followed: true, alreadyFollowing: false, profileUrl, button: clicked };
  }

  async tiktokLikeOnFeed(page) {
    await page.goto('https://www.tiktok.com/foryou', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await this.humanLikeDelay(3000, 5000);
    await page.keyboard.press('ArrowDown').catch(() => {});
    await this.humanLikeDelay(2000, 4000);
    const liked = await page.evaluate(() => {
      const btn =
        document.querySelector('[data-e2e="like-icon"]') ||
        document.querySelector('button[aria-label*="like" i], [aria-label*="Like"]');
      if (!btn) return false;
      btn.click();
      return true;
    });
    await this.humanLikeDelay(1000, 2000);
    return { liked: !!liked };
  }

  /**
   * One warm engagement cycle: browse → follow target → optional like.
   */
  async runSocialWarmAction(accountId, { handle, doFollow = true, doLike = true } = {}) {
    let browser;
    const account = await this.getAccount(accountId);
    const platform = account.platform;
    if (!['instagram', 'tiktok'].includes(platform)) {
      throw new Error(`runSocialWarmAction unsupported platform: ${platform}`);
    }
    const creds = typeof account.credentials === 'string'
      ? JSON.parse(account.credentials)
      : (account.credentials || {});
    const password = creds.password;
    if (!password || password === 'default_password') {
      throw new Error('Account has no real password');
    }
    const extras = {
      email: creds.email || account.email,
      totpSecret: creds.totp_secret || creds.totp || creds.twofa,
    };

    try {
      const skipProxy = platform === 'tiktok';
      let result;
      try {
        result = await this.createBrowserForAccount(accountId, 2, {
          requireProxy: !skipProxy,
          skipProxy,
        });
      } catch {
        result = await this.createBrowserForAccount(accountId, 2, {
          requireProxy: false,
          skipProxy: true,
        });
      }
      browser = result.browser;
      const page = result.page;

      const loggedIn = await this.ensureLoggedIn(
        page, platform, accountId, account.username, password, extras
      );
      if (!loggedIn) throw new Error(`${platform} login failed`);

      await this.browseWarmFeed(page, platform);

      const out = {
        success: true,
        accountId,
        platform,
        handle: handle || null,
        browsed: true,
        follow: null,
        like: null,
      };

      if (doFollow && handle) {
        out.follow =
          platform === 'instagram'
            ? await this.instagramFollowUser(page, handle)
            : await this.tiktokFollowUser(page, handle);
      }

      if (doLike) {
        if (platform === 'instagram' && handle) {
          out.like = await this.instagramLikeOnProfile(page, handle);
        } else if (platform === 'tiktok') {
          out.like = await this.tiktokLikeOnFeed(page);
        }
      }

      await this.persistSession(page, platform, accountId);
      await pool.query(
        `UPDATE social_accounts
         SET warmup_status = 'warmed', warmed_up_at = COALESCE(warmed_up_at, NOW()),
             last_used_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [accountId]
      ).catch(() => {});

      return out;
    } finally {
      if (browser) await browser.close().catch(() => {});
      this._untrackBrowser(accountId);
    }
  }

  async getAccount(accountId) {
    const result = await pool.query(
      'SELECT id, username, email, credentials, platform, status, is_simulated FROM social_accounts WHERE id = $1',
      [accountId]
    );
    if (result.rows.length === 0) {
      throw new Error('Account not found');
    }
    return result.rows[0];
  }

  /**
   * List real (non-fake) accounts for a platform that have credentials.
   * Does not open browsers — used as a preflight for live mode.
   */
  async verifyAccounts(platform) {
    const result = await pool.query(
      `SELECT id, username, platform, status,
              EXISTS (
                SELECT 1 FROM social_account_proxies sap
                WHERE sap.social_account_id = social_accounts.id AND sap.is_active = true
              ) AS has_proxy
       FROM social_accounts
       WHERE platform = $1
         AND status = 'active'
         AND COALESCE(is_simulated, false) = false
         AND credentials IS NOT NULL
         AND COALESCE(credentials->>'password', '') != ''
         AND COALESCE(credentials->>'password', '') != 'default_password'`,
      [platform]
    );
    return result.rows;
  }

  async dismissInstagramOverlays(page) {
    for (const label of [
      'Allow all cookies',
      'Accept all',
      'Accept',
      'Only allow essential cookies',
      'Decline optional cookies',
      'Not Now',
      'Not now',
      'Dismiss',
    ]) {
      const clicked = await page.evaluate((label) => {
        const nodes = [...document.querySelectorAll('button, [role="button"]')];
        const match = nodes.find((b) => (b.innerText || '').trim() === label);
        if (match) {
          match.click();
          return true;
        }
        return false;
      }, label).catch(() => false);
      if (clicked) {
        console.log(`IG overlay dismissed: ${label}`);
        await this.humanLikeDelay(600, 1200);
      }
    }
  }

  async instagramLogin(page, username, password, extras = {}) {
    const loginIds = [username, extras.email].filter(Boolean);
    let lastHint = '';

    try {
      for (const loginId of loginIds) {
        console.log(`IG login attempt as ${loginId}`);
        // commit: Instagram often returns soft-block status codes through residential proxies
        await page.goto('https://www.instagram.com/accounts/login/', {
          waitUntil: 'commit',
          timeout: 90000,
        }).catch(async (err) => {
          console.warn(`IG login goto warning: ${err.message}`);
          await page.goto('https://www.instagram.com/', {
            waitUntil: 'domcontentloaded',
            timeout: 90000,
          }).catch(() => {});
        });
        await this.humanLikeDelay(3000, 5500);
        await this.dismissInstagramOverlays(page);

        // If we're on home marketing, click Log in
        const needsClick = await page.evaluate(() => {
          const hasInput = !!document.querySelector('input[name="username"], input[type="password"]');
          if (hasInput) return false;
          const text = (document.body?.innerText || '').slice(0, 2000);
          return /Log in|Sign up/i.test(text);
        });
        if (needsClick) {
          await page.evaluate(() => {
            const links = [...document.querySelectorAll('a, button')];
            const login = links.find((el) => /^(Log in|Log In)$/i.test((el.innerText || '').trim()));
            if (login) login.click();
          }).catch(() => {});
          await this.humanLikeDelay(2000, 3500);
          if (!page.url().includes('/accounts/login')) {
            await page.goto('https://www.instagram.com/accounts/login/', {
              waitUntil: 'domcontentloaded',
              timeout: 90000,
            }).catch(() => {});
            await this.humanLikeDelay(2000, 3500);
          }
          await this.dismissInstagramOverlays(page);
        }

        await this.simulateHumanBehavior(page);

        const userInput = await page.waitForSelector(
          [
            'input[name="username"]',
            'input[aria-label="Phone number, username, or email"]',
            'input[aria-label="Mobile number, username or email"]',
            'input[aria-label*="username" i]',
            'input[aria-label*="Mobile number" i]',
            'input[aria-label*="email" i]',
            'form input[type="text"]',
            'input[type="text"]',
          ].join(', '),
          { timeout: 30000, state: 'attached' }
        ).catch(() => null);
        if (!userInput) {
          const bodyHint = await page.evaluate(() => (document.body?.innerText || '').slice(0, 500)).catch(() => '');
          await page.screenshot({ path: `/tmp/ig-login-nouser-${username}.png`, fullPage: true }).catch(() => {});
          lastHint = `username_input_missing url=${page.url()} body=${bodyHint.replace(/\s+/g, ' ').slice(0, 180)}`;
          console.log(`IG no username input: ${lastHint}`);
          continue;
        }

        // Force visible interaction even if IG animates inputs
        await userInput.scrollIntoViewIfNeeded().catch(() => {});
        await userInput.click({ force: true });
        await userInput.fill('');
        await userInput.type(loginId, { delay: 35 });
        await this.humanLikeDelay(400, 900);

        const passInput = await page.waitForSelector(
          [
            'input[name="password"]',
            'input[aria-label="Password"]',
            'input[aria-label*="Password" i]',
            'input[type="password"]',
          ].join(', '),
          { timeout: 10000, state: 'attached' }
        );
        await passInput.click({ force: true });
        await passInput.fill('');
        await passInput.type(password, { delay: 35 });
        await this.humanLikeDelay(400, 900);

        const submitted = await page.evaluate(() => {
          const buttons = [...document.querySelectorAll('button, [role="button"]')];
          const match = buttons.find((b) => /^(Log in|Log In)$/i.test((b.innerText || '').trim()));
          if (match) {
            match.click();
            return 'Log in';
          }
          const submit = document.querySelector('button[type="submit"]');
          if (submit) {
            submit.click();
            return 'submit';
          }
          return null;
        });
        if (!submitted) await page.keyboard.press('Enter');
        await this.humanLikeDelay(4500, 7500);
        await this.dismissInstagramOverlays(page);

        // 2FA / email code challenges
        const challenge = await page.evaluate(() => {
          const text = (document.body?.innerText || '').slice(0, 3500);
          return {
            totp: /authentication app|security code|6-digit|Enter the code|two-factor|verification code/i.test(text),
            email: /email|sent a code|confirmation code/i.test(text) && /code/i.test(text),
            suspicious: /suspicious|confirm it.s you|we detected/i.test(text),
            wrong: /sorry, your password|incorrect|password was incorrect|user not found/i.test(text),
            snippet: text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 10).join(' | '),
          };
        }).catch(() => ({}));

        if (challenge.wrong) {
          lastHint = challenge.snippet || 'bad_credentials';
          console.log(`IG bad credentials for ${loginId}: ${lastHint}`);
          continue;
        }

        if ((challenge.totp || challenge.email || challenge.suspicious) && extras.totpSecret) {
          const code = generateTotp(extras.totpSecret);
          console.log(`IG challenge for ${loginId} — submitting TOTP`);
          const codeInput = await page.waitForSelector(
            'input[name="verificationCode"], input[name="security_code"], input[aria-label*="Security Code" i], input[aria-label*="Code" i], input[type="tel"], input[type="text"]',
            { timeout: 10000, state: 'visible' }
          ).catch(() => null);
          if (codeInput) {
            await codeInput.click({ force: true });
            await codeInput.fill('');
            await codeInput.type(code, { delay: 40 });
            await this.humanLikeDelay(400, 800);
            await page.evaluate(() => {
              const buttons = [...document.querySelectorAll('button, [role="button"]')];
              const match = buttons.find((b) => /^(Confirm|Continue|Next|Submit)$/i.test((b.innerText || '').trim()));
              if (match) match.click();
              else {
                const submit = document.querySelector('button[type="submit"]');
                if (submit) submit.click();
              }
            });
            await this.humanLikeDelay(4000, 7000);
            await this.dismissInstagramOverlays(page);
          }
        }

        // Save login / notifications prompts
        await this.dismissInstagramOverlays(page);
        await page.evaluate(() => {
          const buttons = [...document.querySelectorAll('button, [role="button"]')];
          const notNow = buttons.find((b) => /^(Not Now|Not now)$/i.test((b.innerText || '').trim()));
          if (notNow) notNow.click();
        }).catch(() => {});
        await this.humanLikeDelay(1000, 2000);

        const alive = await this.verifySessionAlive(page, 'instagram');
        if (alive) {
          console.log(`IG login success as ${loginId}`);
          return true;
        }

        // Sometimes still on challenge — check home URL
        const url = page.url();
        if (/instagram\.com\/?($|\?)/.test(url) && !/accounts\/login|challenge|onetap/i.test(url)) {
          const homeIcons = await page.$('svg[aria-label="Home"], a[href="/"]');
          if (homeIcons) return true;
        }

        lastHint = challenge.snippet || `url=${url}`;
        await page.screenshot({ path: `/tmp/ig-login-failed-${username}-${loginId.replace(/[^a-z0-9]/gi, '_')}.png`, fullPage: true }).catch(() => {});
        console.log(`IG login failed for ${loginId}. hint=${lastHint}`);
      }

      console.log(`IG login exhausted for ${username}. last=${lastHint}`);
      return false;
    } catch (error) {
      console.error('IG login error:', error);
      await page.screenshot({ path: `/tmp/ig-login-error-${username}.png`, fullPage: true }).catch(() => {});
      return false;
    }
  }

  /**
   * Smoke-test Instagram login (username, then email if provided).
   */
  async smokeTestInstagramLogin(accountId, { requireProxy = false } = {}) {
    let browser;
    let proxyId = null;
    try {
      const account = await this.getAccount(accountId);
      if (account.platform !== 'instagram') {
        throw new Error(`Account ${accountId} is ${account.platform}, expected instagram`);
      }
      const creds = typeof account.credentials === 'string'
        ? JSON.parse(account.credentials)
        : (account.credentials || {});
      const password = creds.password;
      if (!password || password === 'default_password') {
        throw new Error('Account has no real password');
      }

      const extras = {
        email: creds.email || account.email,
        totpSecret: creds.totp_secret || creds.totp || creds.twofa,
      };

      const tryOnce = async (withProxy) => {
        if (browser) {
          await browser.close().catch(() => {});
          this._untrackBrowser(accountId);
          browser = null;
        }
        if (withProxy) {
          if (requireProxy) await this.requireProxyForLive(accountId);
          const result = await this.createBrowserForAccount(accountId, 2, { requireProxy });
          browser = result.browser;
          proxyId = result.proxyConfig?._proxyId || null;
          const page = result.page;
          return this.ensureLoggedIn(page, 'instagram', accountId, account.username, password, extras);
        }
        const result = await this.createBrowser(null, false, await this.getOrCreateDeviceProfile(accountId, { forceDesktop: true }));
        browser = result.browser;
        proxyId = null;
        result.accountId = accountId;
        this._trackBrowser(accountId, result.browser);
        return this.ensureLoggedIn(result.page, 'instagram', accountId, account.username, password, extras);
      };

      let loggedIn = false;
      try {
        loggedIn = await tryOnce(true);
      } catch (err) {
        console.warn(`IG proxy login path failed (${err.message}); retrying direct`);
      }
      if (!loggedIn && !requireProxy) {
        loggedIn = await tryOnce(false);
      }

      if (loggedIn) {
        await pool.query(
          `UPDATE social_accounts
           SET warmup_status = 'warmed', warmed_up_at = NOW(), last_used_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [accountId]
        ).catch(() => {});
      }

      if (proxyId) {
        await proxyService.updateProxyStats(proxyId, !!loggedIn, {
          reason: loggedIn ? null : 'ig_login_failed',
        }).catch(() => {});
      }

      return {
        success: !!loggedIn,
        accountId,
        username: account.username,
        email: creds.email || account.email || null,
        usedProxy: !!proxyId,
      };
    } catch (error) {
      if (proxyId) {
        await proxyService.updateProxyStats(proxyId, false, { reason: error.message }).catch(() => {});
      }
      return { success: false, accountId, error: error.message };
    } finally {
      if (browser) await browser.close();
      this._untrackBrowser(accountId);
    }
  }

  /**
   * Smoke-test LinkedIn login (email + password + optional TOTP).
   */
  async smokeTestLinkedInLogin(accountId, { requireProxy = false } = {}) {
    let browser;
    let proxyId = null;
    try {
      const account = await this.getAccount(accountId);
      if (account.platform !== 'linkedin') {
        throw new Error(`Account ${accountId} is ${account.platform}, expected linkedin`);
      }
      const creds = typeof account.credentials === 'string'
        ? JSON.parse(account.credentials)
        : (account.credentials || {});
      const password = creds.password;
      if (!password || password === 'default_password') {
        throw new Error('Account has no real password');
      }

      const loginEmail = account.email || account.username;
      const extras = {
        totpSecret: creds.totp_secret || creds.totp || creds.twofa,
        emailPassword: creds.email_password,
        profileUrl: creds.profile_url,
      };

      const tryOnce = async (withProxy) => {
        if (browser) {
          await browser.close().catch(() => {});
          this._untrackBrowser(accountId);
          browser = null;
        }
        if (withProxy) {
          if (requireProxy) await this.requireProxyForLive(accountId);
          const result = await this.createBrowserForAccount(accountId, 2, { requireProxy });
          browser = result.browser;
          proxyId = result.proxyConfig?._proxyId || null;
          return this.ensureLoggedIn(result.page, 'linkedin', accountId, loginEmail, password, extras);
        }
        const result = await this.createBrowser(
          null,
          false,
          await this.getOrCreateDeviceProfile(accountId, { forceDesktop: true })
        );
        browser = result.browser;
        proxyId = null;
        result.accountId = accountId;
        this._trackBrowser(accountId, result.browser);
        return this.ensureLoggedIn(result.page, 'linkedin', accountId, loginEmail, password, extras);
      };

      let loggedIn = false;
      // LinkedIn frequently serves captcha on residential/mobile proxies for fresh logins.
      // Prefer direct first when proxy is optional; then retry via sticky proxy for session reuse.
      if (!requireProxy) {
        try {
          loggedIn = await tryOnce(false);
        } catch (err) {
          console.warn(`LinkedIn direct login path failed (${err.message}); retrying with proxy`);
        }
      }
      if (!loggedIn) {
        try {
          loggedIn = await tryOnce(true);
        } catch (err) {
          console.warn(`LinkedIn proxy login path failed (${err.message})`);
        }
      }

      if (loggedIn) {
        await pool.query(
          `UPDATE social_accounts
           SET warmup_status = 'warmed', warmed_up_at = NOW(), last_used_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [accountId]
        ).catch(() => {});
      }

      if (proxyId) {
        await proxyService.updateProxyStats(proxyId, !!loggedIn, {
          reason: loggedIn ? null : 'linkedin_login_failed',
        }).catch(() => {});
      }

      return {
        success: !!loggedIn,
        accountId,
        email: loginEmail,
        profileUrl: creds.profile_url || null,
        usedProxy: !!proxyId,
      };
    } catch (error) {
      if (proxyId) {
        await proxyService.updateProxyStats(proxyId, false, { reason: error.message }).catch(() => {});
      }
      return { success: false, accountId, error: error.message };
    } finally {
      if (browser) await browser.close();
      this._untrackBrowser(accountId);
    }
  }

  async requireProxyForLive(accountId) {
    if (process.env.REQUIRE_PROXY_FOR_LIVE === 'false') return true;
    const result = await pool.query(
      `SELECT 1 FROM social_account_proxies
       WHERE social_account_id = $1 AND is_active = true
       LIMIT 1`,
      [accountId]
    );
    if (!result.rows.length) {
      throw new Error(`Account ${accountId} has no active proxy — required for live posting`);
    }
    return true;
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

  _trackBrowser(accountId, browser) {
    this.activeBrowsers.set(accountId.toString(), browser);
  }

  _untrackBrowser(accountId) {
    this.activeBrowsers.delete(accountId.toString());
  }
}

module.exports = new PlaywrightService();
