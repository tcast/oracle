const axios = require('axios');

/**
 * Dual CAPTCHA Solver Service
 * Primary: 2Captcha (cheaper, reliable for most CAPTCHAs)
 * Fallback: CapSolver (better for modern reCAPTCHA v3, hCaptcha, complex challenges)
 */
class CaptchaSolverService {
  constructor() {
    this.twoCaptchaKey = (process.env.TWOCAPTCHA_API_KEY || '').trim();
    this.capSolverKey = (process.env.CAPSOLVER_API_KEY || '').trim();

    this.twoCaptchaSubmitUrl = 'https://2captcha.com/in.php';
    this.twoCaptchaResultUrl = 'https://2captcha.com/res.php';
    this.capSolverUrl = 'https://api.capsolver.com/createTask';

    this.twoCaptchaIssue = false;
    this.capSolverIssue = false;

    if (!this.twoCaptchaKey && !this.capSolverKey) {
      console.warn('⚠️  No CAPTCHA solver API keys configured');
    } else {
      if (this.twoCaptchaKey) this.validate2Captcha();
      if (this.capSolverKey) this.validateCapSolver();
    }
  }

  /**
   * Validate 2Captcha API key
   */
  async validate2Captcha() {
    try {
      const response = await axios.get(this.twoCaptchaResultUrl, {
        params: {
          key: this.twoCaptchaKey,
          action: 'getbalance',
          json: 1
        },
        timeout: 10000
      });

      if (response.data && response.data.status === 1) {
        console.log(`✅ 2Captcha API connected - Balance: $${response.data.request}`);
        this.twoCaptchaIssue = false;
      } else {
        console.error('❌ 2Captcha API validation failed');
        this.twoCaptchaIssue = true;
      }
    } catch (error) {
      console.error('❌ 2Captcha validation error:', error.message);
      this.twoCaptchaIssue = true;
    }
  }

  /**
   * Validate CapSolver API key
   */
  async validateCapSolver() {
    try {
      const response = await axios.post(`${this.capSolverUrl.replace('/createTask', '/getBalance')}`, {
        clientKey: this.capSolverKey
      }, {
        timeout: 10000
      });

      if (response.data && response.data.errorId === 0) {
        console.log(`✅ CapSolver API connected - Balance: $${response.data.balance}`);
        this.capSolverIssue = false;
      } else {
        console.error('❌ CapSolver API validation failed');
        this.capSolverIssue = true;
      }
    } catch (error) {
      console.error('❌ CapSolver validation error:', error.message);
      this.capSolverIssue = true;
    }
  }

  /**
   * Solve CAPTCHA with automatic fallback
   * @param {string} siteKey - Google reCAPTCHA site key
   * @param {string} pageUrl - URL of the page with CAPTCHA
   * @param {string} captchaType - Type: 'recaptcha_v2', 'recaptcha_v3', 'hcaptcha'
   * @param {number} version - For reCAPTCHA v3: version number
   * @param {Object} opts - Extra options ({ invisible: boolean })
   * @returns {Promise<string>} CAPTCHA solution token
   */
  async solveCaptcha(siteKey, pageUrl, captchaType = 'recaptcha_v2', version = null, opts = {}) {
    console.log(
      `🧩 Solving ${captchaType}${opts.enterprise ? ' enterprise' : ''}${opts.invisible ? ' invisible' : ''} CAPTCHA for ${pageUrl}`
    );

    const try2Captcha = async () => {
      if (!this.twoCaptchaKey || this.twoCaptchaIssue) throw new Error('2Captcha unavailable');
      console.log('   Attempting with 2Captcha...');
      return this.solve2Captcha(siteKey, pageUrl, captchaType, version, opts);
    };
    const tryCapSolver = async () => {
      if (!this.capSolverKey || this.capSolverIssue) throw new Error('CapSolver unavailable');
      console.log('   Attempting with CapSolver...');
      return this.solveCapSolver(siteKey, pageUrl, captchaType, version, opts);
    };

    // Enterprise: CapSolver first (2Captcha often returns ERROR_CAPTCHA_UNSOLVABLE for Reddit)
    // When action/data-s present, prefer 2Captcha — CapSolver proxy enterprise often 400s on Reddit.
    if (opts.proxyConfig?.server) {
      console.log('   Using session proxy for captcha solve (IP match)');
    }
    const hasEnterpriseExtras = !!(
      opts.action ||
      opts.dataS ||
      opts.enterprisePayload?.s
    );
    const order = opts.enterprise
      ? hasEnterpriseExtras
        ? [try2Captcha, tryCapSolver]
        : [tryCapSolver, try2Captcha]
      : [try2Captcha, tryCapSolver];
    let lastErr;
    for (const fn of order) {
      try {
        return await fn();
      } catch (error) {
        lastErr = error;
        console.warn(`   Solver attempt failed: ${error.message}`);
      }
    }

    throw lastErr || new Error('No CAPTCHA solver available or all solvers failed');
  }

  /**
   * Solve CAPTCHA using 2Captcha
   * @private
   */
  async solve2Captcha(siteKey, pageUrl, captchaType, version, opts = {}) {
    try {
      // Step 1: Submit CAPTCHA task
      const submitParams = {
        key: this.twoCaptchaKey,
        method: 'userrecaptcha',
        googlekey: siteKey,
        pageurl: pageUrl,
        json: 1
      };

      if (captchaType === 'recaptcha_v3') {
        submitParams.version = 'v3';
        submitParams.action = opts.action || version || 'submit';
        submitParams.min_score = opts.minScore || 0.7;
      } else if (captchaType === 'hcaptcha') {
        submitParams.method = 'hcaptcha';
      }

      if (opts.invisible && captchaType === 'recaptcha_v2') {
        submitParams.invisible = 1;
      }
      if (opts.enterprise && captchaType.startsWith('recaptcha')) {
        submitParams.enterprise = 1;
      }
      // Enterprise session binding (data-s / s) — required by some sites including Reddit
      const dataS =
        opts.dataS ||
        opts.enterprisePayload?.s ||
        (typeof opts.enterprisePayload === 'string' ? opts.enterprisePayload : null);
      if (dataS) {
        submitParams['data-s'] = dataS;
      }
      if (opts.action && captchaType === 'recaptcha_v2') {
        // Some Enterprise invisible flows still pass action into execute()
        submitParams.action = opts.action;
      }
      if (opts.proxyConfig?.server) {
        const raw = String(opts.proxyConfig.server)
          .replace(/^https?:\/\//i, '')
          .replace(/^socks5:\/\//i, '');
        const user = opts.proxyConfig.username || '';
        const pass = opts.proxyConfig.password || '';
        submitParams.proxy = user
          ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${raw}`
          : raw;
        submitParams.proxytype = String(opts.proxyConfig.server).startsWith('socks5')
          ? 'SOCKS5'
          : 'HTTP';
      }

      const submitResponse = await axios.get(this.twoCaptchaSubmitUrl, {
        params: submitParams,
        timeout: 15000
      });

      if (submitResponse.data.status !== 1) {
        throw new Error(`2Captcha submission failed: ${submitResponse.data.request}`);
      }

      const taskId = submitResponse.data.request;
      console.log(`   2Captcha task submitted: ${taskId}`);

      // Step 2: Poll for solution (typically takes 10-30 seconds)
      const maxAttempts = 40; // 40 attempts * 3 seconds = 120 seconds max
      let attempts = 0;

      while (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 seconds
        attempts++;

        const resultResponse = await axios.get(this.twoCaptchaResultUrl, {
          params: {
            key: this.twoCaptchaKey,
            action: 'get',
            id: taskId,
            json: 1
          },
          timeout: 10000
        });

        if (resultResponse.data.status === 1) {
          // Solution found
          console.log(`   ✅ 2Captcha solved in ${attempts * 3}s`);
          return resultResponse.data.request;
        }

        if (resultResponse.data.request !== 'CAPCHA_NOT_READY') {
          // Error occurred
          throw new Error(`2Captcha error: ${resultResponse.data.request}`);
        }

        // Still processing, continue polling
      }

      throw new Error('2Captcha timeout - solution not ready after 120s');
    } catch (error) {
      console.error('2Captcha error:', error.message);
      throw error;
    }
  }

  /**
   * Solve CAPTCHA using CapSolver
   * @private
   */
  async solveCapSolver(siteKey, pageUrl, captchaType, version, opts = {}) {
    try {
      // Step 1: Create task
      let taskType;
      let taskData = {
        websiteURL: pageUrl,
        websiteKey: siteKey
      };

      switch (captchaType) {
        case 'recaptcha_v2':
          if (opts.enterprise) {
            taskType = opts.proxyConfig?.server
              ? 'ReCaptchaV2EnterpriseTask'
              : 'ReCaptchaV2EnterpriseTaskProxyLess';
          } else {
            taskType = opts.proxyConfig?.server
              ? 'ReCaptchaV2Task'
              : 'ReCaptchaV2TaskProxyLess';
          }
          if (opts.invisible) taskData.isInvisible = true;
          if (opts.enterprisePayload && typeof opts.enterprisePayload === 'object') {
            taskData.enterprisePayload = opts.enterprisePayload;
          } else if (opts.dataS) {
            taskData.enterprisePayload = { s: opts.dataS };
          }
          if (opts.action) taskData.pageAction = opts.action;
          break;
        case 'recaptcha_v3':
          taskType = opts.enterprise
            ? opts.proxyConfig?.server
              ? 'ReCaptchaV3EnterpriseTask'
              : 'ReCaptchaV3EnterpriseTaskProxyLess'
            : opts.proxyConfig?.server
              ? 'ReCaptchaV3Task'
              : 'ReCaptchaV3TaskProxyLess';
          taskData.pageAction = opts.action || version || 'submit';
          taskData.minScore = opts.minScore || 0.7;
          if (opts.enterprisePayload && typeof opts.enterprisePayload === 'object') {
            taskData.enterprisePayload = opts.enterprisePayload;
          } else if (opts.dataS) {
            taskData.enterprisePayload = { s: opts.dataS };
          }
          break;
        case 'hcaptcha':
          taskType = 'HCaptchaTaskProxyLess';
          break;
        default:
          taskType = opts.enterprise
            ? opts.proxyConfig?.server
              ? 'ReCaptchaV2EnterpriseTask'
              : 'ReCaptchaV2EnterpriseTaskProxyLess'
            : 'ReCaptchaV2TaskProxyLess';
          if (opts.invisible) taskData.isInvisible = true;
      }

      if (opts.proxyConfig?.server && !/ProxyLess$/i.test(taskType)) {
        const raw = String(opts.proxyConfig.server)
          .replace(/^https?:\/\//i, '')
          .replace(/^socks5:\/\//i, '');
        const [host, portStr] = raw.split(':');
        taskData.proxyType = String(opts.proxyConfig.server).startsWith('socks5')
          ? 'socks5'
          : 'http';
        taskData.proxyAddress = host;
        taskData.proxyPort = parseInt(portStr, 10) || 80;
        if (opts.proxyConfig.username) {
          taskData.proxyLogin = opts.proxyConfig.username;
          taskData.proxyPassword = opts.proxyConfig.password || '';
        }
      }

      const createResponse = await axios.post(this.capSolverUrl, {
        clientKey: this.capSolverKey,
        task: {
          type: taskType,
          ...taskData
        }
      }, {
        timeout: 15000
      });

      if (createResponse.data.errorId !== 0) {
        throw new Error(
          `CapSolver error: ${createResponse.data.errorDescription || createResponse.data.errorCode || 'unknown'} (task=${taskType})`
        );
      }

      const taskId = createResponse.data.taskId;
      console.log(`   CapSolver task created: ${taskId}`);

      // Step 2: Poll for solution
      const getResultUrl = this.capSolverUrl.replace('/createTask', '/getTaskResult');
      const maxAttempts = 40;
      let attempts = 0;

      while (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        attempts++;

        const resultResponse = await axios.post(getResultUrl, {
          clientKey: this.capSolverKey,
          taskId
        }, {
          timeout: 10000
        });

        if (resultResponse.data.errorId !== 0) {
          throw new Error(`CapSolver error: ${resultResponse.data.errorDescription}`);
        }

        if (resultResponse.data.status === 'ready') {
          console.log(`   ✅ CapSolver solved in ${attempts * 3}s`);
          return resultResponse.data.solution.gRecaptchaResponse;
        }

        // Still processing
      }

      throw new Error('CapSolver timeout - solution not ready after 120s');
    } catch (error) {
      if (error.response?.status) {
        const detail = JSON.stringify(error.response.data || {}).slice(0, 240);
        console.error(`CapSolver error: HTTP ${error.response.status} ${detail}`);
        throw new Error(`CapSolver HTTP ${error.response.status}: ${detail || error.message}`);
      }
      console.error('CapSolver error:', error.message);
      throw error;
    }
  }

  /**
   * Inject CAPTCHA token into page
   * @param {Object} page - Playwright page object
   * @param {string} token - CAPTCHA solution token
   */
  async injectCaptchaToken(page, token) {
    try {
      const result = await page.evaluate((token) => {
        const setResponseFields = () => {
          const nodes = [
            ...document.querySelectorAll(
              '#g-recaptcha-response, textarea[name="g-recaptcha-response"], textarea.g-recaptcha-response, [name="h-captcha-response"], [name="g-recaptcha-response"]'
            ),
          ];
          // Create hidden response field if Reddit never rendered one
          if (!nodes.length) {
            const ta = document.createElement('textarea');
            ta.id = 'g-recaptcha-response';
            ta.name = 'g-recaptcha-response';
            ta.style.display = 'none';
            document.body.appendChild(ta);
            nodes.push(ta);
          }
          for (const el of nodes) {
            el.value = token;
            el.innerHTML = token;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
          return nodes.length;
        };

        const findCallbacks = (obj, found = [], seen = new WeakSet()) => {
          if (!obj || typeof obj !== 'object') return found;
          if (seen.has(obj)) return found;
          try {
            seen.add(obj);
          } catch (_) {
            return found;
          }
          for (const key of Object.keys(obj)) {
            let val;
            try {
              val = obj[key];
            } catch (_) {
              continue;
            }
            if (
              (key === 'callback' || key === 'promise-callback' || key === 'promiseCallback') &&
              typeof val === 'function'
            ) {
              found.push(val);
            } else if (val && typeof val === 'object') {
              findCallbacks(val, found, seen);
            }
          }
          return found;
        };

        const fields = setResponseFields();
        let callbacks = 0;
        const cfg = window.___grecaptcha_cfg;
        if (cfg && cfg.clients) {
          const cbs = findCallbacks(cfg.clients);
          for (const cb of cbs) {
            try {
              cb(token);
              callbacks += 1;
            } catch (_) {
              /* ignore individual callback failures */
            }
          }
        }

        // Reddit shreddit uses grecaptcha.enterprise.execute() — override so
        // verify_phone_by_code_initialize receives our solved token.
        let executeHooked = false;
        try {
          const g = window.grecaptcha;
          if (g?.enterprise) {
            g.enterprise.execute = async () => token;
            g.enterprise.getResponse = () => token;
            executeHooked = true;
          }
          if (g) {
            g.execute = async () => token;
            g.getResponse = () => token;
          }
        } catch (_) {
          /* ignore */
        }

        // Persist for late execute calls after navigation within SPA
        window.__oracleRecaptchaToken = token;

        return { fields, callbacks, executeHooked };
      }, token);

      console.log(
        `   ✅ CAPTCHA token injected (fields=${result.fields} callbacks=${result.callbacks} executeHooked=${result.executeHooked})`
      );
    } catch (error) {
      console.error('Error injecting CAPTCHA token:', error);
      throw new Error('Failed to inject CAPTCHA token');
    }
  }

  /**
   * Health check for CAPTCHA solvers
   * @returns {Promise<Object>} Service status
   */
  async healthCheck() {
    const status = {
      twoCaptcha: { status: 'unavailable', balance: null },
      capSolver: { status: 'unavailable', balance: null }
    };

    // Check 2Captcha
    if (this.twoCaptchaKey) {
      try {
        const response = await axios.get(this.twoCaptchaResultUrl, {
          params: {
            key: this.twoCaptchaKey,
            action: 'getbalance',
            json: 1
          },
          timeout: 10000
        });

        if (response.data.status === 1) {
          status.twoCaptcha = {
            status: 'online',
            balance: parseFloat(response.data.request)
          };
        }
      } catch (error) {
        status.twoCaptcha.status = 'error';
        status.twoCaptcha.message = error.message;
      }
    }

    // Check CapSolver
    if (this.capSolverKey) {
      try {
        const response = await axios.post(this.capSolverUrl.replace('/createTask', '/getBalance'), {
          clientKey: this.capSolverKey
        }, {
          timeout: 10000
        });

        if (response.data.errorId === 0) {
          status.capSolver = {
            status: 'online',
            balance: response.data.balance
          };
        }
      } catch (error) {
        status.capSolver.status = 'error';
        status.capSolver.message = error.message;
      }
    }

    return status;
  }
}

module.exports = new CaptchaSolverService();
