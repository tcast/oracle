const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const pool = require('./db');
const proxyService = require('./proxyService');
const { generatePassword } = require('../utils/passwordGenerator');
const mailTmService = require('./mailTmService');

// Apply stealth plugin
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
      headless: false, // Set to true for production
      args,
      ignoreDefaultArgs: ['--enable-automation'],
    };

    if (proxyConfig) {
      options.proxy = {
        server: proxyConfig.server,
        username: proxyConfig.username,
        password: proxyConfig.password
      };
    }

    const browser = await chromium.launch(options);
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });

    // Anti-detection measures
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
    });

    const page = await context.newPage();
    return { browser, context, page };
  }

  async humanLikeDelay(min = 500, max = 2000) {
    const delay = Math.floor(Math.random() * (max - min + 1) + min);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  async humanLikeTyping(page, selector, text) {
    await page.click(selector);
    await this.humanLikeDelay(200, 500);
    
    for (const char of text) {
      await page.keyboard.type(char);
      await this.humanLikeDelay(50, 200);
    }
  }

  async createRedditAccount(username, email, password, proxyConfig = null, emailToken = null) {
    let browser;
    try {
      const { browser: b, page } = await this.createBrowser(proxyConfig);
      browser = b;

      await page.goto('https://www.reddit.com/register', { waitUntil: 'networkidle' });
      await this.humanLikeDelay();

      await this.humanLikeTyping(page, 'input[name="email"]', email);
      await this.humanLikeDelay();
      
      await this.humanLikeTyping(page, 'input[name="username"]', username);
      await this.humanLikeDelay();
      
      await this.humanLikeTyping(page, 'input[name="password"]', password);
      await this.humanLikeDelay();
      
      const captchaPresent = await page.isVisible('iframe[title*="recaptcha"], iframe[src*="captcha"]');
      if (captchaPresent) {
        console.log('CAPTCHA detected - solving required');
      }
      
      await page.click('button[type="submit"]');
      await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
      
      const loggedIn = await page.isVisible('[aria-label="User menu"]');
      
      if (loggedIn && emailToken) {
        console.log('Account created, checking for verification email...');
        try {
          const { link } = await mailTmService.pollForVerificationLink(emailToken, 60000, 3000);
          console.log('Verification link found, navigating...');
          await page.goto(link, { waitUntil: 'networkidle' });
          await this.humanLikeDelay();
        } catch (verifyErr) {
          console.warn('Email verification polling failed:', verifyErr.message);
        }
        return { success: true, username, email, password, email_verified: true };
      }
      
      if (loggedIn) {
        return { success: true, username, email, password, email_verified: false };
      } else {
        throw new Error('Account creation failed - not logged in after registration');
      }
    } catch (error) {
      console.error('Error creating Reddit account:', error);
      throw error;
    } finally {
      if (browser) {
        await browser.close();
      }
    }
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
        console.log('Phone verification required for X account creation');
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
      if (browser) {
        await browser.close();
      }
    }
  }

  async createAccounts(platform, count, emailDomain = null, usernamePrefix = null, proxyConfigs = []) {
    const accounts = [];
    
    for (let i = 0; i < count; i++) {
      try {
        let email, emailToken, username;
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
            account = await this.createRedditAccount(username, email, password, proxyConfig, emailToken);
            break;
          case 'x':
            account = await this.createXAccount(username, email, password, proxyConfig, emailToken);
            break;
          default:
            throw new Error(`Platform ${platform} not supported`);
        }

        const credentials = { password };
        if (emailToken) {
          credentials.emailToken = emailToken;
        }

        const result = await pool.query(
          `INSERT INTO social_accounts 
           (platform, username, email, credentials, status, is_simulated, proxy_config)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [
            platform,
            username,
            email,
            credentials,
            'active',
            false,
            proxyConfig
          ]
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