const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const pool = require('./db');
const proxyService = require('./proxyService');
const { buildStickyProfile } = require('./deviceProfiles');
const { classifyFailure } = require('./failureClassifier');
const { generateTotp, totpSecondsRemaining } = require('../utils/totp');

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

    // Reassign if missing, or if we must force desktop but currently have mobile.
    // Exception: cookie imports that pinned an export UA (sticky_import_ua) —
    // flipping Android→desktop mid-session is worse than a stable mobile spoof.
    const stickyImportUa = !!(profile && profile.sticky_import_ua);
    const needsReassign =
      !profile ||
      !profile.userAgent ||
      !profile.viewport ||
      (forceDesktop && profile.platform === 'android' && !stickyImportUa);

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
    // Camoufox/Firefox contexts can report a null viewport; fall back to a sane size.
    const vp = page.viewportSize() || { width: 1280, height: 800 };
    const toX = this.randomBetween(100, Math.max(200, vp.width - 100));
    const toY = this.randomBetween(100, Math.max(200, vp.height - 100));
    await page.mouse.move(toX, toY);
    await this.humanLikeDelay(100, 300);
  }

  async createBrowser(proxyConfig = null, retryWithoutProxy = true, deviceProfile = null) {
    // Alternate anti-detect engine (Camoufox / Firefox). Additive and opt-in:
    // default stays Chromium so the organic Reddit stack is never affected.
    if ((process.env.BROWSER_ENGINE || 'chromium').toLowerCase() === 'camoufox') {
      try {
        return await this.createCamoufoxBrowser(proxyConfig, deviceProfile);
      } catch (error) {
        if (proxyConfig && retryWithoutProxy) {
          console.warn('Camoufox launch failed with proxy, retrying without proxy:', error.message);
          return this.createCamoufoxBrowser(null, deviceProfile);
        }
        throw error;
      }
    }

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
        userAgent,
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

        // Alpine/system Chromium often ignores context userAgent; pin it explicitly.
        if (fp.userAgent) {
          try {
            Object.defineProperty(navigator, 'userAgent', { get: () => fp.userAgent });
            Object.defineProperty(navigator, 'appVersion', {
              get: () => fp.userAgent.replace(/^Mozilla\//, ''),
            });
          } catch (_) { /* ignore */ }
        }

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

  /**
   * Alternate launch path: Camoufox (anti-detect Firefox fork).
   *
   * Returns the same `{ browser, context, page, proxyConfig, deviceProfile }`
   * shape as createBrowser(), so every downstream flow (xLogin, persistSession,
   * verifySessionAlive, etc.) works unchanged on the Playwright Page it yields.
   *
   * Camoufox spoofs the fingerprint at the C++ engine level (not JS injection),
   * so we deliberately do NOT stack our Chromium initScript hacks on top. With
   * `geoip` enabled it derives locale / timezone / WebRTC / geolocation from the
   * proxy exit IP, which gives the per-account fingerprint consistency we want.
   *
   * camoufox-js is ESM-only and needs Node >= 20 + a glibc host with the Camoufox
   * binary fetched (`npx camoufox-js fetch`). It will not run in the Alpine/Node18
   * production image; that is intentional — this path is opt-in via BROWSER_ENGINE.
   */
  async createCamoufoxBrowser(proxyConfig = null, deviceProfile = null) {
    const profile = deviceProfile || buildStickyProfile({ preferMobile: false, forceDesktop: true });
    const { launchOptions } = await import('camoufox-js');
    const { firefox } = require('playwright');

    const userAgent = profile.userAgent || '';
    const isMac = /Macintosh|Mac OS X/i.test(userAgent);
    const isWin = /Windows/i.test(userAgent);
    const os = isMac ? 'macos' : isWin ? 'windows' : 'linux';
    const viewport = profile.viewport || { width: 1280, height: 800 };

    let proxy;
    if (proxyConfig) {
      const { _proxyId, ...clean } = proxyConfig;
      proxy = clean;
    }

    // geoip needs a proxy to resolve against; without one we fall back to the
    // account's sticky locale/timezone so the fingerprint still stays coherent.
    const cfOptions = {
      os,
      headless: process.env.PLAYWRIGHT_HEADLESS === 'false' ? false : true,
      humanize: true,
      block_webrtc: true,
      geoip: proxy ? true : false,
      window: [viewport.width, viewport.height],
    };
    if (proxy) cfOptions.proxy = proxy;
    if (!proxy) {
      cfOptions.locale = profile.locale || 'en-US';
    }

    const opts = await launchOptions(cfOptions);
    // Headless Firefox has no GPU; force software WebGL/WebRender so X's client
    // bundle can create a GL context (otherwise its login flow errors out with
    // "Something went wrong"). Camoufox still spoofs the reported vendor/renderer.
    opts.firefoxUserPrefs = {
      ...(opts.firefoxUserPrefs || {}),
      'webgl.force-enabled': true,
      'webgl.disabled': false,
      'gfx.webrender.software': true,
      'gfx.webrender.all': true,
      'gfx.canvas.accelerated': true,
    };
    const browser = await firefox.launch(opts);

    const contextOptions = { viewport };
    if (!proxy) {
      contextOptions.timezoneId = profile.timezoneId || 'America/New_York';
    }
    const context = await browser.newContext(contextOptions);

    const page = await context.newPage();
    page.setDefaultTimeout(45000);

    let realUa = userAgent;
    try {
      realUa = await page.evaluate(() => navigator.userAgent);
    } catch (_) { /* keep profile UA */ }

    Object.defineProperty(context, '_userAgent', { value: realUa });
    Object.defineProperty(context, '_viewport', { value: viewport });
    Object.defineProperty(context, '_deviceProfile', { value: profile });

    console.log(`Camoufox browser launched (os=${os}, proxy=${proxy ? proxy.server : 'none'}, geoip=${cfOptions.geoip})`);
    return { browser, context, page, proxyConfig, deviceProfile: profile };
  }

  async createBrowserForAccount(accountId, maxRetries = 2, {
    requireProxy = false,
    skipProxy = false,
    forceDesktop: forceDesktopOpt = false,
    proxyOverride = null,
    preferProvider = null,
  } = {}) {
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
        let proxyConfig = proxyOverride || null;
        if (!proxyConfig && preferProvider) {
          const preferred = await proxyService.pickHealthyProxyByProvider(preferProvider);
          if (preferred) {
            proxyConfig = proxyService.formatProxyConfig(preferred);
            console.log(
              `Using preferred ${preferProvider} proxy ${preferred.id} for account ${accountId}`
            );
          }
        }
        if (!proxyConfig) {
          proxyConfig = await proxyService.getNextProxyForAccount(accountId);
        }

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
        // Cookie imports with sticky_import_ua keep their export fingerprint.
        let preferMobile = false;
        let forceDesktop = !!forceDesktopOpt;
        try {
          const account = await this.getAccount(accountId);
          let dp = account.device_profile;
          if (typeof dp === 'string') {
            try { dp = JSON.parse(dp); } catch { dp = null; }
          }
          const stickyImportUa = !!(dp && dp.sticky_import_ua);
          if (!stickyImportUa) {
            forceDesktop =
              forceDesktop ||
              account.platform === 'x' ||
              account.platform === 'instagram' ||
              account.platform === 'linkedin' ||
              account.platform === 'tiktok';
          } else {
            forceDesktop = false;
            preferMobile = dp.platform === 'android';
          }
          if (!forceDesktop && !stickyImportUa) {
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
          await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 45000 });
          // Account switcher paints after the shell; short waits false-negative live cookies.
          await page
            .waitForSelector(
              '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="UserAvatar-Container-unknown"], [data-testid^="UserAvatar-Container-"]',
              { timeout: 20000 }
            )
            .catch(() => null);
          await this.humanLikeDelay(1500, 2500);
          const xBanText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 4000)).catch(() => '');
          if (/Account suspended|Your account is suspended|is not permitted to perform this action/i.test(xBanText)) {
            throw new Error('account_suspended: Your account is suspended and is not permitted to perform this action');
          }
          if (/This account doesn.?t exist/i.test(xBanText)) {
            throw new Error('account_does_not_exist: This account doesn\'t exist');
          }
          const xUser = await page.$(
            '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Home_Link"], [data-testid="BottomBar_Home_Link"], a[href="/home"]'
          );
          if (xUser) return true;
          return await page.evaluate(() => {
            const text = (document.body?.innerText || '').slice(0, 3000);
            if (/Sign in|Create account|Already have an account/i.test(text) && !/Home|Notifications|Messages/i.test(text)) {
              return false;
            }
            if (document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')) return true;
            if (document.querySelector('[data-testid^="UserAvatar-Container-"]')) return true;
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
    } catch (error) {
      // Network/proxy failures must not be treated as dead sessions.
      const msg = error?.message || String(error);
      if (
        /ERR_TUNNEL|ERR_TIMED_OUT|ERR_PROXY|ERR_CONNECTION|net::ERR_|Timeout/i.test(msg) ||
        /account_suspended|account_does_not_exist/i.test(msg)
      ) {
        throw error;
      }
      return false;
    }
  }

  async performLogin(page, platform, username, password, extras = {}) {
    switch (platform) {
      case 'reddit': return this.redditLogin(page, username, password);
      case 'x': return this.xLogin(page, username, password, extras);
      case 'linkedin': return this.linkedInLogin(page, username, password, extras);
      case 'instagram': return this.instagramLogin(page, username, password, extras);
      case 'tiktok': return this.tiktokLogin(page, username, password, extras);
      default: throw new Error(`Unknown platform: ${platform}`);
    }
  }

  async ensureLoggedIn(page, platform, accountId, username, password, extras = {}) {
    const allowLogin = extras.allowLogin !== false;
    const sessionRestored = await this.restoreSession(page, platform, accountId);
    if (sessionRestored) {
      const alive = await this.verifySessionAlive(page, platform);
      if (alive) {
        console.log(`Reused existing session for ${platform}/${username}`);
        return true;
      }
      console.log(`Session expired for ${platform}/${username}${allowLogin ? ', re-logging in' : ' — login disabled'}`);
      // Dead marketplace cookies (e.g. AccsMarket MsaArtifacts) poison password login if left in context.
      await page.context().clearCookies().catch(() => {});
    }

    if (!allowLogin) {
      throw new Error(`no_live_session for ${platform}/${username} — refusing password login`);
    }

    // Cookie-only accounts carry no password. Never attempt (and never "burn") a
    // password login when there's nothing to submit — the cookies are the credential.
    if (!password || !String(password).trim()) {
      throw new Error(`no_live_session for ${platform}/${username} — cookie-only account, no password to log in with`);
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

  /**
   * Type into an already-focused element with human-ish cadence (not fill()).
   */
  async humanTypeInto(el, text, { clear = true, confirm = false } = {}) {
    if (!el) return false;
    await el.click({ clickCount: clear ? 3 : 1 }).catch(() => {});
    await this.humanLikeDelay(200, 500);
    if (clear) {
      await el.fill('').catch(() => {});
      await this.humanLikeDelay(150, 350);
    }
    const value = String(text || '');
    for (let i = 0; i < value.length; i++) {
      await el.type(value[i], { delay: 0 }).catch(async () => {
        await el.press(value[i]).catch(() => {});
      });
      // Occasional longer pause mid-word / between words
      const ch = value[i];
      if (ch === ' ' || ch === '.' || ch === ',') {
        await this.humanLikeDelay(120, 380);
      } else if (Math.random() < 0.08) {
        await this.humanLikeDelay(180, 450);
      } else {
        await this.humanLikeDelay(35, 110);
      }
    }
    await this.humanLikeDelay(400, 900);
    if (!confirm) return true;
    const got = await el
      .inputValue()
      .catch(async () =>
        el.evaluate((n) => n.value || n.textContent || '').catch(() => '')
      );
    return (
      String(got || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase() ===
      value.replace(/\s+/g, ' ').trim().toLowerCase()
    );
  }

  /**
   * Look like a real X session before any profile edit:
   * home feed → scroll → pause → maybe open/close a tweet → wander.
   * Callers must still check suspension after this returns.
   */
  async humanBrowseXSession(page, { accountId } = {}) {
    const tag = accountId ? `#${accountId}` : '';
    console.log(`X ${tag}: human browse — landing on home feed`);

    const url = page.url() || '';
    const onHome = /(?:x|twitter)\.com\/home/i.test(url);
    if (!onHome) {
      const home =
        (await page.$('[data-testid="AppTabBar_Home_Link"], a[href="/home"]')) ||
        (await page.locator('a[aria-label="Home"]').first().elementHandle().catch(() => null));
      if (home && /(?:x|twitter)\.com/i.test(url)) {
        await this.randomMouseMove(page);
        await home.click().catch(() => {});
        await this.humanLikeDelay(2000, 3500);
      } else {
        await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
      }
    }

    await page
      .waitForSelector(
        '[data-testid="primaryColumn"], [aria-label="Home timeline"], [data-testid="tweet"]',
        { timeout: 25000 }
      )
      .catch(() => null);
    await this.humanLikeDelay(2000, 4000);
    await this.randomMouseMove(page);
    await this.humanLikeDelay(800, 1600);

    // Scroll feed like reading
    const scrolls = this.randomBetween(2, 4);
    for (let i = 0; i < scrolls; i++) {
      await this.randomScroll(page);
      await this.randomMouseMove(page);
      await this.humanLikeDelay(1200, 2800);
    }

    // Maybe open a tweet in the timeline, read, go back
    if (Math.random() < 0.7) {
      const tweet = await page
        .locator('article[data-testid="tweet"]')
        .nth(this.randomBetween(0, 2))
        .elementHandle()
        .catch(() => null);
      if (tweet) {
        console.log(`X ${tag}: opening a tweet casually`);
        await this.randomMouseMove(page);
        await tweet.click().catch(() => {});
        await this.humanLikeDelay(2500, 5000);
        await this.randomScroll(page);
        await this.humanLikeDelay(1500, 3000);
        const back =
          (await page.$('[data-testid="app-bar-back"], [aria-label="Back"]')) ||
          (await page.locator('button[aria-label="Back"]').first().elementHandle().catch(() => null));
        if (back) {
          await back.click().catch(() => {});
        } else {
          await page.goBack().catch(() => {});
        }
        await this.humanLikeDelay(1500, 3000);
        await page
          .waitForSelector('[data-testid="primaryColumn"], [aria-label="Home timeline"]', {
            timeout: 15000,
          })
          .catch(() => null);
      }
    }

    // One more idle wander on feed
    await this.simulateHumanBehavior(page);
    await this.humanLikeDelay(1500, 3500);
    // Tweet open/goBack or tunnel flaps can leave about:blank — recover before callers.
    if (!/x\.com|twitter\.com/i.test(page.url() || '')) {
      console.warn(`X ${tag}: browse left blank — recovering to home`);
      await page
        .goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 })
        .catch(() => {});
      await this.humanLikeDelay(1500, 2500);
    }
    console.log(`X ${tag}: human browse done (url=${page.url()})`);
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

  async xLogin(page, username, password, extras = {}) {
    try {
      // Prefer the dedicated login flow — mobile landing only shows "Sign in"
      let navigated = false;
      for (let navAttempt = 0; navAttempt < 3 && !navigated; navAttempt++) {
        try {
          await page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded', timeout: 90000 });
          if (/chrome-error:|chromewebdata/i.test(page.url())) {
            throw new Error(`chrome-error navigation (${page.url()})`);
          }
          navigated = true;
        } catch (navErr) {
          const msg = navErr.message || String(navErr);
          console.warn(`X login navigation attempt ${navAttempt + 1} failed: ${msg}`);
          if (navAttempt >= 2) throw navErr;
          await this.humanLikeDelay(2000, 4000);
        }
      }
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
        const buttons = [...document.querySelectorAll('button, [role="button"], div[role="button"]')];
        for (const label of ['Log in', 'Sign in', 'Log In']) {
          const match = buttons.find((b) => {
            const t = (b.innerText || b.getAttribute('aria-label') || '').trim();
            return t === label || new RegExp(`^${label}$`, 'i').test(t);
          });
          if (match) {
            match.click();
            return (match.innerText || label).trim();
          }
        }
        const byTest = document.querySelector(
          '[data-testid="LoginForm_Login_Button"], [data-testid="LoginForm_Login_Button"] span, button[data-testid*="Login"]'
        );
        if (byTest) {
          const el = byTest.closest('button, [role="button"]') || byTest;
          el.click();
          return 'LoginForm_Login_Button';
        }
        // jf/onboarding: primary blue button next to password often has no exact text match
        const submit = document.querySelector(
          'form button[type="submit"], button[type="submit"], [data-testid="ocfEnterTextNextButton"]'
        );
        if (submit) {
          const t = (submit.innerText || submit.getAttribute('aria-label') || '').trim();
          if (!/continue with|google|apple|phone|sign up/i.test(t)) {
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

      // 2FA / authenticator challenge (common on AccsMarket accounts with totp_secret)
      const totpHandled = await this.handleXTotpChallenge(page, username, extras);
      if (totpHandled === 'rate_limited') {
        throw new Error('X temporarily limited login — try again later');
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
      // Re-throw rate-limits / classified failures so callers quarantine correctly
      // instead of collapsing everything into generic "X login failed".
      if (/temporarily limited|try again later|rate.?limit|bad_credentials/i.test(error.message || '')) {
        throw error;
      }
      return false;
    }
  }

  /**
   * Submit authenticator TOTP when X shows a 2FA / verification-code step.
   * Generates a fresh 6-digit code from the base32 secret (same as an authenticator app).
   * Returns true if a code was submitted, false if no challenge, 'rate_limited' if limited.
   */
  async handleXTotpChallenge(page, username, extras = {}) {
    const readChallenge = async () =>
      page
        .evaluate(() => {
          const text = (document.body?.innerText || '').slice(0, 4000);
          const hasCodeInput = !!(
            document.querySelector(
              'input[data-testid="ocfEnterTextTextInput"], input[name="text"], input[autocomplete="one-time-code"], input[inputmode="numeric"]'
            )
          );
          const authenticator =
            /authenticator|authentication app|authentication code|Check your.{0,20}app|generated by your/i.test(
              text
            );
          const emailCode =
            /sent (you )?(a )?code|check your email|email you a code|confirmation code.*email|code we (emailed|sent)/i.test(
              text
            );
          const genericCode =
            /verification code|Enter (the )?code|confirmation code|two.?factor|2fa|6.?digit/i.test(text);
          return {
            // Prefer authenticator; allow generic code UI unless it clearly asks for email.
            totp: hasCodeInput && (authenticator || (genericCode && !emailCode)),
            emailOnly: hasCodeInput && emailCode && !authenticator,
            rateLimited: /temporarily limited your login|try again later/i.test(text),
            snippet: text
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .slice(0, 12)
              .join(' | '),
          };
        })
        .catch(() => ({}));

    // Wait for post-password UI to settle into a 2FA challenge (or clear rate-limit).
    let challenge = await readChallenge();
    for (let i = 0; i < 8 && !challenge.totp && !challenge.emailOnly && !challenge.rateLimited; i++) {
      await this.humanLikeDelay(1200, 2000);
      challenge = await readChallenge();
    }

    if (challenge.rateLimited) return 'rate_limited';
    if (challenge.emailOnly) {
      console.log(`X email-code challenge for ${username} (not authenticator): ${challenge.snippet}`);
      await page.screenshot({ path: `/tmp/x-login-2fa-email-${username}.png`, fullPage: true }).catch(() => {});
      return false;
    }
    if (!challenge.totp) return false;

    if (!extras.totpSecret) {
      console.log(`X 2FA challenge for ${username} but no totpSecret: ${challenge.snippet}`);
      await page.screenshot({ path: `/tmp/x-login-2fa-missing-${username}.png`, fullPage: true }).catch(() => {});
      return false;
    }

    const codeSelectors = [
      'input[data-testid="ocfEnterTextTextInput"]',
      'input[autocomplete="one-time-code"]',
      'input[inputmode="numeric"]',
      'input[name="text"]',
      'input[type="tel"]',
      'input[type="text"]',
    ].join(', ');

    const submitTotpOnce = async () => {
      // Mint the code immediately before typing; if the window is about to roll, wait.
      const left = totpSecondsRemaining();
      if (left < 4) {
        console.log(`X 2FA for ${username} — waiting ${left + 1}s for next TOTP window`);
        await this.humanLikeDelay((left + 1) * 1000, (left + 2) * 1000);
      }
      const code = generateTotp(extras.totpSecret);
      if (!/^\d{6}$/.test(code)) throw new Error('TOTP generator returned non-6-digit code');
      console.log(`X 2FA for ${username} — submitting current authenticator code (${left < 4 ? 'fresh window' : `${totpSecondsRemaining()}s left`})`);

      let codeInput = await page
        .waitForSelector(codeSelectors, { timeout: 12000, state: 'visible' })
        .catch(() => null);
      if (!codeInput) {
        console.log(`X 2FA input missing for ${username}`);
        await page.screenshot({ path: `/tmp/x-login-2fa-noinput-${username}.png`, fullPage: true }).catch(() => {});
        return { ok: false };
      }

      await codeInput.click({ force: true }).catch(() => {});
      await codeInput.fill('');
      await codeInput.type(code, { delay: 40 });
      await this.humanLikeDelay(400, 800);

      const nextClicked = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button, [role="button"]')];
        for (const label of ['Next', 'Verify', 'Confirm', 'Continue', 'Submit', 'Log in', 'Sign in']) {
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
      if (!nextClicked) await page.keyboard.press('Enter');
      else console.log(`X 2FA: clicked ${nextClicked}`);

      await this.humanLikeDelay(4000, 7000);
      await this.dismissXConsent(page);

      const after = await page
        .evaluate(() => {
          const text = (document.body?.innerText || '').slice(0, 2500);
          return {
            rateLimited: /temporarily limited your login|try again later/i.test(text),
            wrongCode: /incorrect.?code|wrong.?code|invalid.?code|that code wasn.?t right/i.test(text),
            hasHome: !!document.querySelector(
              '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Home_Link"], [aria-label="Home timeline"]'
            ),
            stillChallenge: !!(
              document.querySelector(
                'input[data-testid="ocfEnterTextTextInput"], input[autocomplete="one-time-code"], input[inputmode="numeric"]'
              ) && /verification code|authenticator|Enter (the )?code|6.?digit/i.test(text)
            ),
            snippet: text
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .slice(0, 10)
              .join(' | '),
          };
        })
        .catch(() => ({}));
      console.log(`X 2FA post-submit for ${username}:`, JSON.stringify(after));
      return { ok: true, after };
    };

    let result = await submitTotpOnce();
    if (!result.ok) return false;
    if (result.after?.rateLimited) return 'rate_limited';

    // One retry with a freshly minted code if X rejected the first.
    if (result.after?.wrongCode || (result.after?.stillChallenge && !result.after?.hasHome)) {
      console.log(`X 2FA for ${username} — retrying with a fresh code`);
      result = await submitTotpOnce();
      if (!result.ok) return false;
      if (result.after?.rateLimited) return 'rate_limited';
    }

    await page.screenshot({ path: `/tmp/x-login-2fa-post-${username}.png`, fullPage: true }).catch(() => {});
    return true;
  }

  /** Test login for one account; persists session on success. */
  async testAccountLogin(accountId, { requireProxy = false } = {}) {
    let browser;
    try {
      const account = await this.getAccount(accountId);
      const password = account.credentials?.password;
      if (!password || password === 'default_password') {
        throw new Error('Account has no real password');
      }

      const creds = account.credentials || {};
      const extras = {
        totpSecret: creds.totp_secret || creds.totp || creds.twofa,
      };

      if (requireProxy) await this.requireProxyForLive(accountId);
      const result = await this.createBrowserForAccount(accountId, 2, { requireProxy });
      browser = result.browser;
      const page = result.page;

      const loggedIn = await this.ensureLoggedIn(
        page,
        account.platform,
        accountId,
        account.username,
        password,
        extras
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

      const loggedIn = await this.ensureLoggedIn(page, 'x', accountId, account.username, account.credentials.password, {
        totpSecret: account.credentials?.totp_secret || account.credentials?.totp || account.credentials?.twofa,
      });
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

      return `x-${Date.now()}`;
    } catch (error) {
      console.error('Error posting X comment:', error);
      // Preserve transient teardown so organic can soft-skip instead of
      // masking as "no platform comment id" → multi-hour quarantine.
      if (/has been closed|Target closed|browser.*closed/i.test(error?.message || '')) {
        throw error;
      }
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
  async followXUser(accountId, targetUsername, { requireProxy = true, allowLogin = false } = {}) {
    const account = await this.getAccount(accountId);
    if (account.platform !== 'x') {
      throw new Error(`Account ${accountId} is ${account.platform}, expected x`);
    }
    const password = account.credentials?.password;
    // Cookie-only default: allowLogin=false never password-submits.
    // Only require a real password when allowLogin is explicitly true.
    if (allowLogin && (!password || password === 'default_password')) {
      throw new Error('Account has no real password');
    }

    // Prefer proxy; only fall back to direct for proxy/network failures.
    // Follows default allowLogin=false — dead sessions must not password-submit.
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

        const loggedIn = await this.ensureLoggedIn(page, 'x', accountId, account.username, password, {
          allowLogin,
          totpSecret: account.credentials?.totp_secret || account.credentials?.totp || account.credentials?.twofa,
        });
        if (!loggedIn) {
          await page.screenshot({ path: `/tmp/x-follow-login-${account.username}.png`, fullPage: true }).catch(() => {});
          throw new Error(allowLogin ? 'X login failed' : 'X session not alive (cookie-only)');
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
        // Only fall back to direct for proxy/network failures.
        // Rate-limits and auth failures must not double-hit login.
        const rateLimited = /temporarily limited|try again later|rate.?limit/i.test(msg);
        const canRetryDirect =
          !mode.skipProxy &&
          !rateLimited &&
          /proxy|err_tunnel|err_timed_out|err_proxy|tunnel_connection|net::err_/i.test(msg);
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

      const creds = account.credentials || {};
      const loggedIn = await this.ensureLoggedIn(page, 'x', accountId, account.username, password, {
        totpSecret: creds.totp_secret || creds.totp || creds.twofa,
      });
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

  /**
   * Solve LinkedIn's "quick security check" reCAPTCHA on the login checkpoint.
   * Reuses the shared captcha pipeline (2Captcha → CapSolver, v2/enterprise) and
   * injects the token / fires the grecaptcha callback so the challenge advances.
   * Returns true when a token was applied (caller re-checks the resulting state).
   */
  async solveLinkedInCheckpoint(page, loginId, extras = {}) {
    const captchaSolverService = require('./captchaSolverService');

    // LinkedIn embeds reCAPTCHA Enterprise inside a same-origin `captchaInternal`
    // iframe; the g-recaptcha-response + grecaptcha callback live in THAT frame.
    // Wait for it (and the nested Google anchor) to load.
    let captchaFrame = null;
    let siteKey = null;
    let enterprise = true;
    for (let i = 0; i < 8 && !siteKey; i++) {
      for (const f of page.frames()) {
        const fu = f.url() || '';
        if (/captchaInternal/i.test(fu)) captchaFrame = f;
        const m = fu.match(/recaptcha\/(enterprise|api2)\/(?:anchor|bframe).*?[?&]k=([^&]+)/i);
        if (m) {
          siteKey = decodeURIComponent(m[2]);
          enterprise = /enterprise/i.test(m[1]);
        }
      }
      if (!siteKey) await this.humanLikeDelay(1200, 1800);
    }
    if (!captchaFrame) {
      console.log(`LinkedIn checkpoint: captchaInternal frame not found for ${loginId}`);
      return false;
    }
    if (!siteKey) {
      // Known LinkedIn checkpoint reCAPTCHA Enterprise site key (fallback).
      siteKey = '6Lc7CQMTAAAAAIL84V_tPRYEWZtljsJQJZ5jSijw';
      enterprise = true;
      console.log(`LinkedIn checkpoint: using fallback site key for ${loginId}`);
    }

    let token;
    try {
      // websiteURL must be the domain root (the internal iframe URL makes
      // CapSolver fail with 1001); ProxyLess — passing the ProxyBase proxy
      // trips CapSolver "proxy authentication failed".
      token = await captchaSolverService.solveCaptcha(
        siteKey,
        'https://www.linkedin.com/',
        'recaptcha_v2',
        null,
        { enterprise, invisible: false }
      );
    } catch (e) {
      console.warn(`LinkedIn checkpoint solve failed for ${loginId}: ${e.message}`);
      return false;
    }
    if (!token) return false;

    // Inject the token + fire grecaptcha callback INSIDE the captchaInternal frame.
    await captchaSolverService.injectCaptchaToken(captchaFrame, token).catch(() => {});
    console.log(`LinkedIn checkpoint token injected for ${loginId} (${enterprise ? 'enterprise' : 'v2'})`);
    await this.humanLikeDelay(1500, 2500);

    // Nudge a Submit/Verify inside the frame or top doc if callback didn't submit.
    const clickSubmit = async (ctx) => {
      await ctx
        .evaluate(() => {
          const btns = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')];
          const b = btns.find(
            (x) =>
              /^(Submit|Verify|Continue|Next|Done)$/i.test((x.innerText || x.value || '').trim()) &&
              x.offsetParent !== null &&
              !x.disabled
          );
          if (b) b.click();
        })
        .catch(() => {});
    };
    await clickSubmit(captchaFrame);
    await clickSubmit(page);
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    await this.humanLikeDelay(1500, 2500);
    return true;
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
      const detectChallenge = () =>
        page
          .evaluate(() => {
            const text = (document.body?.innerText || '').slice(0, 3500);
            return {
              pin: !!document.querySelector(
                'input[name="pin"], input#input__phone_verification_pin, input[id*="pin" i], input[autocomplete="one-time-code"]'
              ),
              totp: /authenticator|verification code|enter the code|security code|two.?step|two.?factor|6.?digit|Enter code|Enter the 6-digit/i.test(text),
              appPush: /Check your LinkedIn app|notification to your signed-in devices/i.test(text),
              captcha:
                /quick security check|verify you.?re human|I.?m not a robot/i.test(text) ||
                !!document.querySelector(
                  '#captcha-internal, .captcha, iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[title*="reCAPTCHA" i], iframe[src*="arkoselabs"], iframe[src*="funcaptcha"], [data-sitekey], .g-recaptcha'
                ),
              challengeDialog: !!document.querySelector('.challenge-dialog'),
              snippet: text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 8).join(' | '),
            };
          })
          .catch(() => ({}));
      let challenge = await detectChallenge();

      if (challenge.captcha && !challenge.totp && !challenge.pin && !challenge.appPush) {
        console.log(`LinkedIn security check (reCAPTCHA) for ${loginId}: ${challenge.snippet}`);
        const solved = await this.solveLinkedInCheckpoint(page, loginId, extras).catch((e) => {
          console.warn(`LinkedIn checkpoint solve error for ${loginId}: ${e.message}`);
          return false;
        });
        if (!solved) {
          await page.screenshot({ path: `/tmp/linkedin-captcha-${Date.now()}.png` }).catch(() => {});
          return false;
        }
        await this.humanLikeDelay(2500, 4500);
        // Checkpoint clears asynchronously and usually advances to an authenticator
        // TOTP step — poll until that (or a logged-in URL) appears before re-checking.
        challenge = await detectChallenge();
        for (
          let i = 0;
          i < 8 &&
          !challenge.totp &&
          !challenge.pin &&
          !challenge.appPush &&
          !challenge.challengeDialog;
          i++
        ) {
          if (/linkedin\.com\/(feed|in\/|mynetwork|messaging)/i.test(page.url())) break;
          await this.humanLikeDelay(1500, 2500);
          challenge = await detectChallenge();
        }
        if (challenge.captcha && !challenge.totp && !challenge.pin && !challenge.appPush) {
          console.log(`LinkedIn checkpoint still present after solve for ${loginId}`);
          await page.screenshot({ path: `/tmp/linkedin-captcha-post-${Date.now()}.png` }).catch(() => {});
          return false;
        }
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

        const findPinInput = async () => {
          let el = await page
            .waitForSelector(
              'input[name="pin"], input#input__phone_verification_pin, input[id*="pin" i], input[autocomplete="one-time-code"], input[type="tel"], input[inputmode="numeric"]',
              { timeout: 15000, state: 'visible' }
            )
            .catch(() => null);
          if (!el) {
            const handles = await page.$$('input[type="text"], input[type="tel"], input[type="number"], input[inputmode="numeric"]');
            for (const h of handles) {
              if (await h.isVisible().catch(() => false)) {
                el = h;
                break;
              }
            }
          }
          return el;
        };

        const submitTotpOnce = async () => {
          const pinInput = await findPinInput();
          if (!pinInput) return 'no_input';
          // Submit on a fresh TOTP window so typing/latency can't expire the code.
          if (totpSecondsRemaining() < 8) {
            await this.humanLikeDelay((totpSecondsRemaining() + 1) * 1000, (totpSecondsRemaining() + 2) * 1000);
          }
          const code = generateTotp(extras.totpSecret);
          if (!/^\d{6}$/.test(code)) return 'bad_code';
          console.log(`LinkedIn 2FA for ${loginId} — submitting TOTP (${totpSecondsRemaining()}s left)`);
          await pinInput.click({ force: true });
          await pinInput.fill('');
          await pinInput.type(code, { delay: 60 });
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
          await this.humanLikeDelay(3000, 4500);
          // The post-2FA redirect can take several seconds (blank/spinner while
          // LinkedIn establishes the session). Poll until it settles into a
          // logged-in URL, a wrong-code error, or a persistent challenge — do NOT
          // navigate away early (that abandons an in-flight login).
          await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
          for (let i = 0; i < 12; i++) {
            const state = await page
              .evaluate(() => {
                const text = (document.body?.innerText || '').slice(0, 2000);
                return {
                  wrong: /that.?s not the right code|isn.?t correct|incorrect|try again|didn.?t work|wrong code|enter a valid/i.test(text),
                  prompt: !!document.querySelector(
                    'input[name="pin"], input[autocomplete="one-time-code"], input[id*="pin" i]'
                  ),
                  loggedIn: /Start a post|Messaging|My Network|Notifications/i.test(text),
                  url: location.href,
                };
              })
              .catch(() => ({}));
            const u = state.url || page.url();
            if (/linkedin\.com\/(feed|in\/|mynetwork|messaging)/i.test(u) || state.loggedIn) return 'ok';
            if (state.wrong) return 'wrong';
            if (!state.prompt && !/checkpoint|\/login/i.test(u)) return 'ok';
            await this.humanLikeDelay(1500, 2200);
          }
          return 'retry';
        };

        let totpResult = await submitTotpOnce();
        if (totpResult === 'no_input') {
          console.log(`LinkedIn 2FA input missing for ${loginId}`);
          await page.screenshot({ path: `/tmp/linkedin-2fa-missing-${Date.now()}.png` }).catch(() => {});
          return false;
        }
        // Retry once with a fresh window if the first code was rejected / not consumed.
        if (totpResult === 'wrong' || totpResult === 'retry') {
          console.log(`LinkedIn 2FA retry for ${loginId} (prev=${totpResult})`);
          await this.humanLikeDelay((totpSecondsRemaining() + 1) * 1000, (totpSecondsRemaining() + 2) * 1000);
          totpResult = await submitTotpOnce();
        }
        await page.screenshot({ path: `/tmp/linkedin-post-totp-${loginId}-${Date.now()}.png` }).catch(() => {});
      } else if (challenge.pin || challenge.totp || challenge.appPush || challenge.challengeDialog) {
        console.log(`LinkedIn challenge without TOTP secret for ${loginId}: ${challenge.snippet}`);
        await page.screenshot({ path: `/tmp/linkedin-challenge-${Date.now()}.png` }).catch(() => {});
        return false;
      }

      // Hard restriction: passed password/captcha/2FA but LinkedIn flagged the
      // account and demands government-ID verification. Terminal — surface it
      // clearly rather than looping (no automation can clear this).
      const restricted = await page
        .evaluate(() =>
          /Access to your account has been (temporarily )?restricted|verify your identity|government-issued ID|submit a government/i.test(
            (document.body?.innerText || '').slice(0, 2500)
          )
        )
        .catch(() => false);
      if (restricted) {
        console.log(`LinkedIn ID-verification restriction for ${loginId}`);
        await page.screenshot({ path: `/tmp/linkedin-restricted-${loginId}-${Date.now()}.png` }).catch(() => {});
        throw new Error('linkedin_id_verification_restricted: account requires government-ID verification');
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
      // Terminal account states must propagate — do not collapse into a generic
      // `false` or callers misclassify them as soft login_failed.
      const msg = error?.message || String(error);
      if (/linkedin_id_verification_restricted|government-ID|id_verification_restricted/i.test(msg)) {
        throw error;
      }
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
      // Prefer direct — sticky proxies often authwall live LinkedIn cookies.
      let result;
      try {
        result = await this.createBrowserForAccount(accountId, 2, { skipProxy: true });
      } catch {
        result = await this.createBrowserForAccount(accountId);
      }
      browser = result.browser;
      context = result.context;
      page = result.page;
      proxyId = result.proxyConfig?._proxyId;

      const loginEmail = account.email || account.username;
      const password = creds.password || account.credentials?.password;
      const extras = {
        allowLogin: false,
        totpSecret: creds.totp_secret || creds.totp || creds.twofa,
        emailPassword: creds.email_password,
        profileUrl: creds.profile_url,
      };
      let loggedIn = await this.ensureLoggedIn(page, 'linkedin', accountId, loginEmail, password, extras);
      if (!loggedIn) {
        extras.allowLogin = true;
        loggedIn = await this.ensureLoggedIn(page, 'linkedin', accountId, loginEmail, password, extras);
      }
      if (!loggedIn) throw new Error('LinkedIn login failed');

      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' }).catch(() => {});
      await this.humanLikeDelay(2000, 4000);
      await this.dismissLinkedInModals(page);
      await this.simulateHumanBehavior(page);

      let startPostBtn = await page.$(
        'button[data-control-name="share.start_post"], button[aria-label*="Start a post" i], button.share-box-feed-entry__trigger'
      );
      if (!startPostBtn) {
        startPostBtn = await page.evaluateHandle(() => {
          const buttons = [...document.querySelectorAll('button, div[role="button"], a')];
          return (
            buttons.find((b) => /start a post/i.test((b.innerText || b.getAttribute('aria-label') || '').trim())) ||
            null
          );
        });
        if (startPostBtn && !(await startPostBtn.asElement())) startPostBtn = null;
        else if (startPostBtn) startPostBtn = startPostBtn.asElement();
      }
      if (!startPostBtn) {
        await page.screenshot({ path: `/tmp/linkedin-no-start-post-${accountId}.png` }).catch(() => {});
        throw new Error('LinkedIn Start a post control not found');
      }
      await startPostBtn.click({ force: true });
      await this.humanLikeDelay(1000, 2000);

      const editor = await page.waitForSelector('.ql-editor, div[role="textbox"]', { timeout: 15000 });
      await editor.click({ force: true });
      await this.humanLikeDelay(300, 600);
      // LinkedIn share box needs real input events to enable Post.
      await page.keyboard.type(content, { delay: 25 });
      await this.humanLikeDelay(1000, 2000);

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

      await this.humanLikeDelay(800, 1500);
      const posted = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button')];
        // Prefer primary share-box Post (enabled, exact label)
        const candidates = buttons.filter((b) => {
          const t = (b.innerText || '').trim();
          return /^Post$/i.test(t) && !b.disabled && b.offsetParent !== null;
        });
        // Prefer buttons inside share/modal containers
        const inModal = candidates.find((b) =>
          b.closest('.share-box, .share-creation-state, [data-test-modal-id], .artdeco-modal')
        );
        const btn = inModal || candidates[candidates.length - 1] || null;
        if (!btn) return false;
        btn.click();
        return true;
      });
      if (!posted) {
        await page.screenshot({ path: `/tmp/linkedin-no-post-btn-${accountId}.png` }).catch(() => {});
        throw new Error('LinkedIn Post button not found/enabled');
      }
      await this.humanLikeDelay(3000, 5000);

      const postUrl = await page.evaluate(() => {
        const items = document.querySelectorAll('.feed-shared-update-v2, div[data-urn*="activity"]');
        if (items.length > 0) {
          const link = items[0].querySelector('a[href*="/feed/update/"], a[href*="activity-"]');
          return link ? link.href : null;
        }
        return null;
      });

      // Even without a scraped URL, treat successful Post click as success if still on feed.
      let postId = postUrl ? (postUrl.split('update/')[1] || postUrl) : null;
      if (!postId) {
        const stillLoggedIn = !/authwall|\/login/i.test(page.url());
        if (stillLoggedIn) postId = `li-post-${Date.now()}`;
      }
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

      let page = await openBrowser(!!requireProxy);

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
        if (requireProxy) {
          throw new Error('no_live_session — refusing password login (requireProxy cookie-only path)');
        }
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

      if (success) {
        try {
          const { updateEnrichment } = require('./profileEnrichment');
          await updateEnrichment(accountId, { photo: true }, { source: 'linkedin_photo' });
        } catch (enrichErr) {
          console.warn(`LinkedIn #${accountId}: enrichment update failed:`, enrichErr.message);
        }
      }

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
   * Upload LinkedIn profile background/banner (NOT avatar).
   * bannerPath MUST be a landscape scenic under x-banners or linkedin-banners — never portraits.
   */
  async updateLinkedInProfileBanner(accountId, bannerPath, { requireProxy = false } = {}) {
    const fs = require('fs');
    const path = require('path');
    if (!bannerPath || !fs.existsSync(bannerPath)) {
      throw new Error(`Banner not found: ${bannerPath}`);
    }
    const resolved = path.resolve(bannerPath);
    if (
      /linkedin-photos|[/\\]x-photos[/\\]|pilot-|portrait/i.test(resolved) ||
      (!/x-banners|linkedin-banners/i.test(resolved) &&
        /face|headshot|avatar|photo-/i.test(path.basename(resolved)))
    ) {
      throw new Error(
        `Refusing face/portrait as LinkedIn banner (path must be under x-banners/ or linkedin-banners/): ${bannerPath}`
      );
    }
    if (!/x-banners|linkedin-banners/i.test(resolved)) {
      throw new Error(
        `Refusing non-banner asset as LinkedIn header (must live under x-banners/ or linkedin-banners/): ${bannerPath}`
      );
    }

    let browser;
    let proxyId = null;
    try {
      const account = await this.getAccount(accountId);
      if (account.platform !== 'linkedin') {
        throw new Error(`Account ${accountId} is ${account.platform}, expected linkedin`);
      }
      const creds =
        typeof account.credentials === 'string'
          ? JSON.parse(account.credentials)
          : account.credentials || {};
      const password = creds.password;
      const loginEmail = account.email || account.username;
      const profileUrl = (creds.profile_url || `https://www.linkedin.com/in/${account.username}`).replace(
        /\/?$/,
        '/'
      );
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

      let page = await openBrowser(!!requireProxy);
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
          console.log(`LinkedIn #${accountId}: banner — reused session on ${page.url()}`);
        }
      }

      if (!loggedIn) {
        if (requireProxy) {
          throw new Error('no_live_session — refusing password login (requireProxy cookie-only path)');
        }
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
        await page.screenshot({ path: `/tmp/linkedin-banner-authwall-${accountId}.png` }).catch(() => {});
        throw new Error(`Still on authwall after login: ${page.url()}`);
      }

      await this.dismissLinkedInModals(page).catch(() => {});
      await this.randomScroll(page).catch(() => {});

      // Step 1: camera on cover → menu
      const bgBtn = page.locator(
        'button[aria-label*="background" i], button[aria-label*="Edit background" i], button[aria-label*="Add background" i], a[aria-label*="background" i], button[aria-label*="cover" i]'
      ).first();
      if (!(await bgBtn.isVisible().catch(() => false))) {
        await page.screenshot({ path: `/tmp/linkedin-banner-no-edit-${accountId}.png` }).catch(() => {});
        throw new Error('Edit background control not found');
      }
      await bgBtn.click({ force: true });
      await this.humanLikeDelay(700, 1400);

      // Step 2: "Add cover image" opens cover modal (not a filechooser yet)
      const coverItem = page.locator(
        'div[aria-label="Add cover image"], [aria-label="Add cover image"], [aria-label*="Add cover image" i], [aria-label*="Change cover image" i]'
      ).first();
      if (await coverItem.isVisible().catch(() => false)) {
        await coverItem.click({ noWaitAfter: true }).catch(() => coverItem.click({ force: true }));
      } else {
        await page.evaluate(() => {
          const el = [...document.querySelectorAll('[aria-label], button, a, div')].find((e) =>
            /Add cover image|Change cover image/i.test(
              `${e.getAttribute('aria-label') || ''} ${(e.innerText || '').trim()}`
            )
          );
          if (!el) throw new Error('Add cover image menu item not found');
          el.click();
        });
      }
      await this.humanLikeDelay(2000, 3500);

      // Step 3: modal "Upload single photo" / "Choose an image" → filechooser
      try {
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 15000 }),
          page.evaluate(() => {
            const buttons = [...document.querySelectorAll('button, [role="button"], a, label, div')];
            const order = [
              /^Upload single photo$/i,
              /^Choose an image$/i,
              /Upload single photo/i,
              /Choose an image/i,
              /Upload your own/i,
            ];
            for (const re of order) {
              const b = buttons.find((x) => {
                const t = (x.innerText || x.getAttribute('aria-label') || '').trim();
                if (!re.test(t)) return false;
                const r = x.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
              });
              if (b) {
                b.click();
                return (b.innerText || '').trim().slice(0, 40);
              }
            }
            throw new Error('Upload single photo control not found');
          }),
        ]);
        await chooser.setFiles(bannerPath);
        console.log(`LinkedIn #${accountId}: banner file set via cover modal chooser`);
      } catch (e) {
        console.warn(`LinkedIn #${accountId}: cover chooser failed (${e.message}), trying input`);
        const inputs = await page.$$('input[type="file"]');
        if (!inputs.length) {
          await page.screenshot({ path: `/tmp/linkedin-banner-no-input-${accountId}.png` }).catch(() => {});
          throw new Error('LinkedIn banner file input not found');
        }
        await inputs[0].setInputFiles(bannerPath);
      }

      await this.humanLikeDelay(3000, 5000);
      for (let i = 0; i < 2; i++) {
        await page
          .evaluate(() => {
            const b = [...document.querySelectorAll('button')].find((x) =>
              /^Got it$/i.test((x.innerText || '').trim())
            );
            if (b) b.click();
          })
          .catch(() => {});
        await this.humanLikeDelay(400, 800);
      }

      await page.screenshot({ path: `/tmp/linkedin-banner-before-save-${accountId}.png` }).catch(() => {});

      for (let i = 0; i < 6; i++) {
        const clicked = await page.evaluate(() => {
          const buttons = [...document.querySelectorAll('button, [role="button"]')];
          const order = [
            /^Apply$/i,
            /^Save changes$/i,
            /^Save photo$/i,
            /^Save to profile$/i,
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
        console.log(`LinkedIn #${accountId}: banner clicked "${clicked}"`);
        await this.humanLikeDelay(2500, 4000);
      }

      await this.humanLikeDelay(3000, 5000);
      await page.goto('https://www.linkedin.com/in/me/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await this.humanLikeDelay(2500, 4000);
      await page.screenshot({ path: `/tmp/linkedin-banner-done-${accountId}.png` }).catch(() => {});

      const bannerInfo = await page.evaluate(() => {
        const imgs = [...document.querySelectorAll('img')];
        const avatar =
          imgs.find((i) =>
            /profile-displayphoto|EntityPhoto|presencephoto|eprofile/i.test(
              `${i.className} ${i.alt} ${i.src}`
            )
          ) || null;
        const bannerImg =
          imgs.find((i) =>
            /profile-displaybackground|background-display|cover-img|profile-background/i.test(
              `${i.className} ${i.alt} ${i.src}`
            )
          ) || null;
        let bannerBg = null;
        for (const el of document.querySelectorAll('div, section, figure, span, img')) {
          const s = el.tagName === 'IMG' ? '' : getComputedStyle(el).backgroundImage || '';
          if (el.tagName === 'IMG') continue;
          if (!/media\.licdn\.com/i.test(s)) continue;
          const r = el.getBoundingClientRect();
          if (r.width > 400 && r.height > 80 && r.top < 450) {
            const m = s.match(/url\(["']?([^"')]+)/);
            bannerBg = m ? m[1] : null;
            break;
          }
        }
        // Also treat wide top-of-profile images (not avatar) as banner
        const wideTop =
          imgs.find((i) => {
            const r = i.getBoundingClientRect();
            return r.width > 400 && r.height > 80 && r.top < 350 && /media\.licdn\.com/i.test(i.src);
          }) || null;
        const addStill = [...document.querySelectorAll('button, a')].some((e) =>
          /^Add background image$/i.test((e.getAttribute('aria-label') || '').trim())
        );
        const editBg = [...document.querySelectorAll('button, a')].some((e) =>
          /Edit background|Change background|Edit cover/i.test(e.getAttribute('aria-label') || '')
        );
        const bannerSrc = bannerImg?.src || bannerBg || wideTop?.src || null;
        const hasBanner =
          (!!bannerSrc && /media\.licdn\.com/i.test(bannerSrc)) || (editBg && !addStill);
        return {
          url: location.href,
          avatarSrc: avatar?.src || null,
          bannerSrc,
          hasBanner,
          addStill,
          editBg,
          avatarIsBanner: !!(avatar?.src && bannerSrc && avatar.src === bannerSrc),
        };
      }).catch(() => ({}));

      await this.persistSession(page, 'linkedin', accountId);

      const success =
        !/authwall|\/login/i.test(bannerInfo.url || '') &&
        !!bannerInfo.hasBanner &&
        !bannerInfo.avatarIsBanner;

      if (success) {
        try {
          const { updateEnrichment } = require('./profileEnrichment');
          await updateEnrichment(accountId, { banner: true }, { source: 'linkedin_banner' });
        } catch (enrichErr) {
          console.warn(`LinkedIn #${accountId}: banner enrichment failed:`, enrichErr.message);
        }
      }

      return {
        success,
        accountId,
        email: loginEmail,
        profileUrl,
        finalUrl: bannerInfo.url || null,
        bannerSrc: bannerInfo.bannerSrc || null,
        avatarSrc: bannerInfo.avatarSrc || null,
        usedProxy: !!proxyId,
        proofScreenshot: `/tmp/linkedin-banner-done-${accountId}.png`,
      };
    } catch (error) {
      console.error(`LinkedIn banner update failed for ${accountId}:`, error.message);
      return { success: false, accountId, error: error.message, usedProxy: !!proxyId };
    } finally {
      if (browser) await browser.close();
      this._untrackBrowser(accountId);
    }
  }

  /**
   * Connect (person) or Follow (company/person-with-follow) on LinkedIn.
   */
  async followLinkedInTarget(accountId, handle, {
    targetType = 'person',
    requireProxy = false,
    // Owned LinkedIn accounts carry passwords — cookie-first, password fallback.
    allowLogin = true,
  } = {}) {
    const slug = String(handle || '')
      .replace(/^@/, '')
      .replace(/\/$/, '')
      .trim();
    if (!slug) throw new Error('LinkedIn follow handle required');
    const profileUrl =
      targetType === 'company'
        ? `https://www.linkedin.com/company/${slug}/`
        : `https://www.linkedin.com/in/${slug}/`;

    let browser;
    try {
      const account = await this.getAccount(accountId);
      if (account.platform !== 'linkedin') {
        throw new Error(`Account ${accountId} is ${account.platform}, expected linkedin`);
      }
      const creds =
        typeof account.credentials === 'string'
          ? JSON.parse(account.credentials)
          : account.credentials || {};
      const loginId = account.email || account.username;
      const extras = {
        allowLogin,
        totpSecret: creds.totp_secret || creds.totp || creds.twofa,
        emailPassword: creds.email_password,
        profileUrl: creds.profile_url,
      };

      const opened = requireProxy
        ? await this.createBrowserForAccount(accountId, 2, { requireProxy: true })
        : await this.createBrowser(
            null,
            false,
            await this.getOrCreateDeviceProfile(accountId, { forceDesktop: true })
          );
      browser = opened.browser;
      if (!requireProxy) {
        opened.accountId = accountId;
        this._trackBrowser(accountId, opened.browser);
      }
      const page = opened.page;

      const loggedIn = await this.ensureLoggedIn(
        page,
        'linkedin',
        accountId,
        loginId,
        creds.password,
        extras
      );
      if (!loggedIn) throw new Error('no_live_session for linkedin follow');

      await this.humanBrowseLinkedInSession(page, { accountId }).catch(() => {});
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.humanLikeDelay(2000, 3500);
      await this.dismissLinkedInModals(page).catch(() => {});

      if (/authwall|\/login|\/uas\//i.test(page.url())) {
        throw new Error(`LinkedIn profile authwalled: ${page.url()}`);
      }

      const state = await page.evaluate(() => {
        const text = (document.body?.innerText || '').slice(0, 4000);
        const already =
          /Pending|Invitation sent|Connected|Following\b/i.test(text) &&
          [...document.querySelectorAll('button, [role="button"]')].some((b) =>
            /^(Pending|Connected|Following|Message)$/i.test((b.innerText || '').trim())
          );
        return { already, url: location.href };
      });

      if (state.already) {
        await this.persistSession(page, 'linkedin', accountId).catch(() => {});
        return {
          followed: false,
          alreadyFollowing: true,
          pending: /Pending|Invitation sent/i.test(
            await page.evaluate(() => document.body?.innerText || '').catch(() => '')
          ),
          profileUrl,
        };
      }

      const clicked = await page.evaluate((preferFollow) => {
        const buttons = [...document.querySelectorAll('button, [role="button"]')];
        const visible = (b) => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && !b.disabled;
        };
        const labelOf = (b) => `${b.getAttribute('aria-label') || ''} ${(b.innerText || '').trim()}`;
        const order = preferFollow
          ? [/^Follow$/i, /^Connect$/i, /Follow/i, /Connect/i]
          : [/^Connect$/i, /^Follow$/i, /Connect/i, /Follow/i];
        for (const re of order) {
          const b = buttons.find((x) => re.test(labelOf(x).trim()) && visible(x));
          if (b) {
            b.click();
            return labelOf(b).trim().slice(0, 40);
          }
        }
        return null;
      }, targetType === 'company');

      if (!clicked) {
        await page.screenshot({ path: `/tmp/linkedin-follow-nobtn-${accountId}.png` }).catch(() => {});
        throw new Error(`Connect/Follow button not found on ${profileUrl}`);
      }
      console.log(`LinkedIn #${accountId}: clicked "${clicked}" on ${slug}`);
      await this.humanLikeDelay(1200, 2200);

      // Send without note if modal appears
      await page
        .evaluate(() => {
          const buttons = [...document.querySelectorAll('button, [role="button"]')];
          const send = buttons.find((b) =>
            /send without a note|^Send$|Send now|Send invitation/i.test((b.innerText || '').trim())
          );
          if (send && !send.disabled) send.click();
        })
        .catch(() => {});
      await this.humanLikeDelay(1500, 2500);

      const after = await page.evaluate(() => {
        const text = (document.body?.innerText || '').slice(0, 3000);
        return {
          pending: /Pending|Invitation sent/i.test(text),
          following: /\bFollowing\b|\bConnected\b/i.test(text),
        };
      });

      await this.persistSession(page, 'linkedin', accountId).catch(() => {});
      await page.screenshot({ path: `/tmp/linkedin-follow-done-${accountId}.png` }).catch(() => {});

      return {
        followed: !!(after.following || after.pending || clicked),
        alreadyFollowing: false,
        pending: !!after.pending,
        profileUrl,
        action: clicked,
      };
    } finally {
      if (browser) await browser.close().catch(() => {});
      this._untrackBrowser(accountId);
    }
  }

  /**
   * Accept pending LinkedIn connection invitations (My Network).
   */
  async acceptLinkedInInvitations(accountId, { maxAccept = 5 } = {}) {
    let browser;
    const screenshots = [];
    try {
      const account = await this.getAccount(accountId);
      const creds =
        typeof account.credentials === 'string'
          ? JSON.parse(account.credentials)
          : account.credentials || {};
      const loginId = account.email || account.username;
      const opened = await this.createBrowser(
        null,
        false,
        await this.getOrCreateDeviceProfile(accountId, { forceDesktop: true })
      );
      browser = opened.browser;
      opened.accountId = accountId;
      this._trackBrowser(accountId, opened.browser);
      const page = opened.page;

      const loggedIn = await this.ensureLoggedIn(page, 'linkedin', accountId, loginId, creds.password, {
        allowLogin: true,
        totpSecret: creds.totp_secret || creds.totp || creds.twofa,
      });
      if (!loggedIn) throw new Error('no_live_session for linkedin accept');

      await page.goto('https://www.linkedin.com/mynetwork/invitation-manager/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await this.humanLikeDelay(2000, 3500);
      await this.dismissLinkedInModals(page).catch(() => {});

      let accepted = 0;
      for (let i = 0; i < maxAccept; i++) {
        const clicked = await page.evaluate(() => {
          const buttons = [...document.querySelectorAll('button, [role="button"]')];
          const accept = buttons.find((b) => {
            const t = (b.innerText || b.getAttribute('aria-label') || '').trim();
            if (!/^Accept$/i.test(t) && !/Accept /i.test(t)) return false;
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && !b.disabled;
          });
          if (!accept) return null;
          accept.click();
          return (accept.innerText || accept.getAttribute('aria-label') || '').trim();
        });
        if (!clicked) break;
        accepted += 1;
        await this.humanLikeDelay(1200, 2200);
      }

      const shot = `/tmp/linkedin-accept-${accountId}.png`;
      await page.screenshot({ path: shot }).catch(() => {});
      screenshots.push(shot);
      await this.persistSession(page, 'linkedin', accountId).catch(() => {});

      return { accepted, empty: accepted === 0, screenshots };
    } finally {
      if (browser) await browser.close().catch(() => {});
      this._untrackBrowser(accountId);
    }
  }

  /**
   * Discover people/companies from LinkedIn search + People You May Know.
   */
  async discoverLinkedInFollowTargets(accountId, { keywords = [], limit = 12 } = {}) {
    let browser;
    try {
      const account = await this.getAccount(accountId);
      const creds =
        typeof account.credentials === 'string'
          ? JSON.parse(account.credentials)
          : account.credentials || {};
      const loginId = account.email || account.username;
      const opened = await this.createBrowser(
        null,
        false,
        await this.getOrCreateDeviceProfile(accountId, { forceDesktop: true })
      );
      browser = opened.browser;
      opened.accountId = accountId;
      this._trackBrowser(accountId, opened.browser);
      const page = opened.page;

      const loggedIn = await this.ensureLoggedIn(page, 'linkedin', accountId, loginId, creds.password, {
        allowLogin: true,
        totpSecret: creds.totp_secret || creds.totp || creds.twofa,
      });
      if (!loggedIn) throw new Error('no_live_session for linkedin discover');

      const targets = [];
      const seen = new Set();
      const addFromPage = async (targetType) => {
        const found = await page.evaluate((max) => {
          const out = [];
          for (const a of document.querySelectorAll('a[href*="/in/"], a[href*="/company/"]')) {
            const href = (a.href || '').split('?')[0];
            const person = href.match(/linkedin\.com\/in\/([^/?#]+)/i);
            const company = href.match(/linkedin\.com\/company\/([^/?#]+)/i);
            if (person) out.push({ handle: decodeURIComponent(person[1]), target_type: 'person' });
            else if (company) out.push({ handle: decodeURIComponent(company[1]), target_type: 'company' });
            if (out.length >= max) break;
          }
          return out;
        }, limit);
        for (const t of found) {
          const key = `${t.target_type}:${t.handle}`.toLowerCase();
          if (seen.has(key)) continue;
          if (/^(feed|mynetwork|messaging|jobs|login|signup)$/i.test(t.handle)) continue;
          seen.add(key);
          targets.push({ ...t, notes: 'discovered' });
          if (targets.length >= limit) return;
        }
      };

      // People you may know
      await page.goto('https://www.linkedin.com/mynetwork/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await this.humanLikeDelay(2000, 3500);
      await this.dismissLinkedInModals(page).catch(() => {});
      await this.randomScroll(page).catch(() => {});
      await addFromPage('person');

      const kw = (keywords && keywords[0]) || 'talent acquisition';
      if (targets.length < limit) {
        const url = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(kw)}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await this.humanLikeDelay(2000, 3500);
        await this.randomScroll(page).catch(() => {});
        await addFromPage('person');
      }

      await this.persistSession(page, 'linkedin', accountId).catch(() => {});
      return { targets: targets.slice(0, limit), keywords };
    } finally {
      if (browser) await browser.close().catch(() => {});
      this._untrackBrowser(accountId);
    }
  }

  async humanBrowseLinkedInSession(page, { accountId } = {}) {
    try {
      if (!/linkedin\.com\/feed/i.test(page.url())) {
        await page.goto('https://www.linkedin.com/feed/', {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        }).catch(() => {});
      }
      await this.humanLikeDelay(1200, 2200);
      await this.dismissLinkedInModals(page).catch(() => {});
      await this.randomScroll(page).catch(() => {});
      await this.humanLikeDelay(800, 1600);
      if (Math.random() < 0.4) {
        await this.randomScroll(page).catch(() => {});
      }
    } catch (err) {
      console.warn(`LinkedIn browse #${accountId || '?'}:`, err.message);
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

      let page;
      // Always prefer proxy for LinkedIn profile writes when requireProxy is set;
      // never hit LinkedIn from the host IP on live accounts.
      if (requireProxy) {
        page = await openBrowser(true);
      } else {
        page = await openBrowser(false);
      }
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
        if (requireProxy) {
          throw new Error('no_live_session — refusing password login (requireProxy cookie-only path)');
        }
        loggedIn = await this.performLogin(page, 'linkedin', loginEmail, password, extras);
        if (!loggedIn) {
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
      if (success) {
        try {
          const { updateEnrichment } = require('./profileEnrichment');
          await updateEnrichment(
            accountId,
            {
              headline: steps.includes('headline') || steps.includes('industry') || !!snapshot.hasHeadlineHint,
              about: steps.includes('about'),
              experience: steps.includes('experience'),
              category: 'hr_talent',
            },
            { source: 'linkedin_hiring_persona' }
          );
        } catch (enrichErr) {
          console.warn(`LinkedIn #${accountId}: enrichment update failed:`, enrichErr.message);
        }
      }
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

  /**
   * Fail fast on X error/suspension UI. Never treat these as apply success.
   */
  async assertXProfileActionAllowed(page, { accountId } = {}) {
    const tag = accountId ? `#${accountId}` : '';

    // Transient "Oops" modal — dismiss once and re-check (not a ban)
    // IMPORTANT: locator.elementHandle() waits default 30s when absent — always pass a short timeout.
    const dismissOops = async () => {
      const oops = await page
        .locator('[role="dialog"]')
        .filter({ hasText: /Oops,\s*something went wrong/i })
        .first()
        .elementHandle({ timeout: 1200 })
        .catch(() => null);
      if (!oops) return false;
      const ok =
        (await page
          .locator('[role="dialog"] button:has-text("OK"), [role="dialog"] [role="button"]:has-text("OK")')
          .first()
          .elementHandle({ timeout: 1500 })
          .catch(() => null)) ||
        (await page
          .locator('button:has-text("OK")')
          .first()
          .elementHandle({ timeout: 1500 })
          .catch(() => null));
      if (ok) {
        await ok.click().catch(() => {});
        await this.humanLikeDelay(1200, 2200);
        console.warn(`X persona ${tag}: dismissed transient Oops modal`);
        return true;
      }
      await page.keyboard.press('Escape').catch(() => {});
      await this.humanLikeDelay(800, 1400);
      return true;
    };
    await dismissOops();

    const text = await page
      .evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const parts = [
          dialog ? dialog.innerText || '' : '',
          document.body ? document.body.innerText || '' : '',
        ];
        return parts.join('\n').slice(0, 12000);
      })
      .catch(() => '');

    if (/Your account is suspended/i.test(text)) {
      await page.screenshot({ path: `/tmp/x-persona-suspended-${accountId || 'x'}.png` }).catch(() => {});
      throw new Error(
        'account_suspended: Your account is suspended and is not permitted to perform this action'
      );
    }
    if (/Oops,\s*something went wrong/i.test(text)) {
      // Second look after dismiss — still present → soft fail (NOT ban)
      await page.screenshot({ path: `/tmp/x-persona-oops-${accountId || 'x'}.png` }).catch(() => {});
      throw new Error('x_profile_error: Oops, something went wrong. Please try again later.');
    }
    // Banner-only suspension inside edit modal (sometimes sparse body text)
    const banner = await page
      .locator('[role="dialog"]')
      .filter({ hasText: /suspended/i })
      .count()
      .catch(() => 0);
    if (banner > 0) {
      await page.screenshot({ path: `/tmp/x-persona-suspended-${accountId || 'x'}.png` }).catch(() => {});
      throw new Error(
        'account_suspended: Your account is suspended and is not permitted to perform this action'
      );
    }
    console.log(`X persona ${tag}: no Oops/suspension banner detected`);
  }

  _normXPersonaText(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /**
   * Read Name/Bio from the Edit profile modal inputs (authoritative).
   * Never trust bare document.querySelector('[data-testid="UserName"]') —
   * that hits switcher / stale optimistic nodes and false-positives applied_live.
   */
  async readXLiveProfile(page, { accountId, username } = {}) {
    const tag = accountId ? `#${accountId}` : '';
    console.log(`X persona ${tag}: reading back live profile for verification`);

    // Prefer sidebar Profile (same human path as edit). DB username is often stale
    // after AccsMarket handle renames — URL-teleport then false-fails with
    // "This account doesn't exist" + missing Edit button while the live session
    // already shows the correct persona in the switcher.
    const openOwnProfileViaSidebar = async () => {
      if (!/x\.com|twitter\.com/i.test(page.url() || '')) {
        await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await this.humanLikeDelay(1500, 2500);
      }
      const profileLink =
        (await page.$('[data-testid="AppTabBar_Profile_Link"]')) ||
        (await page.locator('a[aria-label="Profile"]').first().elementHandle().catch(() => null));
      if (!profileLink) {
        await page.waitForSelector('[data-testid="AppTabBar_Profile_Link"]', { timeout: 30000 });
      }
      const el = profileLink || (await page.$('[data-testid="AppTabBar_Profile_Link"]'));
      if (!el) throw new Error('X Profile sidebar link not found for verify read-back');
      await el.click();
      await this.humanLikeDelay(3000, 4500);
    };

    const pageSaysMissingAccount = async () => {
      await this.humanLikeDelay(800, 1400);
      const text = await page
        .evaluate(() => ((document.body && document.body.innerText) || '').slice(0, 4000))
        .catch(() => '');
      return /This account doesn.?t exist/i.test(text);
    };

    await openOwnProfileViaSidebar();

    // Soft cache-bust WITHOUT using DB username (handles are often renamed).
    // Reload the live profile URL from the address bar after sidebar navigation.
    const livePath = await page.evaluate(() => window.location.pathname || '').catch(() => '');
    if (/^\/[A-Za-z0-9_]{1,15}\/?$/.test(livePath)) {
      const bustUrl = `https://x.com${livePath.replace(/\/$/, '')}?persona_verify=${Date.now()}`;
      await page.goto(bustUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await this.humanLikeDelay(2000, 3500);
      if (await pageSaysMissingAccount()) {
        console.warn(`X persona ${tag}: live path ${livePath} 404 — reopening via sidebar`);
        await openOwnProfileViaSidebar();
      }
    } else if (username) {
      // Last resort: DB username only if sidebar did not land on a profile path
      const bustUrl = `https://x.com/${username}?persona_verify=${Date.now()}`;
      await page.goto(bustUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await this.humanLikeDelay(2000, 3500);
      if (await pageSaysMissingAccount()) {
        console.warn(
          `X persona ${tag}: DB username @${username} 404 — falling back to sidebar Profile (handle likely renamed)`
        );
        await openOwnProfileViaSidebar();
      }
    }

    // Wait for visible profile header before reading — empty UserName is a soft lie
    await page
      .waitForSelector(
        '[data-testid="primaryColumn"] [data-testid="UserName"], main [data-testid="UserName"]',
        { timeout: 20000 }
      )
      .catch(() => null);
    await this.assertXProfileActionAllowed(page, { accountId });

    // Soft-reconcile live handle when DB username is stale (no password / no rename)
    let liveHandle = await page
      .evaluate(() => {
        const m = (window.location.pathname || '').match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$|\?)/);
        if (!m) return null;
        const h = m[1];
        if (/^(home|explore|search|i|settings|messages|notifications|compose)$/i.test(h)) return null;
        return h;
      })
      .catch(() => null);

    // If URL teleport 404'd or profile never painted, force sidebar once more
    if ((await pageSaysMissingAccount()) || !liveHandle) {
      console.warn(`X persona ${tag}: profile missing/unnavigable after open — forcing sidebar Profile`);
      await openOwnProfileViaSidebar();
      liveHandle = await page
        .evaluate(() => {
          const m = (window.location.pathname || '').match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$|\?)/);
          if (!m) return null;
          const h = m[1];
          if (/^(home|explore|search|i|settings|messages|notifications|compose)$/i.test(h)) return null;
          return h;
        })
        .catch(() => null);
    }

    if (liveHandle && username && liveHandle.toLowerCase() !== String(username).toLowerCase()) {
      console.warn(`X persona ${tag}: live handle @${liveHandle} ≠ DB @${username}`);
    }

    // Visible header name scoped to primary column only (never sidebar switcher)
    const visible = await page.evaluate(() => {
      const col =
        document.querySelector('[data-testid="primaryColumn"]') ||
        document.querySelector('main') ||
        document.body;
      const userNameRoot = col.querySelector('[data-testid="UserName"]');
      const displayName = userNameRoot
        ? (userNameRoot.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || ''
        : '';
      const bio = ((col.querySelector('[data-testid="UserDescription"]') || {}).innerText || '').trim();
      const imgs = Array.from(
        col.querySelectorAll(
          'a[href$="/photo"] img, [data-testid^="UserAvatar-Container"] img, [data-testid="UserAvatar-Container-unknown"] img'
        )
      );
      // Prefer real avatar CDN URLs — never treat profile_banners as the face.
      const avatarSrc =
        imgs
          .map((i) => i.getAttribute('src') || '')
          .find((s) => /profile_images/i.test(s) || /default_profile/i.test(s)) ||
        imgs.map((i) => i.getAttribute('src') || '').find((s) => s && !/profile_banners/i.test(s)) ||
        '';
      const isDefaultAvatar =
        !avatarSrc ||
        /default_profile|default_profile_images|\/default_profile\./i.test(avatarSrc) ||
        /profile_banners/i.test(avatarSrc);
      const bannerImg =
        col.querySelector('a[href$="/header_photo"] img') ||
        col.querySelector('[data-testid="UserProfileHeader_Items"]')?.previousElementSibling?.querySelector?.('img') ||
        col.querySelector('div[style*="background-image"]');
      let bannerSrc = '';
      if (bannerImg && bannerImg.getAttribute) {
        bannerSrc = bannerImg.getAttribute('src') || '';
      }
      if (!bannerSrc) {
        const bg = Array.from(col.querySelectorAll('div')).find((d) => {
          const s = (d.getAttribute('style') || '');
          return /background-image/i.test(s) && /pbs\.twimg\.com\/profile_banners/i.test(s);
        });
        if (bg) {
          const m = (bg.getAttribute('style') || '').match(/url\(["']?([^"')]+)/);
          bannerSrc = m ? m[1] : '';
        }
      }
      const hasCustomBanner =
        !!bannerSrc && /profile_banners/i.test(bannerSrc) && !/default_profile_banners/i.test(bannerSrc);
      return { displayName, bio, avatarSrc, isDefaultAvatar, bannerSrc, hasCustomBanner };
    });

    // Proof artifact: primary-column header BEFORE opening edit modal
    await page.screenshot({ path: `/tmp/x-persona-verify-header-${accountId || 'x'}.png` }).catch(() => {});

    // Authoritative: open Edit profile and read Name / Bio INPUT values
    await page
      .waitForSelector(
        '[data-testid="editProfileButton"], [aria-label="Edit profile"], [aria-label="Set up profile"]',
        { timeout: 30000 }
      )
      .catch(() => null);
    const editBtn =
      (await page.$('[data-testid="editProfileButton"], [aria-label="Edit profile"], [aria-label="Set up profile"]')) ||
      (await page
        .locator('button:has-text("Edit profile"), button:has-text("Set up profile")')
        .first()
        .elementHandle()
        .catch(() => null));
    if (!editBtn) {
      // Last recovery: 404 / blank column after stale URL — sidebar once more
      if (await pageSaysMissingAccount()) {
        console.warn(`X persona ${tag}: no Edit on 404 page — sidebar recovery before fail`);
        await openOwnProfileViaSidebar();
        await page
          .waitForSelector(
            '[data-testid="editProfileButton"], [aria-label="Edit profile"], [aria-label="Set up profile"]',
            { timeout: 30000 }
          )
          .catch(() => null);
        editBtn =
          (await page.$('[data-testid="editProfileButton"], [aria-label="Edit profile"], [aria-label="Set up profile"]')) ||
          (await page
            .locator('button:has-text("Edit profile"), button:has-text("Set up profile")')
            .first()
            .elementHandle()
            .catch(() => null));
      }
    }
    if (!editBtn) {
      await page.screenshot({ path: `/tmp/x-persona-verify-noedit-${accountId || 'x'}.png` }).catch(() => {});
      throw new Error('x_persona_verify_failed: Edit profile button not found for read-back');
    }
    await editBtn.click();
    await this.humanLikeDelay(2000, 3500);
    await this.assertXProfileActionAllowed(page, { accountId });
    await page
      .waitForSelector(
        '[role="dialog"] input[name="displayName"], [role="dialog"] input[name="name"], [role="dialog"] input[type="text"]',
        { timeout: 15000 }
      )
      .catch(() => null);

    const modal = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]') || document.body;
      // Prefer explicit name fields — never the first random text input (location/url)
      let nameEl =
        dialog.querySelector('input[name="displayName"]') ||
        dialog.querySelector('input[name="name"]') ||
        dialog.querySelector('input[data-testid="DisplayNameInput"]');
      if (!nameEl) {
        const inputs = Array.from(dialog.querySelectorAll('input[type="text"], input:not([type])'));
        nameEl =
          inputs.find((el) => {
            const labeled =
              (el.getAttribute('aria-label') || '') +
              ' ' +
              (el.getAttribute('placeholder') || '') +
              ' ' +
              (el.labels && el.labels[0] ? el.labels[0].innerText : '');
            return /\bname\b/i.test(labeled) && !/user.?name|handle|location|website|url/i.test(labeled);
          }) || null;
      }
      const bioEl =
        dialog.querySelector(
          'textarea[name="description"], textarea[name="bio"], textarea[data-testid="Account_description"]'
        ) || dialog.querySelector('textarea');
      const imgs = Array.from(dialog.querySelectorAll('img'));
      const avatarSrc =
        imgs
          .map((i) => i.getAttribute('src') || '')
          .find((s) => /profile_images/i.test(s) || /default_profile/i.test(s)) ||
        imgs
          .map((i) => i.getAttribute('src') || '')
          .find((s) => s && !/profile_banners/i.test(s)) ||
        '';
      return {
        displayName: nameEl ? String(nameEl.value || '').trim() : '',
        bio: bioEl ? String(bioEl.value || '').trim() : '',
        avatarSrc,
        isDefaultAvatar:
          !avatarSrc ||
          /default_profile|default_profile_images|\/default_profile\./i.test(avatarSrc) ||
          /profile_banners/i.test(avatarSrc),
        nameInputFound: !!nameEl,
        bioInputFound: !!bioEl,
      };
    });

    await page.screenshot({ path: `/tmp/x-persona-verify-modal-${accountId || 'x'}.png` }).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    await this.humanLikeDelay(800, 1400);

    // Modal inputs are source of truth; visible header is a cross-check only
    const live = {
      displayName: modal.displayName,
      bio: modal.bio,
      avatarSrc: modal.avatarSrc || visible.avatarSrc,
      isDefaultAvatar:
        modal.avatarSrc != null && modal.avatarSrc !== ''
          ? modal.isDefaultAvatar
          : visible.isDefaultAvatar,
      bannerSrc: visible.bannerSrc || '',
      hasCustomBanner: !!visible.hasCustomBanner,
      source: 'edit_modal',
      visibleDisplayName: visible.displayName,
      visibleBio: visible.bio,
      nameInputFound: !!modal.nameInputFound,
      bioInputFound: !!modal.bioInputFound,
      liveHandle: liveHandle || null,
    };

    console.log(
      `X persona ${tag}: live read (edit_modal) name="${live.displayName}" ` +
        `handle=@${live.liveHandle || '?'} visible="${live.visibleDisplayName}" ` +
        `bioLen=${(live.bio || '').length} visibleBioLen=${(live.visibleBio || '').length} ` +
        `defaultAvatar=${!!live.isDefaultAvatar} banner=${!!live.hasCustomBanner}`
    );
    return live;
  }

  /**
   * Confirm attempted fields actually landed. Name+bio must both verify for applied_live.
   * Photo is independent (photo_applied only).
   */
  async verifyXPersonaLive(page, persona, attempts = {}, { accountId, username } = {}) {
    const tag = accountId ? `#${accountId}` : '';
    const live = await this.readXLiveProfile(page, { accountId, username });
    const verified = { display_name: false, bio: false, photo: false, username: false, banner: false };
    const skipped = [];
    const failed = [];

    if (!live.nameInputFound) {
      failed.push('display_name: Edit profile Name input not found');
    } else if (!attempts.nameAttempted) {
      failed.push('display_name: name field was never filled (nameAttempted=false)');
    } else if (this._normXPersonaText(live.displayName) !== this._normXPersonaText(persona.display_name)) {
      failed.push(
        `display_name expected="${persona.display_name}" edit_modal="${live.displayName || ''}" ` +
          `visible="${live.visibleDisplayName || ''}"`
      );
    } else if (!live.visibleDisplayName) {
      // Modal can retain typed/optimistic values while public header never updated
      failed.push(
        `display_name edit_modal="${live.displayName}" but visible header empty ` +
          `(expected="${persona.display_name}")`
      );
    } else if (
      this._normXPersonaText(live.visibleDisplayName) !== this._normXPersonaText(persona.display_name)
    ) {
      failed.push(
        `display_name edit_modal ok but visible still="${live.visibleDisplayName}" ` +
          `(expected="${persona.display_name}")`
      );
    } else {
      verified.display_name = true;
    }

    if (!attempts.bioAttempted) {
      failed.push('bio: bio field was never filled (bioAttempted=false)');
    } else if (!(persona.bio || '').trim()) {
      skipped.push('bio');
    } else if (!(live.bio || '').trim()) {
      failed.push(
        `bio empty in edit modal (expectedLen=${(persona.bio || '').length} visibleLen=${(live.visibleBio || '').length})`
      );
    } else if (!(live.visibleBio || '').trim()) {
      failed.push(
        `bio present in edit modal (len=${(live.bio || '').length}) but visible profile bio empty`
      );
    } else if (this._normXPersonaText(live.bio) !== this._normXPersonaText(persona.bio)) {
      failed.push(
        `bio mismatch (expectedLen=${(persona.bio || '').length} liveLen=${(live.bio || '').length})`
      );
    } else {
      verified.bio = true;
    }

    // Handle rename — independent of applied_live (name+bio still gate)
    const wantHandle = String(persona.username || persona.handle || '').replace(/^@/, '').trim();
    const handleFailed = [];
    if (!attempts.usernameAttempted) skipped.push('username');
    else if (!wantHandle) skipped.push('username');
    else if (
      live.liveHandle &&
      live.liveHandle.toLowerCase() === wantHandle.toLowerCase()
    ) {
      verified.username = true;
    } else {
      handleFailed.push(
        `username expected=@${wantHandle} live=@${live.liveHandle || '?'}`
      );
    }

    // Photo is independent — never drives applied_live.
    // Must be profile_images (face), never profile_banners (header CDN).
    const photoFailed = [];
    const avatarIsFace =
      !!live.avatarSrc &&
      /profile_images/i.test(live.avatarSrc) &&
      !/profile_banners/i.test(live.avatarSrc) &&
      !live.isDefaultAvatar;
    if (!attempts.photoAttempted) skipped.push('photo');
    else if (avatarIsFace) {
      verified.photo = true;
    } else {
      photoFailed.push(
        `photo not face profile_images (src=${(live.avatarSrc || '').slice(0, 100)})`
      );
    }

    const bannerFailed = [];
    if (!attempts.bannerAttempted) skipped.push('banner');
    else if (live.hasCustomBanner) {
      verified.banner = true;
    } else {
      bannerFailed.push(`banner not custom (src=${(live.bannerSrc || '').slice(0, 80)})`);
    }

    console.log(
      `X persona ${tag}: verify verified=${JSON.stringify(verified)} ` +
        `skipped=[${skipped.join(',')}] failed=[${failed.concat(handleFailed, photoFailed, bannerFailed).join(' | ')}]`
    );

    if (failed.length || photoFailed.length || handleFailed.length || bannerFailed.length) {
      await page.screenshot({ path: `/tmp/x-persona-verify-fail-${accountId || 'x'}.png` }).catch(() => {});
    }
    if (photoFailed.length) {
      console.warn(`X persona ${tag}: photo not verified — ${photoFailed.join('; ')}`);
    }
    if (handleFailed.length) {
      console.warn(`X persona ${tag}: username not verified — ${handleFailed.join('; ')}`);
    }
    if (bannerFailed.length) {
      console.warn(`X persona ${tag}: banner not verified — ${bannerFailed.join('; ')}`);
    }

    // applied_live ONLY when name AND bio both verified — never photo-only / bio-only
    const appliedLive = !!(verified.display_name && verified.bio);

    return {
      live,
      verified,
      skipped,
      failed,
      photoFailed,
      handleFailed,
      bannerFailed,
      appliedLive,
      photoApplied: !!verified.photo,
      usernameApplied: !!verified.username,
      bannerApplied: !!verified.banner,
    };
  }

  /**
   * LIVE X profile edit (cookie session only — no password login).
   *
   * URL: https://x.com/settings/profile (fallback: Edit profile modal)
   * Safe v1 fields: display name, bio, location, website.
   * Do NOT rename handle in v1.
   *
   * Requires process.env.X_PERSONA_LIVE === '1'
   *
   * Returns attempt flags only — callers must verifyXPersonaLive before applied_live.
   *
   * @param {import('playwright').Page} page — already cookie-restored session
   * @param {{ display_name: string, bio: string, location?: string|null, website?: string|null }} persona
   * @param {{ accountId?: number }} [options]
   */
  async updateXPersona(page, persona, { accountId, username, photoPath = null, bannerPath = null } = {}) {
    if (process.env.X_PERSONA_LIVE !== '1') {
      throw new Error(
        'X profile live edits disabled. Set X_PERSONA_LIVE=1 only after cookie-verify ' +
          'and Oxylabs proxy are confirmed. Offline: update-x-personas.js'
      );
    }
    if (!persona?.display_name || !persona?.bio) {
      throw new Error('persona.display_name and persona.bio are required');
    }

    const fs = require('fs');
    const tag = accountId ? `#${accountId}` : '';
    const setupField = '[data-testid="ocfEnterTextTextInput"]';
    const editBtnSel =
      '[data-testid="editProfileButton"], [aria-label="Edit profile"], [aria-label="Set up profile"]';

    const dialogText = async () =>
      page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]');
        return ((d || document.body).innerText || '').slice(0, 400);
      }).catch(() => '');

    const clickTextButton = async (...labels) => {
      for (const label of labels) {
        const el = await page
          .locator(`button:has-text("${label}"), [role="button"]:has-text("${label}")`)
          .first()
          .elementHandle({ timeout: 1500 })
          .catch(() => null);
        if (!el) continue;
        const visible = await el.isVisible().catch(() => false);
        if (!visible) continue;
        await el.click().catch(() => {});
        await this.humanLikeDelay(1800, 3000);
        return label;
      }
      return null;
    };

    const advanceSetupStep = async () => {
      await this.assertXProfileActionAllowed(page, { accountId });
      const next =
        (await page.$('[data-testid="ocfEnterTextNextButton"]')) ||
        (await page.$('[data-testid="ocfSettingsListNextButton"]')) ||
        (await page
          .locator('[role="dialog"] button:has-text("Next")')
          .first()
          .elementHandle({ timeout: 1500 })
          .catch(() => null));
      if (next) {
        await next.click().catch(() => {});
        await this.humanLikeDelay(1800, 3000);
        return 'next';
      }
      return clickTextButton('Skip for now');
    };

    const fillSetupField = async (value, maxLen) => {
      if (value == null || value === '') return false;
      const el = await page.waitForSelector(setupField, { timeout: 8000 }).catch(() => null);
      if (!el) return false;
      await this.randomMouseMove(page);
      await this.humanLikeDelay(600, 1400);
      return this.humanTypeInto(el, String(value).slice(0, maxLen), { clear: true, confirm: true });
    };

    let nameAttempted = false;
    let bioAttempted = false;
    let photoAttempted = false;
    let bannerAttempted = false;

    // Prefer sidebar navigation from an already-warmed feed session (no URL teleport).
    console.log(`X persona ${tag}: opening own profile via sidebar (human path)`);
    if (!/x\.com|twitter\.com/i.test(page.url() || '')) {
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.humanLikeDelay(2000, 3500);
    }
    if (!/x\.com|twitter\.com/i.test(page.url() || '')) {
      throw new Error('proxy_error: cannot open profile — page still blank');
    }
    await this.randomMouseMove(page);
    await this.humanLikeDelay(800, 1600);
    const profileLink =
      (await page.$('[data-testid="AppTabBar_Profile_Link"]')) ||
      (await page.locator('a[aria-label="Profile"]').first().elementHandle().catch(() => null));
    if (!profileLink) {
      await page.waitForSelector('[data-testid="AppTabBar_Profile_Link"]', { timeout: 20000 });
    }
    const profileEl = profileLink || (await page.$('[data-testid="AppTabBar_Profile_Link"]'));
    if (!profileEl) throw new Error('X Profile sidebar link not found');
    await this.randomMouseMove(page);
    await profileEl.click();
    await this.humanLikeDelay(3500, 6000);
    await this.simulateHumanBehavior(page);
    await this.assertXProfileActionAllowed(page, { accountId });
    await this.humanLikeDelay(1200, 2400);

    // Profile column often spins for 10–30s on residential proxies — wait before giving up
    let editBtn = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await page
        .waitForSelector(editBtnSel, { timeout: attempt === 1 ? 30000 : 18000 })
        .catch(() => null);
      editBtn =
        (await page.$(editBtnSel)) ||
        (await page
          .locator(
            'button:has-text("Set up profile"), button:has-text("Edit profile"), [role="button"]:has-text("Set up profile"), [role="button"]:has-text("Edit profile")'
          )
          .first()
          .elementHandle({ timeout: 2000 })
          .catch(() => null)) ||
        (await page
          .locator(
            'button:has-text("Complete your profile"), a:has-text("Complete your profile"), [role="button"]:has-text("Complete your profile")'
          )
          .first()
          .elementHandle({ timeout: 2000 })
          .catch(() => null));
      if (editBtn) break;

      const stillLoading = await page
        .evaluate(() => {
          const col =
            document.querySelector('[data-testid="primaryColumn"]') ||
            document.querySelector('main');
          if (!col) return true;
          const text = (col.innerText || '').trim();
          const hasName = !!col.querySelector('[data-testid="UserName"]');
          return !hasName && text.length < 40;
        })
        .catch(() => false);

      if (!stillLoading && attempt >= 2) break;

      console.warn(`X persona ${tag}: Edit/Set up not ready (attempt ${attempt}/3) — retry via sidebar`);
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await this.humanLikeDelay(2000, 3500);
      const again =
        (await page.$('[data-testid="AppTabBar_Profile_Link"]')) ||
        (await page.locator('a[aria-label="Profile"]').first().elementHandle().catch(() => null));
      if (again) {
        await again.click().catch(() => {});
        await this.humanLikeDelay(4000, 7000);
      }
      await this.assertXProfileActionAllowed(page, { accountId });
    }

    if (!editBtn) {
      await page.screenshot({ path: `/tmp/x-persona-noform-${accountId || 'x'}.png` }).catch(() => {});
      throw new Error('X Set up / Edit profile button not found');
    }
    await editBtn.click();
    await this.humanLikeDelay(2500, 4000);
    await this.assertXProfileActionAllowed(page, { accountId });

    // --- setup_profile onboarding (warmed / incomplete accounts) ---
    const onSetup = /\/i\/flow\/setup_profile/i.test(page.url()) ||
      /Pick a profile picture|Describe yourself|Where do you live/i.test(await dialogText());

    if (onSetup) {
      console.log(`X persona ${tag}: setup_profile flow`);

      // Photo
      let text = await dialogText();
      if (/profile picture|selfie/i.test(text)) {
        const fileInput = await page.$('input[data-testid="fileInput"], input[type="file"]');
        if (photoPath && fs.existsSync(photoPath) && fileInput) {
          await fileInput.setInputFiles(photoPath);
          await this.humanLikeDelay(2500, 4000);
          const apply =
            (await page.$('[data-testid="applyButton"]')) ||
            (await page.locator('button:has-text("Apply")').first().elementHandle().catch(() => null));
          if (apply) {
            await apply.click().catch(() => {});
            await this.humanLikeDelay(1500, 2500);
          }
          await this.assertXProfileActionAllowed(page, { accountId });
          // After crop, flow usually advances; otherwise Next
          await advanceSetupStep();
          photoAttempted = true;
          console.log(`X persona ${tag}: photo upload attempted in setup (unverified)`);
        } else {
          await clickTextButton('Skip for now');
        }
      }

      // Header / banner — setup step should only show header picker; still refuse avatar-labeled inputs
      text = await dialogText();
      if (/Pick a header|header/i.test(text)) {
        if (bannerPath && fs.existsSync(bannerPath)) {
          try {
            const fileInputs = await page.$$('input[data-testid="fileInput"], input[type="file"]');
            let bannerInput = null;
            for (const input of fileInputs) {
              const lab = await input
                .evaluate((el) => {
                  let n = el;
                  for (let i = 0; i < 8 && n; i++) {
                    const a = n.getAttribute && n.getAttribute('aria-label');
                    if (a) return a;
                    n = n.parentElement;
                  }
                  return '';
                })
                .catch(() => '');
              if (/avatar|profile photo/i.test(lab) && !/banner|header/i.test(lab)) continue;
              if (/banner|header/i.test(lab) || !lab) {
                bannerInput = input;
                if (/banner|header/i.test(lab)) break;
              }
            }
            if (!bannerInput) throw new Error('setup header file input not found');
            await bannerInput.setInputFiles(bannerPath);
            await this.humanLikeDelay(2500, 4000);
            const apply =
              (await page.$('[data-testid="applyButton"]')) ||
              (await page.locator('button:has-text("Apply")').first().elementHandle().catch(() => null));
            if (apply) {
              await apply.click().catch(() => {});
              await this.humanLikeDelay(1500, 2500);
            }
            await advanceSetupStep();
            bannerAttempted = true;
            console.log(`X persona ${tag}: banner upload attempted in setup (unverified)`);
          } catch (e) {
            console.warn(`X persona ${tag}: setup banner skipped — ${e.message}`);
            await clickTextButton('Skip for now');
          }
        } else {
          await clickTextButton('Skip for now');
        }
      }

      // Bio
      text = await dialogText();
      if (/Describe yourself|Your bio/i.test(text) || (await page.$(`textarea${setupField}`))) {
        bioAttempted = await fillSetupField(persona.bio, 160);
        await advanceSetupStep();
      }

      // Location
      text = await dialogText();
      if (/Where do you live|Location/i.test(text) || (await page.$(`input${setupField}`))) {
        if (persona.location) {
          await fillSetupField(persona.location, 30);
          await advanceSetupStep();
        } else {
          await clickTextButton('Skip for now');
        }
      }

      // Save
      text = await dialogText();
      const saved = await clickTextButton('Save');
      if (!saved) {
        const saveBtn =
          (await page.$('[data-testid="Profile_Save_Button"]')) ||
          (await page.locator('[role="dialog"] button:has-text("Save")').first().elementHandle().catch(() => null));
        if (saveBtn) {
          await saveBtn.click().catch(() => {});
          await this.humanLikeDelay(2500, 4000);
        }
      }
      await this.assertXProfileActionAllowed(page, { accountId });
      await page.screenshot({ path: `/tmp/x-persona-saved-${accountId || 'x'}.png` }).catch(() => {});
      console.log(`X persona ${tag}: setup saved bio/location (display_name may need Edit pass)`);

      // Second pass: classic Edit profile modal for Name + Bio (authoritative path)
      await this.humanLikeDelay(2000, 3000);
      // Sidebar Profile — never teleport via DB username (handles get renamed)
      const profileLinkAgain =
        (await page.$('[data-testid="AppTabBar_Profile_Link"]')) ||
        (await page.locator('a[aria-label="Profile"]').first().elementHandle().catch(() => null));
      if (profileLinkAgain) {
        await profileLinkAgain.click().catch(() => {});
      } else if (username) {
        await page.goto(`https://x.com/${username}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      } else {
        await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await page.waitForSelector('[data-testid="AppTabBar_Profile_Link"]', { timeout: 20000 }).catch(() => null);
        await page.click('[data-testid="AppTabBar_Profile_Link"]').catch(() => {});
      }
      await this.humanLikeDelay(2500, 4000);
      await this.assertXProfileActionAllowed(page, { accountId });
      const editAgain =
        (await page.$('[data-testid="editProfileButton"]')) ||
        (await page.locator('button:has-text("Edit profile")').first().elementHandle().catch(() => null));
      if (!editAgain) {
        console.warn(`X persona ${tag}: Edit profile not available after setup — name/bio unverified`);
        console.log(
          `X persona ${tag}: attempts name=${nameAttempted} bio=${bioAttempted} photo=${photoAttempted} banner=${bannerAttempted}`
        );
        return { nameAttempted, bioAttempted, photoAttempted, bannerAttempted };
      }
      await editAgain.click();
      await this.humanLikeDelay(2000, 3500);
      await this.assertXProfileActionAllowed(page, { accountId });

      const nameElHandle = await page.evaluateHandle(() => {
        const dialog = document.querySelector('[role="dialog"]') || document.body;
        let nameEl =
          dialog.querySelector('input[name="displayName"]') ||
          dialog.querySelector('input[name="name"]') ||
          dialog.querySelector('input[data-testid="DisplayNameInput"]');
        if (!nameEl) {
          const inputs = Array.from(dialog.querySelectorAll('input[type="text"], input:not([type])'));
          nameEl =
            inputs.find((el) => {
              const labeled =
                (el.getAttribute('aria-label') || '') +
                ' ' +
                (el.getAttribute('placeholder') || '') +
                ' ' +
                (el.labels && el.labels[0] ? el.labels[0].innerText : '');
              return /\bname\b/i.test(labeled) && !/user.?name|handle|location|website|url/i.test(labeled);
            }) || null;
        }
        return nameEl;
      });
      const nameEl = nameElHandle.asElement();
      if (!nameEl) {
        await page.screenshot({ path: `/tmp/x-persona-noform-${accountId || 'x'}.png` }).catch(() => {});
        throw new Error('X Edit profile Name input not found after setup');
      }
      nameAttempted = await this.humanTypeInto(nameEl, persona.display_name.slice(0, 50), {
        clear: true,
        confirm: true,
      });
      if (!nameAttempted) {
        throw new Error('X Edit profile Name input did not accept persona.display_name');
      }

      const bioEl =
        (await page.$('[role="dialog"] textarea[name="description"]')) ||
        (await page.$('[role="dialog"] textarea[data-testid="Account_description"]')) ||
        (await page.$('[role="dialog"] textarea[name="bio"]')) ||
        (await page.locator('[role="dialog"] textarea').first().elementHandle().catch(() => null));
      if (bioEl) {
        bioAttempted = await this.humanTypeInto(bioEl, persona.bio.slice(0, 160), {
          clear: true,
          confirm: true,
        });
      }
      if (!bioAttempted) {
        throw new Error('X Edit profile Bio input did not accept persona.bio');
      }

      await page.screenshot({ path: `/tmp/x-persona-presave-${accountId || 'x'}.png` }).catch(() => {});
      const savedEdit = await clickTextButton('Save');
      if (!savedEdit) {
        const saveBtn =
          (await page.$('[data-testid="Profile_Save_Button"]')) ||
          (await page.$('[data-testid="settingsDetailSave"]')) ||
          (await page.locator('[role="dialog"] button:has-text("Save")').first().elementHandle().catch(() => null));
        if (!saveBtn) throw new Error('X profile Save button not found after Edit fill');
        await saveBtn.click().catch(() => {});
        await this.humanLikeDelay(3000, 5500);
      }
      await this.assertXProfileActionAllowed(page, { accountId });
      await page.screenshot({ path: `/tmp/x-persona-saved-${accountId || 'x'}.png` }).catch(() => {});
      console.log(`X persona ${tag}: Edit profile name+bio submitted (unverified)`);

      console.log(
        `X persona ${tag}: attempts name=${nameAttempted} bio=${bioAttempted} photo=${photoAttempted} banner=${bannerAttempted}`
      );
      return { nameAttempted, bioAttempted, photoAttempted, bannerAttempted };
    }

    // --- Classic Edit profile modal ---
    console.log(`X persona ${tag}: classic edit modal`);
    const fillField = async (selectors, value, label) => {
      if (value == null || value === '') return false;
      for (const sel of selectors) {
        const el = await page.$(sel);
        if (!el) continue;
        const visible = await el.isVisible().catch(() => false);
        if (!visible) continue;
        await this.randomMouseMove(page);
        await this.humanLikeDelay(700, 1600);
        const ok = await this.humanTypeInto(
          el,
          String(value).slice(0, label === 'bio' ? 160 : 50),
          { clear: true, confirm: true }
        );
        if (ok) return true;
      }
      console.warn(`X persona ${tag}: could not fill ${label}`);
      return false;
    };

    // Name only — never fall back to first text input (that hits Location/URL)
    nameAttempted = await fillField(
      [
        '[role="dialog"] input[name="displayName"]',
        '[role="dialog"] input[data-testid="DisplayNameInput"]',
        '[role="dialog"] input[name="name"]',
        'input[name="displayName"]',
        'input[data-testid="DisplayNameInput"]',
        'input[name="name"]',
      ],
      persona.display_name.slice(0, 50),
      'display_name'
    );
    if (!nameAttempted) {
      await page.screenshot({ path: `/tmp/x-persona-noform-${accountId || 'x'}.png` }).catch(() => {});
      throw new Error('X profile edit form not found (display name input) or value did not stick');
    }
    bioAttempted = await fillField(
      [
        '[role="dialog"] textarea[name="description"]',
        '[role="dialog"] textarea[data-testid="Account_description"]',
        '[role="dialog"] textarea[name="bio"]',
        'textarea[name="description"]',
        'textarea[data-testid="Account_description"]',
        'textarea[name="bio"]',
      ],
      persona.bio.slice(0, 160),
      'bio'
    );
    if (!bioAttempted) {
      await page.screenshot({ path: `/tmp/x-persona-nobio-${accountId || 'x'}.png` }).catch(() => {});
      throw new Error('X profile bio input not found or value did not stick');
    }
    await fillField(
      ['input[name="location"]', 'input[data-testid="LocationInput"]'],
      persona.location,
      'location'
    );
    await fillField(
      ['input[name="url"]', 'input[name="website"]', 'input[data-testid="URLInput"]'],
      persona.website,
      'website'
    );

    // saveProfile:false — crop Apply only; one Profile Save at end (mid-edit Save closes modal).
    if (photoPath && fs.existsSync(photoPath)) {
      try {
        console.log(`X persona ${tag}: uploading avatar (defer profile Save)`);
        await this._setXAvatarInputFiles(page, photoPath, { accountId, saveProfile: false });
        photoAttempted = true;
      } catch (photoErr) {
        console.warn(`X persona ${tag}: avatar upload skipped — ${photoErr.message}`);
      }
    }

    // Banner / header — MUST use banner/header control only (never avatar file input)
    if (bannerPath && fs.existsSync(bannerPath)) {
      try {
        console.log(`X persona ${tag}: uploading banner (defer profile Save)`);
        await this._setXBannerInputFiles(page, bannerPath, { accountId, saveProfile: false });
        bannerAttempted = true;
      } catch (bannerErr) {
        console.warn(`X persona ${tag}: banner upload skipped — ${bannerErr.message}`);
      }
    }

    await page.screenshot({ path: `/tmp/x-persona-presave-${accountId || 'x'}.png` }).catch(() => {});
    await this.humanLikeDelay(1200, 2500);
    await this.randomMouseMove(page);
    console.log(`X persona ${tag}: looking for profile Save`);
    let save =
      (await page.$('[data-testid="settingsDetailSave"]')) ||
      (await page.$('[data-testid="Profile_Save_Button"]')) ||
      (await page
        .locator('[role="dialog"] button:has-text("Save")')
        .first()
        .elementHandle({ timeout: 2000 })
        .catch(() => null));
    if (!save) {
      const viaEval = await page.evaluateHandle(() => {
        const buttons = [...document.querySelectorAll('button, [role="button"]')];
        return (
          buttons.find((b) => {
            const t = (b.innerText || b.getAttribute('aria-label') || '').trim();
            return /^Save$/i.test(t) && !b.disabled && b.offsetParent !== null;
          }) || null
        );
      });
      save = viaEval && viaEval.asElement ? viaEval.asElement() : null;
    }
    if (!save) {
      // Modal may have auto-closed after fill; treat as soft-ok if profile shows the name.
      const liveName = await page.evaluate(() => {
        const h = document.querySelector('[data-testid="UserName"] span, h2 span');
        return (h && h.textContent ? h.textContent : '').trim();
      }).catch(() => '');
      const want = String(persona.display_name || '').trim();
      if (want && liveName && liveName.toLowerCase().includes(want.split(' ')[0].toLowerCase())) {
        console.log(
          `X persona ${tag}: Save missing but profile shows "${liveName}" — soft-ok name/bio`
        );
        return { nameAttempted, bioAttempted, photoAttempted, bannerAttempted, softSaved: true };
      }
      await page.screenshot({ path: `/tmp/x-persona-nosave-${accountId || 'x'}.png` }).catch(() => {});
      throw new Error('X profile Save button not found');
    }
    await this.humanLikeDelay(800, 1800);
    await save.click();
    await this.humanLikeDelay(3000, 5500);
    await this.assertXProfileActionAllowed(page, { accountId });
    await page.screenshot({ path: `/tmp/x-persona-saved-${accountId || 'x'}.png` }).catch(() => {});
    console.log(
      `X persona ${tag}: edit submitted name="${persona.display_name}" ` +
        `(attempts name=${nameAttempted} bio=${bioAttempted} photo=${photoAttempted} banner=${bannerAttempted}; unverified)`
    );
    return { nameAttempted, bioAttempted, photoAttempted, bannerAttempted };
  }

  /**
   * Click banner OR avatar media control and set files via filechooser (preferred)
   * or a label-classified file input. Never cross-wires avatar ↔ banner.
   */
  async _setXProfileMediaFiles(page, kind, filePath, { accountId, saveProfile = true } = {}) {
    const wantBanner = kind === 'banner';
    const btnSelectors = wantBanner
      ? [
          '[aria-label*="Add banner" i]',
          '[aria-label*="Edit banner" i]',
          '[aria-label*="banner photo" i]',
          '[aria-label*="Add a header" i]',
          '[aria-label*="Edit header" i]',
          '[aria-label*="header photo" i]',
          '[aria-label*="Add header" i]',
        ]
      : [
          '[aria-label*="Add avatar" i]',
          '[aria-label*="Edit avatar" i]',
          '[aria-label*="profile photo" i]',
          '[aria-label*="Add a profile photo" i]',
          '[aria-label*="Edit profile photo" i]',
        ];

    let btn = null;
    for (const sel of btnSelectors) {
      const el = await page.$(sel);
      if (!el) continue;
      const label = ((await el.getAttribute('aria-label').catch(() => '')) || '').toLowerCase();
      if (wantBanner && /avatar|profile photo|profile picture/.test(label) && !/banner|header/.test(label)) {
        continue;
      }
      if (!wantBanner && /banner|header/.test(label)) continue;
      btn = el;
      break;
    }
    if (!btn) {
      throw new Error(
        wantBanner
          ? 'X banner/header control not found (refusing avatar file input)'
          : 'X avatar control not found'
      );
    }

    const btnLabel = ((await btn.getAttribute('aria-label').catch(() => '')) || '').toLowerCase();
    if (wantBanner && !/banner|header/.test(btnLabel)) {
      throw new Error(`Refusing non-banner control for header upload: "${btnLabel}"`);
    }
    if (!wantBanner && /banner|header/.test(btnLabel) && !/avatar|profile photo/.test(btnLabel)) {
      throw new Error(`Refusing banner control for avatar upload: "${btnLabel}"`);
    }

    // Prefer native filechooser from the clicked control — no ambiguous input[0] fallback.
    // Attach catch on the waiter FIRST so a missed chooser never becomes an unhandled rejection.
    let usedChooser = false;
    const chooserPromise = page
      .waitForEvent('filechooser', { timeout: 8000 })
      .catch(() => null);
    await btn.click().catch(() => {});
    const chooser = await chooserPromise;
    if (chooser) {
      await chooser.setFiles(filePath);
      usedChooser = true;
    }

    if (!usedChooser) {
      const fileInput = await this._resolveXProfileMediaInput(page, kind, btn);
      await fileInput.setInputFiles(filePath);
    }

    await this.humanLikeDelay(2500, 4000);
    await this._applyXMediaCropAndSave(page, { saveProfile });
    await this.assertXProfileActionAllowed(page, { accountId });
  }

  /**
   * Resolve the Edit-profile file input for banner OR avatar — never confuse the two.
   * kind: 'banner' | 'avatar'
   */
  async _resolveXProfileMediaInput(page, kind, preferredBtn = null) {
    const wantBanner = kind === 'banner';

    // Best fallback: file input nested under / beside the control we already clicked.
    if (preferredBtn) {
      const related = await preferredBtn.evaluateHandle((btn) => {
        let n = btn;
        for (let i = 0; i < 8 && n; i++) {
          const input = n.querySelector && n.querySelector('input[type="file"]');
          if (input) return input;
          n = n.parentElement;
        }
        const root = btn.closest?.('[role="dialog"]') || document;
        // Among dialog inputs, pick the one closest to this button in DOM order near banner/avatar region
        return null;
      });
      const el = related && related.asElement ? related.asElement() : null;
      if (el) {
        const lab = await el
          .evaluate((input) => {
            let n = input;
            for (let i = 0; i < 10 && n; i++) {
              const a = n.getAttribute && n.getAttribute('aria-label');
              if (a) return a;
              n = n.parentElement;
            }
            return '';
          })
          .catch(() => '');
        const bad =
          (wantBanner && /avatar|profile photo|profile picture/i.test(lab) && !/banner|header/i.test(lab)) ||
          (!wantBanner && /banner|header/i.test(lab) && !/avatar|profile photo/i.test(lab));
        if (!bad) return el;
      }
    }

    const handle = await page.evaluateHandle(
      ({ wantBannerInner }) => {
        const isBannerLabel = (s) => /banner|header/.test(String(s || '').toLowerCase());
        const isAvatarLabel = (s) =>
          /avatar|profile photo|profile picture/.test(String(s || '').toLowerCase()) &&
          !isBannerLabel(s);

        const labelNear = (el) => {
          let n = el;
          for (let i = 0; i < 10 && n; i++) {
            const a = n.getAttribute && n.getAttribute('aria-label');
            if (a) return a;
            n = n.parentElement;
          }
          return '';
        };

        const inputs = [...document.querySelectorAll('input[type="file"]')];
        const scored = inputs.map((input, idx) => {
          const label = labelNear(input);
          let score = 0;
          if (wantBannerInner) {
            if (isBannerLabel(label)) score += 100;
            if (isAvatarLabel(label)) score -= 200;
          } else {
            if (isAvatarLabel(label)) score += 100;
            if (isBannerLabel(label)) score -= 200;
          }
          return { input, score, label, idx };
        });
        scored.sort((a, b) => b.score - a.score);
        const best = scored[0];
        if (!best || best.score < 50) return null;
        if (wantBannerInner && isAvatarLabel(best.label)) return null;
        if (!wantBannerInner && isBannerLabel(best.label)) return null;
        return best.input;
      },
      { wantBannerInner: wantBanner }
    );

    const fileInput = handle && handle.asElement ? handle.asElement() : null;
    if (!fileInput) {
      throw new Error(
        wantBanner
          ? 'X banner file input not found (refusing to use avatar input)'
          : 'X avatar file input not found'
      );
    }
    return fileInput;
  }

  async _applyXMediaCropAndSave(page, { saveProfile = true } = {}) {
    const apply =
      (await page.$('[data-testid="applyButton"]')) ||
      (await page
        .locator('button:has-text("Apply")')
        .first()
        .elementHandle({ timeout: 1500 })
        .catch(() => null));
    if (apply) {
      await apply.click().catch(() => {});
      await this.humanLikeDelay(1500, 2500);
    }
    if (!saveProfile) return;
    const save =
      (await page.$('[data-testid="settingsDetailSave"]')) ||
      (await page.$('[data-testid="Profile_Save_Button"]')) ||
      (await page
        .locator('button:has-text("Save")')
        .first()
        .elementHandle({ timeout: 1500 })
        .catch(() => null));
    if (save) {
      await save.click().catch(() => {});
      await this.humanLikeDelay(2500, 4000);
    }
  }

  async _setXBannerInputFiles(page, bannerPath, { accountId, saveProfile = true } = {}) {
    await this._setXProfileMediaFiles(page, 'banner', bannerPath, { accountId, saveProfile });
  }

  async _setXAvatarInputFiles(page, photoPath, { accountId, saveProfile = true } = {}) {
    await this._setXProfileMediaFiles(page, 'avatar', photoPath, { accountId, saveProfile });
  }

  /**
   * Upload X avatar from a local image (cookie session, allowLogin=false).
   * Returns { photoAttempted } only — caller must verify live avatar.
   */
  async updateXProfilePhoto(page, photoPath, { accountId, username } = {}) {
    const fs = require('fs');
    if (!photoPath || !fs.existsSync(photoPath)) {
      throw new Error(`Photo not found: ${photoPath}`);
    }
    const tag = accountId ? `#${accountId}` : '';

    const openEdit = async (url) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await this.humanLikeDelay(2000, 3500);
      await this.assertXProfileActionAllowed(page, { accountId });
      const editBtn =
        (await page.$('[data-testid="editProfileButton"]')) ||
        (await page.$('[aria-label="Edit profile"]'));
      if (editBtn) {
        await editBtn.click().catch(() => {});
        await this.humanLikeDelay(1500, 2500);
      }
      await this.assertXProfileActionAllowed(page, { accountId });
    };

    if (username) await openEdit(`https://x.com/${username}`);
    else await openEdit('https://x.com/settings/profile');

    await this._setXAvatarInputFiles(page, photoPath, { accountId });
    await page.screenshot({ path: `/tmp/x-avatar-done-${accountId || 'x'}.png` }).catch(() => {});
    console.log(`X persona ${tag}: avatar upload attempted from ${photoPath} (unverified)`);
    return { photoAttempted: true };
  }

  /**
   * Upload X profile banner/header image (cookie session only).
   * bannerPath MUST be a landscape header from private/x-banners — never a face/portrait.
   * NEVER writes to the avatar file input.
   */
  async updateXProfileBanner(page, bannerPath, { accountId, username } = {}) {
    const fs = require('fs');
    const path = require('path');
    if (!bannerPath || !fs.existsSync(bannerPath)) {
      throw new Error(`Banner not found: ${bannerPath}`);
    }
    const resolved = path.resolve(bannerPath);
    if (
      /linkedin-photos|[/\\]x-photos[/\\]|pilot-|portrait/i.test(resolved) ||
      !/x-banners/i.test(resolved)
    ) {
      throw new Error(
        `Refusing face/portrait as X banner (path must be under x-banners/): ${bannerPath}`
      );
    }
    const tag = accountId ? `#${accountId}` : '';

    const openEdit = async (url) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await this.humanLikeDelay(2000, 3500);
      await this.assertXProfileActionAllowed(page, { accountId });
      const editBtn =
        (await page.$('[data-testid="editProfileButton"]')) ||
        (await page.$('[aria-label="Edit profile"]'));
      if (editBtn) {
        await editBtn.click().catch(() => {});
        await this.humanLikeDelay(1500, 2500);
      }
      await this.assertXProfileActionAllowed(page, { accountId });
    };

    if (username) await openEdit(`https://x.com/${username}`);
    else await openEdit('https://x.com/settings/profile');

    await this._setXBannerInputFiles(page, bannerPath, { accountId });
    await page.screenshot({ path: `/tmp/x-banner-done-${accountId || 'x'}.png` }).catch(() => {});
    console.log(`X persona ${tag}: banner upload attempted from ${bannerPath} (unverified)`);
    return { bannerAttempted: true };
  }

  /**
   * Confirm password when X asks after username Save.
   * One-shot password use for settings rename only — never for organic browsing.
   */
  async confirmXPasswordIfPrompted(page, password, { accountId } = {}) {
    const tag = accountId ? `#${accountId}` : '';
    if (!password || !String(password).trim()) {
      return { confirmed: false, reason: 'no_password' };
    }
    const pwInput =
      (await page.$('input[name="password"], input[type="password"], input[autocomplete="current-password"]')) ||
      (await page
        .locator('input[type="password"]')
        .first()
        .elementHandle()
        .catch(() => null));
    if (!pwInput || !(await pwInput.isVisible().catch(() => false))) {
      return { confirmed: false, reason: 'no_prompt' };
    }
    console.log(`X persona ${tag}: password confirm for username change`);
    await this.humanTypeInto(pwInput, String(password), { clear: true, confirm: false });
    await this.humanLikeDelay(400, 900);
    const confirmBtn =
      (await page.$('[data-testid="confirmationSheetConfirm"]')) ||
      (await page
        .locator(
          'button:has-text("Confirm"), button:has-text("Save"), button:has-text("Next"), button:has-text("Verify"), button:has-text("Done")'
        )
        .first()
        .elementHandle()
        .catch(() => null));
    if (confirmBtn) {
      await confirmBtn.click().catch(() => {});
      await this.humanLikeDelay(2500, 4500);
    }
    const body = await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
    if (/wrong password|incorrect password|incorrect\.? try again|couldn.?t verify/i.test(body)) {
      throw new Error('x_username_bad_password: password rejected on username change');
    }
    if (/locked|suspended|unusual activity|verify your identity|temporarily locked/i.test(body)) {
      throw new Error(`account_locked: ${body.slice(0, 160)}`);
    }
    return { confirmed: true };
  }

  /**
   * Rename X @handle via settings/screen_name (cookie session).
   * Prefer input[name="typedScreenName"]. Password/TOTP ONLY if X prompts mid-rename.
   */
  async updateXUsername(
    page,
    newUsername,
    { accountId, currentUsername, password = null, totpSecret = null } = {}
  ) {
    const want = String(newUsername || '').replace(/^@/, '').trim();
    if (!want || want.length < 4 || want.length > 15) {
      throw new Error(`Invalid X username: ${newUsername}`);
    }
    if (!/^[A-Za-z0-9_]+$/.test(want)) {
      throw new Error(`Invalid X username chars: ${want}`);
    }
    const tag = accountId ? `#${accountId}` : '';
    const cur = String(currentUsername || '').replace(/^@/, '');
    if (cur && cur.toLowerCase() === want.toLowerCase()) {
      console.log(`X persona ${tag}: username already @${want}`);
      return { usernameAttempted: true, alreadySet: true, requestedUsername: want };
    }

    console.log(`X persona ${tag}: renaming handle → @${want} via typedScreenName`);
    await page.goto('https://x.com/settings/screen_name', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await this.humanLikeDelay(1500, 2500);
    await this.assertXProfileActionAllowed(page, { accountId });

    // Prefer typedScreenName (X settings). Never fall back to first text input —
    // that is often the Settings search box and silently no-ops the rename.
    const findUsernameInput = async () =>
      (await page.$('input[name="typedScreenName"]')) ||
      (await page.$('input[name="username"], input[name="screen_name"], input[autocomplete="username"]')) ||
      null;

    let input = await findUsernameInput();
    if (!input) {
      await page.waitForSelector('input[name="typedScreenName"]', { timeout: 20000 }).catch(() => null);
      input = await findUsernameInput();
    }

    if (!input) {
      await page.goto('https://x.com/settings/account', {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      }).catch(() => {});
      await this.humanLikeDelay(1500, 2800);
      const link =
        (await page.$('a[href*="screen_name"]')) ||
        (await page.locator('a:has-text("Username"), span:has-text("Username")').first().elementHandle().catch(() => null));
      if (link) {
        await link.click().catch(() => {});
        await this.humanLikeDelay(1500, 2800);
      }
      await page.waitForSelector('input[name="typedScreenName"]', { timeout: 15000 }).catch(() => null);
      input = await findUsernameInput();
    }

    if (!input) {
      await page.screenshot({ path: `/tmp/x-username-noinput-${accountId || 'x'}.png` }).catch(() => {});
      console.warn(`X persona ${tag}: typedScreenName not found — skipping rename`);
      return { usernameAttempted: false };
    }

    let requested = want;
    await this.humanTypeInto(input, want, { clear: true, confirm: true });
    await this.humanLikeDelay(1200, 2200);

    const body = await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
    if (/taken|already exists|not available|unavailable/i.test(body)) {
      const alt = `${want.replace(/_+$/, '').slice(0, 11)}_${Math.floor(Math.random() * 90 + 10)}`.slice(0, 15);
      console.warn(`X persona ${tag}: @${want} taken — trying @${alt}`);
      await this.humanTypeInto(input, alt, { clear: true, confirm: true });
      await this.humanLikeDelay(1200, 2200);
      requested = alt;
    }

    const save =
      (await page.$('[data-testid="settingsDetailSave"]')) ||
      (await page.locator('button:has-text("Save"), button:has-text("Next"), button:has-text("Done")').first().elementHandle().catch(() => null));
    if (save) {
      const disabled = await save.isDisabled().catch(() => false);
      if (!disabled) {
        await save.click().catch(() => {});
        await this.humanLikeDelay(2500, 4000);
      }
    }

    // Password only if X explicitly demands it mid-rename (cookie alone usually works)
    const pwResult = await this.confirmXPasswordIfPrompted(page, password, { accountId });
    if (pwResult.reason === 'no_password') {
      const stillPw = await page.$('input[type="password"]');
      if (stillPw && (await stillPw.isVisible().catch(() => false))) {
        throw new Error('x_username_needs_password: no credentials.password for username change');
      }
    }
    // TOTP only if challenged after password confirm — never as password substitute
    if (totpSecret) {
      const totpHandled = await this.handleXTotpChallenge(page, currentUsername || want, {
        totpSecret,
      }).catch(() => false);
      if (totpHandled) await this.humanLikeDelay(1500, 2500);
    }

    // Verify typedScreenName value stuck
    const afterVal = await page
      .evaluate(() => document.querySelector('input[name="typedScreenName"]')?.value || '')
      .catch(() => '');
    const verifiedLocal =
      afterVal && afterVal.replace(/^@/, '').toLowerCase() === requested.toLowerCase();

    await this.assertXProfileActionAllowed(page, { accountId });
    await page.screenshot({ path: `/tmp/x-username-done-${accountId || 'x'}.png` }).catch(() => {});
    console.log(
      `X persona ${tag}: username rename → @${requested}` +
        (verifiedLocal ? ' (input verified)' : afterVal ? ` (input=@${afterVal})` : '')
    );
    return {
      usernameAttempted: true,
      requestedUsername: requested,
      passwordConfirmed: !!pwResult.confirmed,
      inputVerified: !!verifiedLocal,
    };
  }

  /**
   * Restore avatar (portrait) then set scenic banner — cookie session only.
   * Opens Edit profile once and applies both media controls in the same modal.
   */
  async applyXAvatarAndBannerLive(
    accountId,
    { photoPath, bannerPath, requireProxy = true } = {}
  ) {
    if (process.env.X_PERSONA_LIVE !== '1') {
      throw new Error('Set X_PERSONA_LIVE=1 to run live X media edits');
    }
    if (!photoPath) throw new Error('photoPath required to restore avatar');
    if (!bannerPath) throw new Error('bannerPath required for scenic header');
    let browser;
    try {
      const account = await this.getAccount(accountId);
      if (account.platform !== 'x') {
        throw new Error(`Account ${accountId} is ${account.platform}, expected x`);
      }
      const creds =
        typeof account.credentials === 'string'
          ? JSON.parse(account.credentials)
          : account.credentials || {};
      const persona = creds.x_persona || {};
      const accountPassword =
        (creds.password && String(creds.password).trim()) ||
        (creds.pass && String(creds.pass).trim()) ||
        null;

      await this.requireProxyForLive(accountId);
      const result = await this.createBrowserForAccount(accountId, 2, { requireProxy });
      browser = result.browser;
      const page = result.page;

      const loggedIn = await this.ensureLoggedIn(
        page,
        'x',
        accountId,
        account.username,
        accountPassword,
        { allowLogin: false, totpSecret: creds.totp_secret }
      );
      if (!loggedIn) throw new Error(`no_live_session for x/${account.username}`);

      await this.humanBrowseXSession(page, { accountId });
      // Tunnel/browse can leave about:blank — recover before media edits.
      if (!/x\.com|twitter\.com/i.test(page.url() || '')) {
        await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await this.humanLikeDelay(2000, 3500);
      }
      await this.assertXProfileActionAllowed(page, { accountId });
      console.log(`X #${accountId}: opening own profile via sidebar for media restore`);
      if (!/x\.com|twitter\.com/i.test(page.url() || '')) {
        await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await this.humanLikeDelay(2000, 3500);
      }
      let opened = false;
      try {
        const profileLink =
          (await page.$('[data-testid="AppTabBar_Profile_Link"]')) ||
          (await page.locator('a[aria-label="Profile"]').first().elementHandle().catch(() => null));
        if (!profileLink) {
          await page.waitForSelector('[data-testid="AppTabBar_Profile_Link"]', { timeout: 15000 });
        }
        const profileEl = profileLink || (await page.$('[data-testid="AppTabBar_Profile_Link"]'));
        if (profileEl) {
          await profileEl.click().catch(() => {});
          await this.humanLikeDelay(2500, 4000);
          opened = /x\.com|twitter\.com/i.test(page.url() || '');
        }
      } catch (sidebarErr) {
        console.warn(`X #${accountId}: sidebar profile failed — ${sidebarErr.message}`);
      }

      const editBtnSel =
        '[data-testid="editProfileButton"], [aria-label="Edit profile"], [aria-label="Set up profile"]';
      let editBtn =
        (await page.$(editBtnSel)) ||
        (await page
          .locator('button:has-text("Edit profile"), button:has-text("Set up profile")')
          .first()
          .elementHandle()
          .catch(() => null));
      if (!editBtn && opened) {
        await page.waitForSelector(editBtnSel, { timeout: 12000 }).catch(() => null);
        editBtn =
          (await page.$(editBtnSel)) ||
          (await page
            .locator('button:has-text("Edit profile"), button:has-text("Set up profile")')
            .first()
            .elementHandle()
            .catch(() => null));
      }

      if (!editBtn) {
        // Do NOT swallow tunnel failures — let classifyApplyError soft-skip.
        await page.goto('https://x.com/settings/profile', {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
        await this.humanLikeDelay(2000, 3500);
        editBtn =
          (await page.$(editBtnSel)) ||
          (await page
            .locator('button:has-text("Edit profile"), button:has-text("Set up profile")')
            .first()
            .elementHandle()
            .catch(() => null));
      }

      const alreadyEditing =
        /settings\/profile/i.test(page.url() || '') ||
        !!(await page.$(
          '[aria-label*="Add avatar" i], [aria-label*="Edit avatar" i], [aria-label*="Add banner" i], [aria-label*="Edit banner" i], input[data-testid="fileInput"]'
        ));

      if (editBtn) {
        await editBtn.click().catch(() => {});
        await this.humanLikeDelay(1500, 2500);
      } else if (!alreadyEditing) {
        await page.screenshot({ path: `/tmp/x-media-noedit-${accountId}.png` }).catch(() => {});
        await page.screenshot({ path: `/app/uploads/x-media-noedit-${accountId}.png` }).catch(() => {});
        throw new Error(`Edit profile button not found (url=${page.url()})`);
      }
      await this.assertXProfileActionAllowed(page, { accountId });

      console.log(`X #${accountId}: restoring avatar from ${require('path').basename(photoPath)}`);
      await this._setXAvatarInputFiles(page, photoPath, { accountId, saveProfile: false });
      console.log(`X #${accountId}: setting scenic banner from ${require('path').basename(bannerPath)}`);
      await this._setXBannerInputFiles(page, bannerPath, { accountId, saveProfile: false });

      // Final Save if still open
      const save =
        (await page.$('[data-testid="settingsDetailSave"]')) ||
        (await page.$('[data-testid="Profile_Save_Button"]')) ||
        (await page.locator('[role="dialog"] button:has-text("Save")').first().elementHandle().catch(() => null));
      if (save) {
        await save.click().catch(() => {});
        await this.humanLikeDelay(2500, 4000);
      }

      // Re-open own profile (sidebar) for live verify + proof shot
      const profileAgain =
        (await page.$('[data-testid="AppTabBar_Profile_Link"]')) ||
        (await page.locator('a[aria-label="Profile"]').first().elementHandle().catch(() => null));
      if (profileAgain) {
        await profileAgain.click().catch(() => {});
        await this.humanLikeDelay(2500, 4000);
      }

      const live = await this.readXLiveProfile(page, {
        accountId,
        username: account.username,
      });
      const photoOk =
        !!live.avatarSrc &&
        /profile_images/i.test(live.avatarSrc) &&
        !/profile_banners/i.test(live.avatarSrc) &&
        !live.isDefaultAvatar;
      const bannerOk = !!live.hasCustomBanner;
      if (!photoOk || !bannerOk) {
        await page.screenshot({ path: `/tmp/x-media-fail-${accountId}.png` }).catch(() => {});
        throw new Error(
          `x_media_verify_failed: photoOk=${photoOk} bannerOk=${bannerOk} ` +
            `avatar=${(live.avatarSrc || '').slice(0, 80)} banner=${(live.bannerSrc || '').slice(0, 80)}`
        );
      }

      await page
        .screenshot({ path: `/app/uploads/x-media-proof-${accountId}.png`, fullPage: false })
        .catch(() => {});
      await page
        .screenshot({ path: `/tmp/x-media-proof-${accountId}.png`, fullPage: false })
        .catch(() => {});

      await this.persistSession(page, 'x', accountId);

      const path = require('path');
      const nextPersona = {
        ...persona,
        photo_applied: true,
        banner_applied: true,
        banner_applied_at: new Date().toISOString(),
        last_banner_path: path.basename(bannerPath),
        last_photo_path: path.basename(photoPath),
        last_verify: {
          ...(persona.last_verify || {}),
          at: new Date().toISOString(),
          photo: true,
          banner: true,
          avatar_src: (live.avatarSrc || '').slice(0, 120),
          banner_src: (live.bannerSrc || '').slice(0, 120),
        },
      };
      await pool.query(
        `UPDATE social_accounts
         SET credentials = jsonb_set(COALESCE(credentials, '{}'::jsonb), '{x_persona}', $2::jsonb),
             updated_at = NOW()
         WHERE id = $1`,
        [accountId, JSON.stringify(nextPersona)]
      );
      const { updateEnrichment } = require('./profileEnrichment');
      await updateEnrichment(
        accountId,
        { photo: true, banner: true },
        { source: 'x_media_restore' }
      );

      console.log(
        `X #${accountId}: avatar+banner OK photo=${path.basename(photoPath)} banner=${path.basename(bannerPath)}`
      );
      return {
        success: true,
        accountId,
        username: account.username,
        display_name: persona.display_name || null,
        photo: true,
        banner: true,
        username_renamed: false,
        verified: { photo: true, banner: true },
        skipped: ['display_name', 'bio', 'username'],
        photoPath,
        bannerPath,
      };
    } finally {
      if (browser) await browser.close().catch(() => {});
      this._untrackBrowser(accountId);
    }
  }

  /**
   * Banner-only live fix: cookie session → upload scenic x-banners header → verify custom banner.
   * Does not rewrite name/bio/avatar. Soft-fail tunnels via caller timeout/classify.
   */
  async applyXBannerLive(accountId, { bannerPath, requireProxy = true } = {}) {
    if (process.env.X_PERSONA_LIVE !== '1') {
      throw new Error('Set X_PERSONA_LIVE=1 to run live X banner edits');
    }
    if (!bannerPath) throw new Error('bannerPath required for applyXBannerLive');
    let browser;
    try {
      const account = await this.getAccount(accountId);
      if (account.platform !== 'x') {
        throw new Error(`Account ${accountId} is ${account.platform}, expected x`);
      }
      const creds =
        typeof account.credentials === 'string'
          ? JSON.parse(account.credentials)
          : account.credentials || {};
      const persona = creds.x_persona || {};
      const accountPassword =
        (creds.password && String(creds.password).trim()) ||
        (creds.pass && String(creds.pass).trim()) ||
        null;

      await this.requireProxyForLive(accountId);
      const result = await this.createBrowserForAccount(accountId, 2, { requireProxy });
      browser = result.browser;
      const page = result.page;

      const loggedIn = await this.ensureLoggedIn(
        page,
        'x',
        accountId,
        account.username,
        accountPassword,
        { allowLogin: false, totpSecret: creds.totp_secret }
      );
      if (!loggedIn) throw new Error(`no_live_session for x/${account.username}`);

      await this.humanBrowseXSession(page, { accountId });
      await this.assertXProfileActionAllowed(page, { accountId });

      const bannerResult = await this.updateXProfileBanner(page, bannerPath, {
        accountId,
        username: account.username,
      });
      const attempts = {
        nameAttempted: false,
        bioAttempted: false,
        photoAttempted: false,
        bannerAttempted: !!(bannerResult && bannerResult.bannerAttempted),
        usernameAttempted: false,
      };

      const live = await this.readXLiveProfile(page, {
        accountId,
        username: account.username,
      });
      const bannerOk = !!live.hasCustomBanner;
      if (!bannerOk) {
        throw new Error(
          `x_banner_verify_failed: not custom (src=${(live.bannerSrc || '').slice(0, 80)})`
        );
      }

      await this.persistSession(page, 'x', accountId);

      const nextPersona = {
        ...persona,
        banner_applied: true,
        banner_applied_at: new Date().toISOString(),
        last_banner_path: require('path').basename(bannerPath),
        last_verify: {
          ...(persona.last_verify || {}),
          at: new Date().toISOString(),
          banner: true,
          banner_src: (live.bannerSrc || '').slice(0, 120),
        },
      };
      await pool.query(
        `UPDATE social_accounts
         SET credentials = jsonb_set(COALESCE(credentials, '{}'::jsonb), '{x_persona}', $2::jsonb),
             updated_at = NOW()
         WHERE id = $1`,
        [accountId, JSON.stringify(nextPersona)]
      );
      const { updateEnrichment } = require('./profileEnrichment');
      await updateEnrichment(accountId, { banner: true }, { source: 'x_banner_live' });

      console.log(
        `X #${accountId}: banner-only OK from ${require('path').basename(bannerPath)}`
      );
      return {
        success: true,
        accountId,
        username: account.username,
        display_name: persona.display_name || null,
        photo: false,
        banner: true,
        username_renamed: false,
        verified: { banner: true },
        skipped: ['display_name', 'bio', 'photo', 'username'],
        attempts,
      };
    } finally {
      if (browser) await browser.close().catch(() => {});
      this._untrackBrowser(accountId);
    }
  }

  /**
   * End-to-end: restore cookie session → apply x_persona fields (+ optional photo/banner/rename).
   * Never password-logs in.
   * Never sets applied_live / photo_applied without live profile read-back verification.
   */
  async applyXPersonaLive(accountId, { photoPath = null, bannerPath = null, requireProxy = true } = {}) {
    if (process.env.X_PERSONA_LIVE !== '1') {
      throw new Error('Set X_PERSONA_LIVE=1 to run live X persona edits');
    }
    let browser;
    try {
      const account = await this.getAccount(accountId);
      if (account.platform !== 'x') {
        throw new Error(`Account ${accountId} is ${account.platform}, expected x`);
      }
      const creds =
        typeof account.credentials === 'string'
          ? JSON.parse(account.credentials)
          : account.credentials || {};
      let persona = creds.x_persona;
      if (!persona?.display_name || !persona?.bio) {
        throw new Error(`Account ${accountId} missing credentials.x_persona — run update-x-personas.js first`);
      }

      const {
        allocateDesiredUsername,
        needsHumanHandle,
        looksFakeUsername,
      } = require('./xPersonas');

      // Ensure a target desired_username exists for rename
      let desired =
        persona.desired_username ||
        (persona.rename_handle !== false ? persona.username : null);
      if (!desired && persona.rename_handle !== false) {
        desired = await allocateDesiredUsername(pool, accountId);
        persona = {
          ...persona,
          username: desired,
          desired_username: desired,
          rename_handle: true,
        };
        await pool.query(
          `UPDATE social_accounts
           SET credentials = jsonb_set(COALESCE(credentials, '{}'::jsonb), '{x_persona}', $2::jsonb),
               updated_at = NOW()
           WHERE id = $1`,
          [accountId, JSON.stringify(persona)]
        );
      } else if (desired && !persona.desired_username) {
        persona = { ...persona, desired_username: desired, username: desired };
      }

      const accountPassword =
        (creds.password && String(creds.password).trim()) ||
        (creds.pass && String(creds.pass).trim()) ||
        null;
      const wantsRename =
        persona.rename_handle !== false &&
        desired &&
        needsHumanHandle(account.username, persona);
      let renameSkippedNoPassword = false;
      // Cookie-only rename works via typedScreenName — do NOT skip when password missing.

      await this.requireProxyForLive(accountId);
      const result = await this.createBrowserForAccount(accountId, 2, { requireProxy });
      browser = result.browser;
      const page = result.page;

      // Cookie-only session restore — never password-login for organic/browse path
      const loggedIn = await this.ensureLoggedIn(
        page,
        'x',
        accountId,
        account.username,
        accountPassword,
        { allowLogin: false, totpSecret: creds.totp_secret }
      );
      if (!loggedIn) throw new Error(`no_live_session for x/${account.username}`);

      // Act like a person: feed first, then ban check, then profile edit.
      await this.humanBrowseXSession(page, { accountId });
      // Tunnel/browse can leave about:blank — recover before profile edits.
      if (!/x\.com|twitter\.com/i.test(page.url() || '')) {
        console.warn(`X #${accountId}: post-browse blank — recovering to home`);
        await page
          .goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 })
          .catch(() => {});
        await this.humanLikeDelay(2000, 3500);
      }
      if (!/x\.com|twitter\.com/i.test(page.url() || '')) {
        throw new Error('proxy_error: still about:blank after browse recovery');
      }
      await this.assertXProfileActionAllowed(page, { accountId });

      const personaResult = await this.updateXPersona(page, persona, {
        accountId,
        username: account.username,
        photoPath,
        bannerPath,
      });
      const attempts = {
        nameAttempted: !!(personaResult && personaResult.nameAttempted),
        bioAttempted: !!(personaResult && personaResult.bioAttempted),
        photoAttempted: !!(personaResult && personaResult.photoAttempted),
        bannerAttempted: !!(personaResult && personaResult.bannerAttempted),
        usernameAttempted: false,
      };
      // Fallback photo upload if setup flow skipped photo or classic modal had no file input
      if (photoPath && !attempts.photoAttempted) {
        try {
          const photoResult = await this.updateXProfilePhoto(page, photoPath, {
            accountId,
            username: account.username,
          });
          attempts.photoAttempted = !!(photoResult && photoResult.photoAttempted);
        } catch (photoErr) {
          console.warn(`X #${accountId} photo upload attempt failed: ${photoErr.message}`);
        }
      }
      if (bannerPath && !attempts.bannerAttempted) {
        try {
          const bannerResult = await this.updateXProfileBanner(page, bannerPath, {
            accountId,
            username: account.username,
          });
          attempts.bannerAttempted = !!(bannerResult && bannerResult.bannerAttempted);
        } catch (bannerErr) {
          console.warn(`X #${accountId} banner upload attempt failed: ${bannerErr.message}`);
        }
      }

      // Cookie-session rename via typedScreenName. Password/TOTP only if X prompts mid-rename.
      if (wantsRename && desired) {
        try {
          const renameResult = await this.updateXUsername(page, desired, {
            accountId,
            currentUsername: account.username,
            password: accountPassword,
            totpSecret: creds.totp_secret || creds.totp || null,
          });
          attempts.usernameAttempted = !!(renameResult && renameResult.usernameAttempted);
          if (renameResult?.requestedUsername) {
            persona = {
              ...persona,
              username: renameResult.requestedUsername,
              desired_username: renameResult.requestedUsername,
              rename_needs_password: false,
            };
          }
        } catch (renameErr) {
          const msg = renameErr.message || String(renameErr);
          console.warn(`X #${accountId} username rename failed: ${msg}`);
          if (/account_locked|suspended|locked/i.test(msg)) {
            throw renameErr;
          }
          if (/x_username_needs_password|x_username_bad_password/i.test(msg)) {
            persona = {
              ...persona,
              rename_needs_password: true,
              rename_skipped_at: new Date().toISOString(),
            };
            renameSkippedNoPassword = true;
          }
        }
      } else if (looksFakeUsername(account.username) && !desired) {
        console.warn(`X #${accountId}: live handle looks fake but no desired_username`);
      }

      const verification = await this.verifyXPersonaLive(page, persona, attempts, {
        accountId,
        username: account.username,
      });

      await this.persistSession(page, 'x', accountId);

      // Sync renamed handles so future URL teleports don't 404
      const liveHandle = verification.live?.liveHandle;
      if (
        liveHandle &&
        typeof liveHandle === 'string' &&
        liveHandle.toLowerCase() !== String(account.username || '').toLowerCase()
      ) {
        await pool.query(
          `UPDATE social_accounts SET username = $2, updated_at = NOW() WHERE id = $1 AND platform = 'x'`,
          [accountId, liveHandle]
        );
        console.log(`X #${accountId}: synced username ${account.username} → ${liveHandle}`);
        account.username = liveHandle;
      }

      const nextPersona = {
        ...persona,
        desired_username: persona.desired_username || persona.username || null,
        applied_live: !!verification.appliedLive,
        applied_live_at: verification.appliedLive ? new Date().toISOString() : null,
        photo_applied: !!verification.photoApplied,
        banner_applied: !!verification.bannerApplied,
        username_applied: !!verification.usernameApplied,
        rename_needs_password: renameSkippedNoPassword || !!persona.rename_needs_password,
        last_verify: {
          at: new Date().toISOString(),
          verified: verification.verified,
          skipped: verification.skipped,
          failed: verification.failed || [],
          live_name: verification.live?.displayName || null,
          visible_name: verification.live?.visibleDisplayName || null,
          live_handle: verification.live?.liveHandle || null,
          live_bio_len: (verification.live?.bio || '').length,
        },
      };
      // Strip null applied_live_at noise
      if (!nextPersona.applied_live) delete nextPersona.applied_live_at;
      if (nextPersona.username_applied) {
        nextPersona.rename_needs_password = false;
        delete nextPersona.rename_skipped_at;
      }
      if (!nextPersona.rename_needs_password) delete nextPersona.rename_needs_password;

      await pool.query(
        `UPDATE social_accounts
         SET credentials = jsonb_set(COALESCE(credentials, '{}'::jsonb), '{x_persona}', $2::jsonb),
             updated_at = NOW()
         WHERE id = $1`,
        [accountId, JSON.stringify(nextPersona)]
      );
      const { updateEnrichment } = require('./profileEnrichment');
      await updateEnrichment(
        accountId,
        {
          headline: !!verification.verified.display_name,
          about: !!verification.verified.bio,
          photo: !!verification.photoApplied,
          banner: !!verification.bannerApplied,
          category: 'general',
        },
        { source: verification.appliedLive ? 'x_persona_live' : 'x_persona_offline' }
      );

      if (!verification.appliedLive) {
        const detail =
          (verification.failed && verification.failed.length
            ? verification.failed.join('; ')
            : null) ||
          `no text fields verified (verified=${JSON.stringify(verification.verified)} skipped=[${verification.skipped.join(',')}])`;
        throw new Error(`x_persona_verify_failed: ${detail}`);
      }

      return {
        success: true,
        accountId,
        username: account.username,
        display_name: persona.display_name,
        photo: !!verification.photoApplied,
        banner: !!verification.bannerApplied,
        username_renamed: !!verification.usernameApplied,
        rename_skipped_no_password: renameSkippedNoPassword,
        verified: verification.verified,
        skipped: verification.skipped,
      };
    } finally {
      if (browser) await browser.close().catch(() => {});
      this._untrackBrowser(accountId);
    }
  }

  async dismissLinkedInModals(page) {
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button, [role="button"]')];
      for (const b of buttons) {
        const t = (b.innerText || b.getAttribute('aria-label') || '').trim();
        if (/^(Dismiss|Not now|No thanks|Skip|Close|Got it|Maybe later)$/i.test(t)) {
          try { b.click(); } catch { /* ignore */ }
        }
      }
      const close = document.querySelector(
        'button[aria-label="Dismiss"], button[data-test-modal-close-btn], .artdeco-modal__dismiss'
      );
      if (close) {
        try { close.click(); } catch { /* ignore */ }
      }
    }).catch(() => {});
    await this.humanLikeDelay(400, 900);
  }

  /**
   * Collect commentable activity URLs from the logged-in LinkedIn feed.
   */
  async listLinkedInFeedPosts(accountId, { limit = 10 } = {}) {
    let browser;
    try {
      const account = await this.getAccount(accountId);
      const creds = account.credentials || {};
      const loginId = account.email || account.username;
      const extras = {
        allowLogin: false,
        totpSecret: creds.totp_secret || creds.totp || creds.twofa,
        emailPassword: creds.email_password,
        profileUrl: creds.profile_url,
      };

      // Direct first — LinkedIn sticky proxies frequently authwall live cookies.
      const modes = [
        { label: 'direct', open: async () => {
          const direct = await this.createBrowser(
            null,
            false,
            await this.getOrCreateDeviceProfile(accountId, { forceDesktop: true })
          );
          direct.accountId = accountId;
          this._trackBrowser(accountId, direct.browser);
          return direct;
        }},
        { label: 'proxy', open: async () => {
          await this.requireProxyForLive(accountId);
          return this.createBrowserForAccount(accountId, 2, { requireProxy: true });
        }},
      ];

      let lastErr;
      for (const mode of modes) {
        try {
          if (browser) {
            await browser.close().catch(() => {});
            this._untrackBrowser(accountId);
            browser = null;
          }
          const opened = await mode.open();
          browser = opened.browser;
          const page = opened.page;
          const loggedIn = await this.ensureLoggedIn(
            page,
            'linkedin',
            accountId,
            loginId,
            creds.password,
            extras
          );
          if (!loggedIn) {
            lastErr = new Error(`LinkedIn session dead (${mode.label})`);
            continue;
          }
          const posts = await this._scrapeLinkedInFeed(page, limit);
          await this.persistSession(page, 'linkedin', accountId).catch(() => {});
          return posts;
        } catch (err) {
          lastErr = err;
          console.warn(`LinkedIn feed discovery via ${mode.label}:`, err.message);
        }
      }
      throw lastErr || new Error('LinkedIn feed discovery failed');
    } finally {
      if (browser) await browser.close().catch(() => {});
      this._untrackBrowser(accountId);
    }
  }

  async _scrapeLinkedInFeed(page, limit = 10) {
    const alreadyOnFeed = /linkedin\.com\/feed/i.test(page.url()) && !/authwall|login/i.test(page.url());
    if (!alreadyOnFeed) {
      try {
        await page.goto('https://www.linkedin.com/feed/', {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
      } catch (err) {
        // ERR_ABORTED often means a client-side redirect finished the navigation.
        if (!/ERR_ABORTED|frame was detached/i.test(err.message)) throw err;
        await this.humanLikeDelay(1500, 2500);
      }
    }
    await this.humanLikeDelay(1500, 3000);
    await this.dismissLinkedInModals(page);
    if (/authwall|\/login|\/uas\//i.test(page.url())) {
      throw new Error('LinkedIn feed authwalled during discovery');
    }
    await this.randomScroll(page).catch(() => {});
    await this.humanLikeDelay(800, 1500);

    const posts = await page.evaluate((max) => {
      const out = [];
      const seen = new Set();
      const cards = [
        ...document.querySelectorAll(
          '.feed-shared-update-v2, div[data-urn*="activity"], div[data-urn*="ugcPost"], div.feed-shared-update-v2__control-menu-container, article'
        ),
      ];
      for (const card of cards) {
        const urn =
          card.getAttribute('data-urn') ||
          card.querySelector('[data-urn]')?.getAttribute('data-urn') ||
          '';
        let url = null;
        if (/urn:li:(activity|ugcPost|share):/i.test(urn)) {
          url = `https://www.linkedin.com/feed/update/${urn}`;
        }
        if (!url) {
          const a = card.querySelector(
            'a[href*="/feed/update/"], a[href*="activity-"], a[href*="/posts/"][href*="activity"]'
          );
          if (a?.href && !/\/company\/[^/]+\/posts\/?$/i.test(a.href)) {
            url = a.href.split('?')[0].replace(/\/$/, '');
          }
        }
        if (!url || seen.has(url)) continue;
        if (/\/company\/[^/]+\/posts\/?$/i.test(url)) continue;
        seen.add(url);
        const title = (card.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160);
        out.push({
          post_url: url,
          title,
          selftext: title.slice(0, 400),
          subreddit: 'linkedin:feed',
          score: 0,
          num_comments: 0,
        });
        if (out.length >= max) break;
      }
      // Fallback: any activity / update href on the page
      if (!out.length) {
        for (const a of document.querySelectorAll('a[href*="/feed/update/"], a[href*="activity-"]')) {
          const href = (a.href || '').split('?')[0];
          if (!href || seen.has(href) || /\/company\//i.test(href)) continue;
          seen.add(href);
          out.push({
            post_url: href,
            title: (a.innerText || 'LinkedIn post').replace(/\s+/g, ' ').trim().slice(0, 120),
            selftext: '',
            subreddit: 'linkedin:feed',
            score: 0,
            num_comments: 0,
          });
          if (out.length >= max) break;
        }
      }
      return out;
    }, limit);

    return posts;
  }

  /**
   * Search LinkedIn content results for commentable activity URLs.
   * Useful for low-connection accounts whose home feed is mostly ads.
   */
  async listLinkedInSearchPosts(accountId, { query = 'hiring', limit = 8 } = {}) {
    let browser;
    try {
      const account = await this.getAccount(accountId);
      const creds = account.credentials || {};
      const loginId = account.email || account.username;
      const extras = {
        allowLogin: false,
        totpSecret: creds.totp_secret || creds.totp || creds.twofa,
      };

      // Same dual-mode as feed: direct first (LI sticky proxies often authwall cookies), then proxy.
      const modes = [
        {
          label: 'direct',
          open: async () => {
            const direct = await this.createBrowser(
              null,
              false,
              await this.getOrCreateDeviceProfile(accountId, { forceDesktop: true })
            );
            direct.accountId = accountId;
            this._trackBrowser(accountId, direct.browser);
            return direct;
          },
        },
        {
          label: 'proxy',
          open: async () => {
            await this.requireProxyForLive(accountId);
            return this.createBrowserForAccount(accountId, 2, { requireProxy: true });
          },
        },
      ];

      let lastErr;
      let posts = [];
      for (const mode of modes) {
        try {
          if (browser) {
            await browser.close().catch(() => {});
            this._untrackBrowser(accountId);
            browser = null;
          }
          const opened = await mode.open();
          browser = opened.browser;
          const page = opened.page;
          const loggedIn = await this.ensureLoggedIn(
            page,
            'linkedin',
            accountId,
            loginId,
            creds.password,
            extras
          );
          if (!loggedIn) {
            lastErr = new Error(`LinkedIn session not alive for search (${mode.label})`);
            continue;
          }

          const url = `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(query)}&origin=SWITCH_SEARCH_VERTICAL`;
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
          await this.humanLikeDelay(2500, 4000);
          await this.dismissLinkedInModals(page);
          await this.randomScroll(page).catch(() => {});

          posts = await page.evaluate((max) => {
            const out = [];
            const seen = new Set();
            for (const a of document.querySelectorAll(
              'a[href*="/feed/update/"], a[href*="activity-"], a[href*="/posts/"]'
            )) {
              let href = (a.href || '').split('?')[0].replace(/\/$/, '');
              if (!href || seen.has(href)) continue;
              if (/\/company\/[^/]+\/posts\/?$/i.test(href)) continue;
              if (!/feed\/update|activity-|\/posts\/.+activity/i.test(href)) continue;
              seen.add(href);
              const card = a.closest('li') || a.closest('div');
              const title = ((card && card.innerText) || a.innerText || '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 160);
              out.push({
                post_url: href,
                title,
                selftext: title.slice(0, 400),
                subreddit: 'linkedin:search',
                score: 0,
                num_comments: 0,
              });
              if (out.length >= max) break;
            }
            return out;
          }, limit);
          await this.persistSession(page, 'linkedin', accountId).catch(() => {});
          if (posts.length) return posts;
        } catch (err) {
          lastErr = err;
          console.warn(`LinkedIn search discovery via ${mode.label}:`, err.message);
        }
      }
      if (posts.length) return posts;
      throw lastErr || new Error('LinkedIn search discovery failed');
    } finally {
      if (browser) await browser.close().catch(() => {});
      this._untrackBrowser(accountId);
    }
  }

  async linkedInPostComment(page, postUrl, comment, parentCommentId = null) {
    try {
      const targetUrl = parentCommentId
        ? postUrl + '?commentUrn=urn:li:comment:' + parentCommentId
        : postUrl;

      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.humanLikeDelay(1500, 3000);
      await this.dismissLinkedInModals(page);
      await this.simulateHumanBehavior(page);

      // Open comment box if collapsed
      const opened = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button, [role="button"]')];
        const commentBtn = buttons.find((b) => {
          const t = `${b.innerText || ''} ${b.getAttribute('aria-label') || ''}`.toLowerCase();
          return /\bcomment\b/.test(t) && !/comments?\s+\d/i.test(t);
        });
        if (commentBtn) {
          commentBtn.click();
          return true;
        }
        return false;
      });
      if (opened) await this.humanLikeDelay(800, 1600);

      const editor = await page.waitForSelector(
        '.comments-comment-box .ql-editor, .comments-comment-box div[role="textbox"], form.comments-comment-box__form .ql-editor, .ql-editor[contenteditable="true"], div[role="textbox"][contenteditable="true"]',
        { timeout: 15000 }
      );
      await editor.click({ force: true });
      await this.humanLikeDelay(300, 600);
      // Quill needs real keyboard events (same as createLinkedInPost) to enable Post.
      await page.keyboard.type(String(comment || ''), { delay: 25 });
      await this.humanLikeDelay(800, 1600);

      const posted = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button')];
        const candidates = buttons.filter((b) => {
          const label = `${(b.innerText || '').trim()} ${b.getAttribute('aria-label') || ''}`.trim();
          const isPost =
            /^Post$/i.test((b.innerText || '').trim()) ||
            /post comment/i.test(label) ||
            /comments-comment-box__submit-button/.test(b.className || '');
          return isPost && !b.disabled && b.offsetParent !== null;
        });
        const inBox = candidates.find((b) =>
          b.closest('.comments-comment-box, form.comments-comment-box__form, .comments-comment-texteditor')
        );
        const btn = inBox || candidates[candidates.length - 1] || null;
        if (!btn) return false;
        btn.click();
        return true;
      });
      if (!posted) {
        // LinkedIn comment box accepts Ctrl+Enter
        await page.keyboard.press('Control+Enter');
        await this.humanLikeDelay(1500, 2500);
      } else {
        await this.humanLikeDelay(2000, 4000);
      }

      const snippet = String(comment || '').slice(0, 40);
      const visible = snippet
        ? await page.evaluate((s) => document.body && document.body.innerText.includes(s), snippet)
        : false;
      if (posted || visible) return `li-${Date.now()}`;

      await page.screenshot({ path: `/tmp/linkedin-comment-fail-${Date.now()}.png` }).catch(() => {});
      return false;
    } catch (error) {
      console.error('Error posting LinkedIn comment:', error);
      await page.screenshot({ path: `/tmp/linkedin-comment-err-${Date.now()}.png` }).catch(() => {});
      return false;
    }
  }

  /**
   * Instagram comment on a post URL (must be logged in).
   */
  async instagramPostComment(page, postUrl, comment) {
    try {
      await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.humanLikeDelay(2000, 3500);
      await this.simulateHumanBehavior(page);

      // Dismiss save-login / notifications prompts
      await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button')];
        const skip = buttons.find((b) => /^(Not Now|Not now)$/i.test((b.innerText || '').trim()));
        if (skip) skip.click();
      }).catch(() => {});

      const textarea = await page.waitForSelector(
        'textarea[aria-label*="Add a comment"], textarea[placeholder*="Add a comment"], form textarea',
        { timeout: 15000 }
      );
      await textarea.click();
      await this.humanLikeTyping(
        page,
        'textarea[aria-label*="Add a comment"], textarea[placeholder*="Add a comment"], form textarea',
        comment
      );
      await this.humanLikeDelay(400, 1000);

      const posted = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button, [role="button"]')];
        const postBtn = buttons.find((b) => /^(Post|Comment)$/i.test((b.innerText || '').trim()));
        if (postBtn && !postBtn.disabled) {
          postBtn.click();
          return true;
        }
        return false;
      });
      if (!posted) {
        await page.keyboard.press('Enter');
      }
      await this.humanLikeDelay(2000, 4000);
      return `ig-${Date.now()}`;
    } catch (error) {
      console.error('Error posting Instagram comment:', error);
      return false;
    }
  }

  async listInstagramExplorePosts(accountId, { limit = 8 } = {}) {
    let browser;
    try {
      await this.requireProxyForLive(accountId);
      const result = await this.createBrowserForAccount(accountId, 2, { requireProxy: true });
      browser = result.browser;
      const page = result.page;
      const account = await this.getAccount(accountId);
      const creds = account.credentials || {};
      const loggedIn = await this.ensureLoggedIn(
        page,
        'instagram',
        accountId,
        account.username,
        creds.password,
        {
          allowLogin: false,
          totpSecret: creds.totp_secret || creds.totp || creds.twofa,
        }
      );
      if (!loggedIn) throw new Error('Instagram session not alive for discovery');

      await page.goto('https://www.instagram.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await this.humanLikeDelay(2000, 3500);
      await this.randomScroll(page).catch(() => {});

      const posts = await page.evaluate((max) => {
        const out = [];
        const seen = new Set();
        for (const a of document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')) {
          const href = (a.href || '').split('?')[0];
          if (!href || seen.has(href)) continue;
          if (!/instagram\.com\/(p|reel)\//i.test(href)) continue;
          seen.add(href);
          out.push({
            post_url: href,
            title: 'instagram post',
            selftext: '',
            subreddit: 'instagram:feed',
            score: 0,
            num_comments: 0,
          });
          if (out.length >= max) break;
        }
        return out;
      }, limit);
      return posts;
    } finally {
      if (browser) await browser.close().catch(() => {});
      this._untrackBrowser(accountId);
    }
  }

  /** Shared timeline scrape from whatever X page is loaded (home / search / explore). */
  async xScrapeTimelinePosts(page, { limit = 10, source = 'x:timeline' } = {}) {
    return page.evaluate(({ max, src }) => {
      const out = [];
      const seen = new Set();
      for (const a of document.querySelectorAll('a[href*="/status/"]')) {
        const m = (a.href || '').match(/(?:x|twitter)\.com\/([^/]+)\/status\/(\d+)/i);
        if (!m) continue;
        const handle = m[1];
        if (/^(i|home|explore|search|settings|messages|notifications)$/i.test(handle)) continue;
        const url = `https://x.com/${handle}/status/${m[2]}`;
        if (seen.has(url)) continue;
        seen.add(url);
        const article = a.closest('article');
        const title = ((article && article.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 160);
        out.push({
          post_url: url,
          title,
          selftext: title.slice(0, 400),
          subreddit: src,
          username: handle,
          score: 0,
          num_comments: 0,
        });
        if (out.length >= max) break;
      }
      return out;
    }, { max: limit, src: source });
  }

  /**
   * Human-like keyword search on X Live tab.
   * Lands on search URL, scrolls/pauses, returns status URLs.
   */
  async xSearchPosts(page, query, { limit = 12 } = {}) {
    const q = String(query || '').trim();
    if (!q) throw new Error('xSearchPosts requires a query');
    const url = `https://x.com/search?q=${encodeURIComponent(q)}&src=typed_query&f=live`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await this.humanLikeDelay(2200, 4000);
    await this.simulateHumanBehavior(page);
    await this.randomScroll(page).catch(() => {});
    await this.humanLikeDelay(900, 1800);
    if (Math.random() < 0.55) {
      await this.randomScroll(page).catch(() => {});
      await this.humanLikeDelay(600, 1400);
    }
    return this.xScrapeTimelinePosts(page, { limit, source: `x:search:${q.slice(0, 40)}` });
  }

  /** People tab search → candidate handles. */
  async xSearchPeople(page, query, { limit = 10 } = {}) {
    const q = String(query || '').trim();
    if (!q) throw new Error('xSearchPeople requires a query');
    const url = `https://x.com/search?q=${encodeURIComponent(q)}&src=typed_query&f=user`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await this.humanLikeDelay(2200, 4000);
    await this.simulateHumanBehavior(page);
    await this.randomScroll(page).catch(() => {});
    await this.humanLikeDelay(800, 1600);

    return page.evaluate((max) => {
      const out = [];
      const seen = new Set();
      const junk = /^(home|explore|search|settings|messages|notifications|i|compose|login|signup|tos|privacy|people|verified|premium|jobs|lists|communities|grok|technology|business|sports)$/i;
      // Prefer UserCell only — bare role=link picks up nav/topic chips as fake handles
      const cells = document.querySelectorAll('[data-testid="UserCell"]');
      for (const cell of cells) {
        const a = cell.querySelector('a[href^="/"]');
        if (!a) continue;
        const href = (a.getAttribute('href') || '').split('?')[0];
        const m = href.match(/^\/([A-Za-z0-9_]{1,15})$/);
        if (!m) continue;
        const handle = m[1];
        if (junk.test(handle)) continue;
        const key = handle.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const blurb = (cell.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        out.push({ handle, profile_url: `https://x.com/${handle}`, blurb });
        if (out.length >= max) break;
      }
      return out;
    }, limit);
  }

  /** Sidebar / connect "Who to follow" suggestions on home or connect. */
  async xDiscoverWhoToFollow(page, { limit = 8 } = {}) {
    const urls = [
      'https://x.com/i/connect_people',
      'https://x.com/home',
    ];
    for (const url of urls) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await this.humanLikeDelay(2000, 3500);
        await this.simulateHumanBehavior(page);
        await this.randomScroll(page).catch(() => {});
        const found = await page.evaluate((max) => {
          const out = [];
          const seen = new Set();
          const cells = document.querySelectorAll('[data-testid="UserCell"], [data-testid="UserCell"]');
          for (const cell of cells) {
            const a = cell.querySelector('a[href^="/"]');
            if (!a) continue;
            const href = (a.getAttribute('href') || '').split('?')[0];
            const m = href.match(/^\/([A-Za-z0-9_]{1,15})$/);
            if (!m) continue;
            const handle = m[1];
            const key = handle.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ handle, profile_url: `https://x.com/${handle}`, source: 'who_to_follow' });
            if (out.length >= max) break;
          }
          // Aside "Who to follow" links
          if (out.length < max) {
            for (const a of document.querySelectorAll('aside a[href^="/"], [aria-label*="Who to follow"] a[href^="/"]')) {
              const href = (a.getAttribute('href') || '').split('?')[0];
              const m = href.match(/^\/([A-Za-z0-9_]{1,15})$/);
              if (!m) continue;
              const handle = m[1];
              const key = handle.toLowerCase();
              if (seen.has(key)) continue;
              if (/^(home|explore|search|settings|i)$/i.test(handle)) continue;
              seen.add(key);
              out.push({ handle, profile_url: `https://x.com/${handle}`, source: 'who_to_follow' });
              if (out.length >= max) break;
            }
          }
          return out;
        }, limit);
        if (found.length) return found;
      } catch (err) {
        console.warn(`xDiscoverWhoToFollow ${url}:`, err.message);
      }
    }
    return [];
  }

  /**
   * Light following-of-following: open a seed profile's following list, skim a few handles.
   */
  async xDiscoverFollowingOfFollowing(page, seedHandle, { limit = 6 } = {}) {
    const seed = String(seedHandle || '').replace(/^@/, '');
    if (!seed) return [];
    await page.goto(`https://x.com/${encodeURIComponent(seed)}/following`, {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });
    await this.humanLikeDelay(2200, 4000);
    await this.simulateHumanBehavior(page);
    await this.randomScroll(page).catch(() => {});
    await this.humanLikeDelay(700, 1400);

    return page.evaluate(({ max, seedLower }) => {
      const out = [];
      const seen = new Set([seedLower]);
      for (const a of document.querySelectorAll('[data-testid="UserCell"] a[href^="/"], a[href^="/"][role="link"]')) {
        const href = (a.getAttribute('href') || '').split('?')[0];
        const m = href.match(/^\/([A-Za-z0-9_]{1,15})$/);
        if (!m) continue;
        const handle = m[1];
        const key = handle.toLowerCase();
        if (seen.has(key)) continue;
        if (/^(home|explore|search|settings|i|following|followers)$/i.test(handle)) continue;
        seen.add(key);
        out.push({
          handle,
          profile_url: `https://x.com/${handle}`,
          source: 'following_of_following',
          seed: seedLower,
        });
        if (out.length >= max) break;
      }
      return out;
    }, { max: limit, seedLower: seed.toLowerCase() });
  }

  /**
   * Accept pending inbound follow requests (protected accounts / follower requests UI).
   * Tries /follower_requests then notifications connect paths.
   */
  async xAcceptFollowRequests(page, { maxAccept = 5 } = {}) {
    const accepted = [];
    const screenshots = [];
    const tryUrls = [
      'https://x.com/follower_requests',
      'https://x.com/i/follower_requests',
      'https://x.com/settings/follower_requests',
    ];

    let landed = false;
    for (const url of tryUrls) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await this.humanLikeDelay(2000, 3500);
        const path = page.url();
        if (/login|i\/flow/i.test(path)) continue;
        landed = true;
        break;
      } catch {
        /* try next */
      }
    }

    if (!landed) {
      // Fallback: notifications → People you may know / requests chrome
      try {
        await page.goto('https://x.com/notifications', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await this.humanLikeDelay(1800, 3000);
        await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a, [role="tab"], [role="link"]'));
          const hit = links.find((el) =>
            /follower request|follow request|requests/i.test(
              (el.innerText || el.getAttribute('aria-label') || '').trim()
            )
          );
          if (hit) hit.click();
        });
        await this.humanLikeDelay(1500, 2800);
      } catch {
        /* empty */
      }
    }

    await this.simulateHumanBehavior(page);
    await this.humanLikeDelay(800, 1500);

    const emptyShot = `/tmp/x-follow-requests-${Date.now()}.png`;
    await page.screenshot({ path: emptyShot, fullPage: true }).catch(() => {});
    screenshots.push(emptyShot);

    for (let i = 0; i < maxAccept; i++) {
      const clicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
        for (const b of buttons) {
          const label = (b.innerText || b.getAttribute('aria-label') || '').trim();
          if (/^Accept$/i.test(label) || /^Approve$/i.test(label) || /Accept request/i.test(label)) {
            const rect = b.getBoundingClientRect();
            if (rect.width > 6 && rect.height > 6) {
              b.click();
              return label;
            }
          }
        }
        // data-testid variants
        const byTest = document.querySelector(
          '[data-testid="userFollowButton"], [data-testid*="accept"], [data-testid*="Approve"]'
        );
        if (byTest) {
          byTest.click();
          return byTest.getAttribute('data-testid') || 'testid';
        }
        return null;
      });

      if (!clicked) break;
      accepted.push({ at: new Date().toISOString(), button: clicked });
      await this.humanLikeDelay(1200, 2800);
      if (Math.random() < 0.4) await this.simulateHumanBehavior(page);
    }

    const bodyText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 400));
    const empty =
      accepted.length === 0 &&
      /no (pending )?follower requests|no requests|nothing to see|when someone requests/i.test(bodyText);

    return {
      accepted: accepted.length,
      details: accepted,
      empty: !!empty || accepted.length === 0,
      url: page.url(),
      screenshots,
    };
  }

  async _openXCookieSession(accountId, { requireProxy = true } = {}) {
    if (requireProxy) await this.requireProxyForLive(accountId);
    const result = await this.createBrowserForAccount(accountId, 2, {
      requireProxy,
      skipProxy: !requireProxy,
    });
    const account = await this.getAccount(accountId);
    const creds = account.credentials || {};
    const loggedIn = await this.ensureLoggedIn(
      result.page,
      'x',
      accountId,
      account.username,
      creds.password,
      { allowLogin: false, totpSecret: creds.totp_secret || creds.totp || creds.twofa }
    );
    if (!loggedIn) {
      await result.browser.close().catch(() => {});
      this._untrackBrowser(accountId);
      throw new Error('X session not alive (cookie-only; no password login)');
    }
    return { ...result, account };
  }

  async listXHomePosts(accountId, { limit = 8 } = {}) {
    let browser;
    try {
      const opened = await this._openXCookieSession(accountId);
      browser = opened.browser;
      const page = opened.page;

      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.humanLikeDelay(2000, 3500);
      await this.simulateHumanBehavior(page);
      await this.randomScroll(page).catch(() => {});

      return this.xScrapeTimelinePosts(page, { limit, source: 'x:home' });
    } finally {
      if (browser) await browser.close().catch(() => {});
      this._untrackBrowser(accountId);
    }
  }

  async listXSearchPosts(accountId, { query, limit = 12 } = {}) {
    let browser;
    try {
      const opened = await this._openXCookieSession(accountId);
      browser = opened.browser;
      const posts = await this.xSearchPosts(opened.page, query, { limit });
      await this.persistSession(opened.page, 'x', accountId).catch(() => {});
      return posts;
    } finally {
      if (browser) await browser.close().catch(() => {});
      this._untrackBrowser(accountId);
    }
  }

  async listXSearchPeople(accountId, { query, limit = 10 } = {}) {
    let browser;
    try {
      const opened = await this._openXCookieSession(accountId);
      browser = opened.browser;
      const people = await this.xSearchPeople(opened.page, query, { limit });
      await this.persistSession(opened.page, 'x', accountId).catch(() => {});
      return people;
    } finally {
      if (browser) await browser.close().catch(() => {});
      this._untrackBrowser(accountId);
    }
  }

  async acceptXFollowRequests(accountId, { maxAccept = 5, requireProxy = true } = {}) {
    let browser;
    try {
      const opened = await this._openXCookieSession(accountId, { requireProxy });
      browser = opened.browser;
      const result = await this.xAcceptFollowRequests(opened.page, { maxAccept });
      await this.persistSession(opened.page, 'x', accountId).catch(() => {});
      return { success: true, accountId, username: opened.account.username, ...result };
    } finally {
      if (browser) await browser.close().catch(() => {});
      this._untrackBrowser(accountId);
    }
  }

  /**
   * Discover follow targets via people search + who-to-follow + light FoF.
   * Does not follow — returns handles for x_follow_targets insert.
   */
  async discoverXFollowTargets(accountId, {
    keywords = [],
    seedHandles = [],
    limit = 15,
    requireProxy = true,
  } = {}) {
    let browser;
    try {
      const opened = await this._openXCookieSession(accountId, { requireProxy });
      browser = opened.browser;
      const page = opened.page;
      const found = [];
      const seen = new Set();

      const pushAll = (rows, category) => {
        for (const row of rows || []) {
          const handle = String(row.handle || '').replace(/^@/, '');
          if (!handle) continue;
          const key = handle.toLowerCase();
          if (seen.has(key)) continue;
          if (key === String(opened.account.username || '').toLowerCase()) continue;
          seen.add(key);
          found.push({
            handle,
            category: category || row.source || 'discovered',
            profile_url: row.profile_url || `https://x.com/${handle}`,
            source: row.source || category || 'search',
          });
        }
      };

      for (const kw of (keywords || []).slice(0, 3)) {
        if (found.length >= limit) break;
        try {
          await this.humanLikeDelay(800, 1600);
          const people = await this.xSearchPeople(page, kw, { limit: 8 });
          pushAll(people.map((p) => ({ ...p, source: 'search_people' })), 'discovered');
        } catch (err) {
          console.warn(`discover people "${kw}":`, err.message);
        }
      }

      if (found.length < limit) {
        try {
          const who = await this.xDiscoverWhoToFollow(page, { limit: 8 });
          pushAll(who, 'discovered');
        } catch (err) {
          console.warn('who_to_follow:', err.message);
        }
      }

      for (const seed of (seedHandles || []).slice(0, 2)) {
        if (found.length >= limit) break;
        try {
          await this.humanLikeDelay(1000, 2000);
          const fof = await this.xDiscoverFollowingOfFollowing(page, seed, { limit: 5 });
          pushAll(fof, 'discovered');
        } catch (err) {
          console.warn(`fof @${seed}:`, err.message);
        }
      }

      await this.persistSession(page, 'x', accountId).catch(() => {});
      return {
        success: true,
        accountId,
        username: opened.account.username,
        targets: found.slice(0, limit),
      };
    } finally {
      if (browser) await browser.close().catch(() => {});
      this._untrackBrowser(accountId);
    }
  }

  /**
   * Cookie-only smoke: search → comment (one session).
   */
  async smokeTestXSearchComment(accountId, {
    query = 'NBA',
    comment = null,
    requireProxy = true,
  } = {}) {
    let browser;
    const steps = [];
    try {
      const opened = await this._openXCookieSession(accountId, { requireProxy });
      browser = opened.browser;
      const page = opened.page;
      steps.push({ step: 'session', ok: true });

      const posts = await this.xSearchPosts(page, query, { limit: 8 });
      steps.push({ step: 'search', ok: posts.length > 0, count: posts.length, query, sample: posts[0]?.post_url });
      if (!posts.length) throw new Error(`No search posts for "${query}"`);

      // Browse then open one result
      await this.humanLikeDelay(1000, 2200);
      const target = posts[Math.floor(Math.random() * Math.min(3, posts.length))];
      const replyText =
        comment ||
        this.pickRandom([
          'fair point',
          'hadnt thought about it that way',
          'wild',
          'makes sense',
          'good look',
          'interesting',
        ]);

      const commented = await this.xPostComment(page, target.post_url, replyText);
      steps.push({
        step: 'comment',
        ok: !!commented,
        postUrl: target.post_url,
        comment: replyText,
      });
      if (!commented) throw new Error('X search comment failed');

      await this.persistSession(page, 'x', accountId).catch(() => {});
      return {
        success: true,
        accountId,
        username: opened.account.username,
        query,
        steps,
      };
    } catch (error) {
      return { success: false, accountId, error: error.message, steps };
    } finally {
      if (browser) await browser.close().catch(() => {});
      this._untrackBrowser(accountId);
    }
  }

  /**
   * Cookie-only smoke: people search → follow one.
   */
  async smokeTestXSearchFollow(accountId, {
    query = 'fantasy football',
    requireProxy = true,
  } = {}) {
    let browser;
    const steps = [];
    try {
      const opened = await this._openXCookieSession(accountId, { requireProxy });
      browser = opened.browser;
      const page = opened.page;
      steps.push({ step: 'session', ok: true });

      const people = await this.xSearchPeople(page, query, { limit: 8 });
      steps.push({ step: 'search_people', ok: people.length > 0, count: people.length, sample: people[0]?.handle });
      if (!people.length) throw new Error(`No people for "${query}"`);

      const pick = people.find((p) => p.handle.toLowerCase() !== String(opened.account.username || '').toLowerCase())
        || people[0];
      await this.humanLikeDelay(1200, 2400);
      const follow = await this.xFollowUser(page, pick.handle);
      steps.push({ step: 'follow', ok: true, handle: pick.handle, ...follow });

      await this.persistSession(page, 'x', accountId).catch(() => {});
      return {
        success: true,
        accountId,
        username: opened.account.username,
        query,
        handle: pick.handle,
        steps,
      };
    } catch (error) {
      return { success: false, accountId, error: error.message, steps };
    } finally {
      if (browser) await browser.close().catch(() => {});
      this._untrackBrowser(accountId);
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
        throw new Error('TikTok temporarily limited login — try again later');
      }
      if (state.badCreds) {
        console.log(`TikTok bad credentials for ${loginId}: ${state.snippet}`);
        await page.screenshot({ path: `/tmp/tiktok-badcreds-${Date.now()}.png` }).catch(() => {});
        throw new Error('TikTok login failed: bad_credentials — Incorrect username or password');
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
      if (/temporarily limited|try again later|rate.?limit|bad_credentials|maximum number of attempts/i.test(error.message || '')) {
        throw error;
      }
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

  async postComment(
    platform,
    accountId,
    postUrl,
    comment,
    parentCommentId = null,
    { requireProxy = false, allowLogin = true, skipProxy = false } = {}
  ) {
    let browser, context, page, proxyId;
    let operationSuccess = false;
    let lastErrorMsg = null;

    try {
      if (!postUrl || !String(postUrl).startsWith('http')) {
        throw new Error(`postComment requires a full URL, got: ${postUrl}`);
      }

      const account = await this.getAccount(accountId);
      const creds =
        typeof account.credentials === 'string'
          ? JSON.parse(account.credentials)
          : account.credentials || {};

      // LinkedIn sessions often survive on direct but authwall on sticky proxies.
      const preferDirect = skipProxy || (platform === 'linkedin' && !requireProxy);
      const result = preferDirect
        ? await this.createBrowserForAccount(accountId, 2, { skipProxy: true })
        : await this.createBrowserForAccount(accountId, 2, { requireProxy });
      browser = result.browser;
      context = result.context;
      page = result.page;
      proxyId = result.proxyConfig?._proxyId;

      const loginId =
        platform === 'linkedin'
          ? account.email || account.username
          : account.username;
      const extras = {
        allowLogin,
        totpSecret: creds.totp_secret || creds.totp || creds.twofa,
        emailPassword: creds.email_password,
        profileUrl: creds.profile_url,
        email: creds.email || account.email,
      };
      let loggedIn = await this.ensureLoggedIn(
        page,
        platform,
        accountId,
        loginId,
        creds.password || account.credentials?.password,
        extras
      );

      // LinkedIn: sticky proxies sometimes authwall cookies — prefer direct, but if
      // the direct session is dead try the assigned proxy once before giving up.
      if (!loggedIn && platform === 'linkedin' && preferDirect) {
        await browser.close().catch(() => {});
        this._untrackBrowser(accountId);
        try {
          await this.requireProxyForLive(accountId);
          const viaProxy = await this.createBrowserForAccount(accountId, 2, { requireProxy: true });
          browser = viaProxy.browser;
          page = viaProxy.page;
          proxyId = viaProxy.proxyConfig?._proxyId;
          viaProxy.accountId = accountId;
          this._trackBrowser(accountId, browser);
          loggedIn = await this.ensureLoggedIn(
            page,
            platform,
            accountId,
            loginId,
            creds.password,
            extras
          );
        } catch (proxyErr) {
          console.warn(`LinkedIn postComment proxy fallback failed: ${proxyErr.message}`);
        }
      }

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
        case 'instagram':
          platformCommentId = await this.instagramPostComment(page, postUrl, comment);
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
        // Only burn proxy on infra/security — UI/login-credential flakes must not
        // circuit-open sticky IPs (that starves hundreds of accounts).
        const burnProxy =
          operationSuccess ||
          /tunnel|timed_out|timeout|proxy|err_|ECONNREFUSED|ENOTFOUND|socket|network.security|blocked by network|Username input not found/i.test(
            lastErrorMsg || ''
          );
        if (burnProxy) {
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

  /**
   * Visit a Reddit user profile and click Follow if not already following.
   * Returns { followed, alreadyFollowing, profileUrl }
   */
  async redditFollowUser(page, targetUsername) {
    const handle = String(targetUsername || '').replace(/^u\//i, '').trim();
    const profileUrl = `https://www.reddit.com/user/${encodeURIComponent(handle)}/`;
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await this.humanLikeDelay(2500, 4500);
    await this.simulateHumanBehavior(page).catch(() => {});
    await this.randomScroll(page).catch(() => {});

    const bodyText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 2500));
    if (/this account has been banned|suspended|deleted|doesn.?t exist|nobody on reddit goes by that name/i.test(bodyText)) {
      throw new Error(`Reddit target unavailable: ${handle}`);
    }
    if (/your account has been banned|account is suspended|you.?ve been permanently banned from reddit/i.test(bodyText)) {
      throw new Error(`Reddit account banned while viewing u/${handle}`);
    }

    const collectFollowControls = () => page.evaluate(() => {
      const out = [];
      const pushEl = (el, depth = 0) => {
        if (!el || depth > 4) return;
        const label = (
          el.getAttribute?.('aria-label') ||
          el.innerText ||
          el.textContent ||
          ''
        )
          .trim()
          .split('\n')[0]
          .trim()
          .slice(0, 60);
        if (/follow/i.test(label)) {
          out.push({
            label,
            tag: (el.tagName || '').toLowerCase(),
            testid: el.getAttribute?.('data-testid') || null,
          });
        }
        try {
          if (el.shadowRoot) {
            for (const child of el.shadowRoot.querySelectorAll('button, a, [role="button"]')) {
              pushEl(child, depth + 1);
            }
          }
        } catch { /* ignore */ }
      };
      for (const el of document.querySelectorAll(
        'button, a, [role="button"], faceplate-tracker, shreddit-async-loader, [data-testid*="follow" i]'
      )) {
        pushEl(el, 0);
      }
      return out.slice(0, 20);
    });

    // Profile chrome can hydrate slowly on new Reddit.
    let labels = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      labels = await collectFollowControls();
      if (labels.length) break;
      await this.humanLikeDelay(1200, 2200);
      await this.randomScroll(page).catch(() => {});
    }

    const following = labels.some((t) =>
      /^(Following|Unfollow)$/i.test(t.label) || /Unfollow|Following/i.test(t.label)
    );
    if (following) {
      return {
        followed: false,
        alreadyFollowing: true,
        profileUrl,
        button: labels.find((t) => /follow/i.test(t.label))?.label || 'Following',
      };
    }

    const clicked = await page.evaluate(() => {
      const isFollow = (t) => /^(Follow|Follow back)$/i.test(String(t || '').trim());
      const tryClick = (el, depth = 0) => {
        if (!el || depth > 4) return null;
        const label = (
          el.getAttribute?.('aria-label') ||
          el.innerText ||
          el.textContent ||
          ''
        )
          .trim()
          .split('\n')[0]
          .trim();
        if (isFollow(label)) {
          el.click();
          return label;
        }
        try {
          if (el.shadowRoot) {
            for (const child of el.shadowRoot.querySelectorAll('button, a, [role="button"]')) {
              const hit = tryClick(child, depth + 1);
              if (hit) return hit;
            }
          }
        } catch { /* ignore */ }
        return null;
      };
      for (const el of document.querySelectorAll(
        'button, a, [role="button"], faceplate-tracker, shreddit-async-loader, [data-testid*="follow" i]'
      )) {
        const hit = tryClick(el, 0);
        if (hit) return hit;
      }
      return null;
    });

    if (!clicked) {
      await page.screenshot({ path: `/tmp/reddit-follow-miss-${handle}.png`, fullPage: true }).catch(() => {});
      throw new Error(
        `Reddit Follow button not found on u/${handle} (saw: ${
          labels.map((t) => t.label).join(', ') || 'none'
        })`
      );
    }

    await this.humanLikeDelay(1500, 3000);
    return { followed: true, alreadyFollowing: false, profileUrl, button: clicked };
  }

  /**
   * Login (or reuse session) and follow a single Reddit user.
   */
  async followRedditUser(accountId, targetUsername, { requireProxy = true, allowLogin = true } = {}) {
    const account = await this.getAccount(accountId);
    if (String(account.platform || '').toLowerCase() !== 'reddit') {
      throw new Error(`Account ${accountId} is ${account.platform}, expected reddit`);
    }
    const creds =
      typeof account.credentials === 'string'
        ? JSON.parse(account.credentials)
        : account.credentials || {};
    const password = creds.password || account.credentials?.password;
    if (allowLogin && (!password || password === 'default_password')) {
      throw new Error('Account has no real password');
    }

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

        const loggedIn = await this.ensureLoggedIn(
          page,
          'reddit',
          accountId,
          account.username,
          password,
          { allowLogin }
        );
        if (!loggedIn) {
          await page.screenshot({ path: `/tmp/reddit-follow-login-${account.username}.png`, fullPage: true }).catch(() => {});
          throw new Error(allowLogin ? 'Reddit login failed' : 'Reddit session not alive (cookie-only)');
        }

        // Human-like browse before follow
        try {
          await this.browseWarmFeed(page, 'reddit');
        } catch { /* continue */ }

        const follow = await this.redditFollowUser(page, targetUsername);
        await this.persistSession(page, 'reddit', accountId);
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
          /proxy|err_tunnel|err_timed_out|err_proxy|tunnel_connection|net::err_/i.test(msg);
        console.warn(
          `Reddit follow via ${mode.skipProxy ? 'direct' : 'proxy'} failed for #${accountId}: ${msg}` +
            (canRetryDirect ? ' — retrying direct' : '')
        );
        if (!canRetryDirect) break;
      } finally {
        if (browser) {
          try { await browser.close(); } catch { /* ignore */ }
        }
        this._untrackBrowser(accountId);
      }
    }
    throw lastError || new Error('Reddit follow failed');
  }

  /**
   * Discover follow targets from hot subreddit threads (post authors + commenters).
   */
  async discoverRedditFollowTargets(accountId, {
    subreddits = [],
    limit = 12,
    requireProxy = true,
  } = {}) {
    const account = await this.getAccount(accountId);
    if (String(account.platform || '').toLowerCase() !== 'reddit') {
      throw new Error(`Account ${accountId} is ${account.platform}, expected reddit`);
    }
    const creds =
      typeof account.credentials === 'string'
        ? JSON.parse(account.credentials)
        : account.credentials || {};
    const password = creds.password || account.credentials?.password;
    const subs = (subreddits || []).map((s) => String(s).replace(/^r\//i, '').trim()).filter(Boolean);
    if (!subs.length) {
      return { targets: [], subreddits: [] };
    }

    let browser;
    try {
      if (requireProxy) await this.requireProxyForLive(accountId);
      const result = await this.createBrowserForAccount(accountId, 2, { requireProxy });
      browser = result.browser;
      const page = result.page;

      await this.ensureLoggedIn(page, 'reddit', accountId, account.username, password, {
        allowLogin: true,
      }).catch(() => false);

      const seen = new Set();
      const targets = [];
      const self = String(account.username || '').toLowerCase();

      for (const sub of subs.slice(0, 3)) {
        if (targets.length >= limit) break;
        await page.goto(`https://www.reddit.com/r/${encodeURIComponent(sub)}/hot/`, {
          waitUntil: 'domcontentloaded',
          timeout: 90000,
        });
        await this.humanLikeDelay(2000, 4000);
        await this.randomScroll(page).catch(() => {});

        const fromListing = await page.evaluate((max) => {
          const out = [];
          const junk = /^(home|popular|all|login|register|submit|settings|message|chat|premium|coins)$/i;
          for (const a of document.querySelectorAll('a[href*="/user/"]')) {
            const m = (a.getAttribute('href') || '').match(/\/user\/([^/?#]+)/i);
            if (!m) continue;
            const handle = decodeURIComponent(m[1]);
            if (junk.test(handle) || handle.length < 2) continue;
            out.push({ handle, source: 'listing_author' });
            if (out.length >= max) break;
          }
          return out;
        }, 8);

        for (const t of fromListing) {
          const h = String(t.handle || '').toLowerCase();
          if (!h || h === self || seen.has(h)) continue;
          seen.add(h);
          targets.push({ handle: t.handle, category: 'discovered', source: `r/${sub}:${t.source}` });
          if (targets.length >= limit) break;
        }

        // Open one hot thread and skim commenters
        if (targets.length < limit) {
          const postHref = await page.evaluate(() => {
            const a = document.querySelector('a[href*="/comments/"]');
            return a ? a.href : null;
          });
          if (postHref) {
            await page.goto(postHref, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
            await this.humanLikeDelay(2000, 3500);
            await this.randomScroll(page).catch(() => {});
            const commenters = await page.evaluate((max) => {
              const out = [];
              const junk = /^(home|popular|all|AutoModerator)$/i;
              for (const a of document.querySelectorAll('a[href*="/user/"]')) {
                const m = (a.getAttribute('href') || '').match(/\/user\/([^/?#]+)/i);
                if (!m) continue;
                const handle = decodeURIComponent(m[1]);
                if (junk.test(handle)) continue;
                out.push({ handle, source: 'commenter' });
                if (out.length >= max) break;
              }
              return out;
            }, 10);
            for (const t of commenters) {
              const h = String(t.handle || '').toLowerCase();
              if (!h || h === self || seen.has(h)) continue;
              seen.add(h);
              targets.push({ handle: t.handle, category: 'discovered', source: `r/${sub}:${t.source}` });
              if (targets.length >= limit) break;
            }
          }
        }
      }

      await this.persistSession(page, 'reddit', accountId).catch(() => {});
      return { targets: targets.slice(0, limit), subreddits: subs };
    } finally {
      if (browser) await browser.close().catch(() => {});
      this._untrackBrowser(accountId);
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
      'SELECT id, username, email, credentials, platform, status, is_simulated, device_profile FROM social_accounts WHERE id = $1',
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
      if (/incorrect|password was incorrect|login information you entered is incorrect|bad_credentials/i.test(lastHint || '')) {
        throw new Error(`Instagram login failed: bad_credentials — ${lastHint}`);
      }
      return false;
    } catch (error) {
      console.error('IG login error:', error);
      await page.screenshot({ path: `/tmp/ig-login-error-${username}.png`, fullPage: true }).catch(() => {});
      if (/bad_credentials|temporarily limited|try again later|rate.?limit/i.test(error.message || '')) {
        throw error;
      }
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
      let lastError = null;
      // LinkedIn frequently serves captcha on residential/mobile proxies for fresh logins.
      // Prefer direct first when proxy is optional; then retry via sticky proxy for session reuse.
      if (!requireProxy) {
        try {
          loggedIn = await tryOnce(false);
        } catch (err) {
          lastError = err;
          console.warn(`LinkedIn direct login path failed (${err.message}); retrying with proxy`);
        }
      }
      if (!loggedIn) {
        try {
          loggedIn = await tryOnce(true);
        } catch (err) {
          lastError = err;
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
        error: loggedIn ? null : (lastError?.message || 'login_failed'),
        classification: loggedIn
          ? 'ok'
          : this.classifyLinkedInLoginFailure(lastError?.message),
      };
    } catch (error) {
      if (proxyId) {
        await proxyService.updateProxyStats(proxyId, false, { reason: error.message }).catch(() => {});
      }
      return {
        success: false,
        accountId,
        error: error.message,
        classification: this.classifyLinkedInLoginFailure(error.message),
      };
    } finally {
      if (browser) await browser.close();
      this._untrackBrowser(accountId);
    }
  }

  /** Map a LinkedIn login failure message to a coarse, safety-relevant class. */
  classifyLinkedInLoginFailure(message) {
    const msg = String(message || '');
    if (/id_verification_restricted|government-ID|verify your identity|restricted/i.test(msg)) {
      return 'id_verification_required';
    }
    if (/checkpoint|captcha|security check|challenge|2fa|totp|pin|app.?push/i.test(msg)) {
      return 'checkpoint';
    }
    if (/tunnel|timed_out|timeout|proxy|ECONN|ENOTFOUND|socket|net::/i.test(msg)) {
      return 'connect_error';
    }
    if (/wrong email or password|bad credentials|doesn.?t match|incorrect/i.test(msg)) {
      return 'bad_credentials';
    }
    return 'login_failed';
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
