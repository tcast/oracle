const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const pool = require('./db');
const proxyService = require('./proxyService');
const { buildStickyProfile } = require('./deviceProfiles');
const { classifyFailure } = require('./failureClassifier');

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
  async getOrCreateDeviceProfile(accountId, { preferMobile = false } = {}) {
    const existing = await pool.query(
      'SELECT device_profile FROM social_accounts WHERE id = $1',
      [accountId]
    );
    let profile = existing.rows[0]?.device_profile;
    if (typeof profile === 'string') {
      try { profile = JSON.parse(profile); } catch { profile = null; }
    }
    if (profile && profile.userAgent && profile.viewport) {
      return profile;
    }

    profile = buildStickyProfile({ preferMobile });
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

  async createBrowserForAccount(accountId, maxRetries = 2, { requireProxy = false } = {}) {
    let lastError;
    let attempt = 0;

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

        // Prefer Android fingerprints for mobile ProxyBase pools
        let preferMobile = false;
        try {
          const proxies = await proxyService.getAccountProxies(accountId, false);
          preferMobile = proxies.some((p) => proxyService.isMobileProxy(p));
        } catch (_) { /* ignore */ }

        const deviceProfile = await this.getOrCreateDeviceProfile(accountId, { preferMobile });
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
      const deviceProfile = await this.getOrCreateDeviceProfile(accountId, { preferMobile: false });
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
          await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 15000 });
          await this.humanLikeDelay(500, 1000);
          const xUser = await page.$('[data-testid="SideNav_AccountSwitcher_Button"]');
          return !!xUser;
        case 'linkedin':
          await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 15000 });
          await this.humanLikeDelay(500, 1000);
          const liUser = await page.$('[data-control-name="nav.settings"]');
          return !!liUser;
        default:
          return false;
      }
    } catch {
      return false;
    }
  }

  async performLogin(page, platform, username, password) {
    switch (platform) {
      case 'reddit': return this.redditLogin(page, username, password);
      case 'x': return this.xLogin(page, username, password);
      case 'linkedin': return this.linkedInLogin(page, username, password);
      default: throw new Error(`Unknown platform: ${platform}`);
    }
  }

  async ensureLoggedIn(page, platform, accountId, username, password) {
    const sessionRestored = await this.restoreSession(page, platform, accountId);
    if (sessionRestored) {
      const alive = await this.verifySessionAlive(page, platform);
      if (alive) {
        console.log(`Reused existing session for ${platform}/${username}`);
        return true;
      }
      console.log(`Session expired for ${platform}/${username}, re-logging in`);
    }

    const loginSuccess = await this.performLogin(page, platform, username, password);
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

  async xLogin(page, username, password) {
    try {
      // Landing page hosts the current username → Continue → password form
      await page.goto('https://x.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.humanLikeDelay(2500, 4500);

      for (const label of ['Accept all', 'Accept', 'Agree', 'Allow all']) {
        const btn = await page.$(`button:has-text("${label}"), div[role="button"]:has-text("${label}")`).catch(() => null);
        if (btn) {
          await btn.click().catch(() => {});
          await this.humanLikeDelay(500, 1200);
          break;
        }
      }

      await this.simulateHumanBehavior(page);

      const userSelector = [
        'input[name="username_or_email"]',
        'input[autocomplete="username"]',
        'input[name="text"]',
      ].join(', ');

      const userInput = await page.waitForSelector(userSelector, { timeout: 30000, state: 'visible' });
      if (!userInput) throw new Error('X username input not found');

      await userInput.click({ force: true });
      await userInput.fill('');
      await userInput.type(username, { delay: 40 });
      await this.humanLikeDelay(800, 1500);

      // Exact "Continue" only — never "Continue with phone/Google/Apple"
      const continueClicked = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button, [role="button"]')];
        const exact = buttons.find((b) => (b.innerText || '').trim() === 'Continue');
        if (exact) {
          exact.click();
          return true;
        }
        return false;
      });
      if (!continueClicked) await page.keyboard.press('Enter');
      await this.humanLikeDelay(2500, 4500);

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

      await passwordInput.focus().catch(() => {});
      await passwordInput.click({ force: true }).catch(() => {});
      await passwordInput.fill('');
      await passwordInput.type(password, { delay: 40 });
      await this.humanLikeDelay(500, 1500);

      const loginClicked = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button, [role="button"]')];
        for (const label of ['Log in', 'Sign in', 'Continue']) {
          const match = buttons.find((b) => (b.innerText || '').trim() === label);
          if (match) {
            match.click();
            return label;
          }
        }
        const submit = document.querySelector('button[type="submit"]');
        if (submit) {
          submit.click();
          return 'submit';
        }
        return null;
      });
      if (!loginClicked) await page.keyboard.press('Enter');
      await this.humanLikeDelay(5000, 8000);

      const loggedIn = await page.$('[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Home_Link"], a[href="/home"]');
      if (loggedIn) return true;

      const url = page.url();
      if (
        url.includes('/home') ||
        url.includes('/notifications') ||
        (url.includes('x.com') && !url.includes('login') && !url.includes('flow') && !url.includes('onboarding') && !url.includes('signup'))
      ) {
        return true;
      }

      await page.screenshot({ path: `/tmp/x-login-failed-${username}.png`, fullPage: true }).catch(() => {});
      console.log(`X login failed for ${username}. final_url=${url}`);
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

  async linkedInLogin(page, email, password) {
    try {
      await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
      await this.humanLikeDelay(2000, 4000);
      await this.simulateHumanBehavior(page);

      const emailInput = await page.waitForSelector('#username', { timeout: 15000 });
      const eBox = await emailInput.boundingBox();
      if (eBox) {
        await this.simulateMouseMovement(page, 0, 0, eBox.x + eBox.width / 2, eBox.y + eBox.height / 2);
      }

      await this.humanLikeTyping(page, '#username', email);
      await this.humanLikeDelay(400, 1000);

      const pwdInput = await page.waitForSelector('#password', { timeout: 5000 });
      const pBox = await pwdInput.boundingBox();
      if (pBox) {
        await this.simulateMouseMovement(page, eBox.x + eBox.width / 2, eBox.y + eBox.height / 2, pBox.x + pBox.width / 2, pBox.y + pBox.height / 2);
      }

      await this.humanLikeTyping(page, '#password', password);
      await this.humanLikeDelay(300, 800);

      await page.click('button[type="submit"]');
      await this.humanLikeDelay(3000, 5000);

      const challenge = await page.$('#captcha-internal, input[name="pin"], .challenge-dialog');
      if (challenge) {
        console.log('LinkedIn login challenge detected - screenshot captured');
        await page.screenshot({ path: '/tmp/linkedin-challenge.png' }).catch(() => {});
        return false;
      }

      const loggedIn = await page.$('[data-control-name="nav.settings"], .feed-identity-module');
      return !!loggedIn;
    } catch (error) {
      console.error('LinkedIn login error:', error);
      return false;
    }
  }

  async createLinkedInPost(accountId, content, mediaPath = null) {
    let browser, context, page, proxyId;
    let operationSuccess = false;

    try {
      const account = await this.getAccount(accountId);
      const result = await this.createBrowserForAccount(accountId);
      browser = result.browser;
      context = result.context;
      page = result.page;
      proxyId = result.proxyConfig?._proxyId;

      const loggedIn = await this.ensureLoggedIn(page, 'linkedin', accountId, account.username, account.credentials.password);
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

  /** Lightweight warm-up: browse home + a subreddit without posting. */
  async warmUpAccount(accountId, platform = 'reddit') {
    let browser;
    try {
      const account = await this.getAccount(accountId);
      const result = await this.createBrowserForAccount(accountId);
      browser = result.browser;
      const page = result.page;

      const loggedIn = await this.ensureLoggedIn(
        page, platform, accountId, account.username, account.credentials.password
      );
      if (!loggedIn) throw new Error('Warm-up login failed');

      if (platform === 'reddit') {
        await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded' });
        await this.humanLikeDelay(2000, 4000);
        await this.simulateHumanBehavior(page);
        await page.goto('https://www.reddit.com/r/popular/', { waitUntil: 'domcontentloaded' });
        await this.humanLikeDelay(2000, 5000);
        await this.simulateHumanBehavior(page);
      }

      await this.persistSession(page, platform, accountId);
      await pool.query(
        `UPDATE social_accounts
         SET warmup_status = 'warmed', warmed_up_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [accountId]
      );
      return { success: true, accountId, warmup_status: 'warmed' };
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

  async getAccount(accountId) {
    const result = await pool.query(
      'SELECT id, username, credentials, platform, status, is_simulated FROM social_accounts WHERE id = $1',
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
