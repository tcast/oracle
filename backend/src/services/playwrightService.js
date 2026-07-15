const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const pool = require('./db');
const proxyService = require('./proxyService');

chromium.use(stealth);

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
];

const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
  { width: 1280, height: 800 },
  { width: 1440, height: 960 },
];

const SCREEN_PROFILES = [
  { width: 1280, height: 720, availWidth: 1280, availHeight: 700, colorDepth: 24, pixelDepth: 24 },
  { width: 1366, height: 768, availWidth: 1366, availHeight: 748, colorDepth: 24, pixelDepth: 24 },
  { width: 1440, height: 900, availWidth: 1440, availHeight: 880, colorDepth: 24, pixelDepth: 24 },
  { width: 1536, height: 864, availWidth: 1536, availHeight: 844, colorDepth: 24, pixelDepth: 24 },
  { width: 1920, height: 1080, availWidth: 1920, availHeight: 1060, colorDepth: 24, pixelDepth: 24 },
];

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
    await page.evaluate(() => {
      const maxScroll = Math.max(document.body.scrollHeight - window.innerHeight, 100);
      window.scrollTo({
        top: Math.floor(Math.random() * maxScroll),
        behavior: 'smooth'
      });
    });
    await this.humanLikeDelay(400, 1200);
  }

  async randomMouseMove(page) {
    const vp = page.viewportSize();
    const toX = this.randomBetween(100, vp.width - 100);
    const toY = this.randomBetween(100, vp.height - 100);
    await page.mouse.move(toX, toY);
    await this.humanLikeDelay(100, 300);
  }

  async createBrowser(proxyConfig = null, retryWithoutProxy = true) {
    const userAgent = this.pickRandom(USER_AGENTS);
    const viewport = this.pickRandom(VIEWPORTS);
    const screen = this.pickRandom(SCREEN_PROFILES);
    const isWindows = userAgent.includes('Windows');
    const isMac = userAgent.includes('Macintosh');
    const timezone = this.pickRandom([
      'America/New_York', 'America/Chicago', 'America/Denver',
      'America/Los_Angeles', 'Europe/London', 'Europe/Berlin',
    ]);

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
        locale: 'en-US',
        timezoneId: timezone,
        permissions: [],
        colorScheme: 'light',
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
        geolocation: { latitude: 40.7128, longitude: -74.0060 },
      });

      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });

        Object.defineProperty(navigator, 'plugins', {
          get: () => [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
            { name: 'Native Client', filename: 'internal-nacl-plugin' },
          ],
        });

        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en'],
        });

        Object.defineProperty(navigator, 'hardwareConcurrency', {
          get: () => Math.floor(Math.random() * 4) + 4,
        });

        Object.defineProperty(navigator, 'deviceMemory', {
          get: () => Math.floor(Math.random() * 4) + 4,
        });

        Object.defineProperty(navigator, 'maxTouchPoints', {
          get: () => 0,
        });

        if (window.chrome && window.chrome.runtime) {
          Object.defineProperty(window.chrome, 'runtime', {
            get: () => ({ id: undefined }),
          });
        }

        const originalGetContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (...args) {
          const ctx = originalGetContext.apply(this, args);
          if (ctx && args[0] === '2d') {
            const originalFillText = ctx.fillText;
            ctx.fillText = function (...fillArgs) {
              const noise = () => Math.random() * 0.05;
              const imageData = ctx.getImageData(0, 0, this.width, this.height);
              for (let i = 0; i < imageData.data.length; i += 4) {
                imageData.data[i] += noise();
                imageData.data[i + 1] += noise();
                imageData.data[i + 2] += noise();
              }
              ctx.putImageData(imageData, 0, 0);
              return originalFillText.apply(this, fillArgs);
            };
          }
          return ctx;
        };

        const getParameter = WebGLRenderingContext.prototype.getParameter;
        if (getParameter) {
          WebGLRenderingContext.prototype.getParameter = function (param) {
            if (param === 37445) return 'Intel Inc.';
            if (param === 37446) return 'Intel Iris OpenGL Engine';
            return getParameter.apply(this, arguments);
          };
        }

        const sites = ['https://www.google.com/', 'https://www.youtube.com/', 'https://www.facebook.com/', 'https://www.amazon.com/'];
        const numVisited = Math.floor(Math.random() * 3) + 1;
        const visited = [];
        for (let i = 0; i < numVisited; i++) {
          visited.push(sites[Math.floor(Math.random() * sites.length)]);
        }
        Object.defineProperty(navigator, 'webdriver', { get: () => false });

        const blockWebRTC = () => {
          if (window.RTCPeerConnection) window.RTCPeerConnection = undefined;
          if (window.RTCSessionDescription) window.RTCSessionDescription = undefined;
          if (window.RTCIceCandidate) window.RTCIceCandidate = undefined;
          if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = undefined;
          if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = undefined;
        };
        blockWebRTC();
      });

      Object.defineProperty(context, '_userAgent', { value: userAgent });
      Object.defineProperty(context, '_viewport', { value: viewport });

      const page = await context.newPage();
      page.setDefaultTimeout(45000);

      await page.setViewportSize(viewport);

      try {
        if (typeof navigator !== 'undefined' && navigator.webdriver === undefined) {
          await page.evaluate(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
          });
        }
      } catch (_) {
        // navigator override already handled by addInitScript or stealth plugin
      }

      return { browser, context, page, proxyConfig };
    } catch (error) {
      if (proxyConfig && retryWithoutProxy) {
        console.warn('Browser launch failed with proxy, retrying without proxy:', error.message);
        return this.createBrowser(null, false);
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

        const result = await this.createBrowser(proxyConfig, false);
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
      const result = await this.createBrowser(null, false);
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
          await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
          await this.humanLikeDelay(500, 1000);
          const redditUser = await page.$(
            '[aria-label="User menu"], [aria-label="Expand user menu"], #USER_DROPDOWN_ID, button:has-text("Create")'
          );
          return !!redditUser;
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

      const loggedIn = await page.$(
        '[aria-label="User menu"], [aria-label="Expand user menu"], #USER_DROPDOWN_ID, button:has-text("Create"), faceplate-tracker[source="user_dropdown"]'
      );
      if (loggedIn) return true;

      const url = page.url();
      const stillOnLogin = url.includes('/login');
      if (!stillOnLogin) {
        const loginFields = await page.$('input[name="username"], input[name="password"]');
        if (!loginFields) return true;
      }

      const errText = await page.evaluate(() => {
        const el = document.querySelector('.AnimatedForm__errorMessage, [slot="error"], faceplate-banner');
        return el ? el.textContent?.trim() : '';
      }).catch(() => '');
      if (errText) console.error('Reddit login error message:', errText);
      await page.screenshot({ path: `/tmp/reddit-login-failed-${username}.png`, fullPage: true }).catch(() => {});
      console.log(`Reddit login failed for ${username}. final_url=${url}`);
      return false;
    } catch (error) {
      console.error('Reddit login error:', error);
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

      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
      await this.humanLikeDelay(1500, 3000);
      await this.simulateHumanBehavior(page);

      const commentBox = await page.$('div[role="textbox"][placeholder*="thoughts"], div[role="textbox"][placeholder*="comment"]');
      if (!commentBox) {
        await page.click('button:has-text("Comment")');
        await this.humanLikeDelay(1000, 2000);
      }

      await page.click('div[role="textbox"]');
      await this.humanLikeDelay(300, 700);
      await this.humanLikeTyping(page, 'div[role="textbox"]', comment);
      await this.humanLikeDelay(500, 1500);

      const submitBtn = await page.$('button:has-text("Comment")');
      if (submitBtn) {
        await submitBtn.click();
        await this.humanLikeDelay(2000, 4000);
        const url = page.url();
        const commentId = url.includes('/comment/')
          ? url.split('/comment/')[1]?.split('/')[0]
          : `rc_${Date.now()}`;
        return commentId || `rc_${Date.now()}`;
      }
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

      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
      await this.humanLikeDelay(1500, 3000);
      await this.simulateHumanBehavior(page);

      const replyBtn = await page.waitForSelector('[data-testid="reply"]', { timeout: 10000 });
      await replyBtn.click();
      await this.humanLikeDelay(1000, 2000);

      const textarea = await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 10000 });
      const tBox = await textarea.boundingBox();
      if (tBox) {
        await this.simulateMouseMovement(page, 0, 0, tBox.x + tBox.width / 2, tBox.y + tBox.height / 2);
      }

      await this.humanLikeTyping(page, '[data-testid="tweetTextarea_0"]', comment);
      await this.humanLikeDelay(500, 1500);

      const submitBtn = await page.waitForSelector('[data-testid="tweetButton"]', { timeout: 10000 });
      await submitBtn.click();
      await this.humanLikeDelay(2000, 4000);

      return true;
    } catch (error) {
      console.error('Error posting X comment:', error);
      return false;
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
      console.error('Error in postComment:', error);
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
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await this.humanLikeDelay(2000, 4000);
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
