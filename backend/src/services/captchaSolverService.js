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

    try {
      // Try 2Captcha first (primary solver)
      if (this.twoCaptchaKey && !this.twoCaptchaIssue) {
        console.log('   Attempting with 2Captcha...');
        return await this.solve2Captcha(siteKey, pageUrl, captchaType, version, opts);
      }
    } catch (error) {
      console.warn('   2Captcha failed, trying CapSolver:', error.message);
    }

    // Fallback to CapSolver
    if (this.capSolverKey && !this.capSolverIssue) {
      console.log('   Attempting with CapSolver...');
      return await this.solveCapSolver(siteKey, pageUrl, captchaType, version, opts);
    }

    throw new Error('No CAPTCHA solver available or all solvers failed');
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
        submitParams.action = version || 'submit';
        submitParams.min_score = 0.3;
      } else if (captchaType === 'hcaptcha') {
        submitParams.method = 'hcaptcha';
      }

      if (opts.invisible && captchaType === 'recaptcha_v2') {
        submitParams.invisible = 1;
      }
      if (opts.enterprise && captchaType.startsWith('recaptcha')) {
        submitParams.enterprise = 1;
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
            taskType = 'ReCaptchaV2EnterpriseTaskProxyLess';
          } else {
            taskType = 'ReCaptchaV2TaskProxyLess';
          }
          if (opts.invisible) taskData.isInvisible = true;
          break;
        case 'recaptcha_v3':
          taskType = opts.enterprise
            ? 'ReCaptchaV3EnterpriseTaskProxyLess'
            : 'ReCaptchaV3TaskProxyLess';
          taskData.pageAction = version || 'submit';
          taskData.minScore = 0.3;
          break;
        case 'hcaptcha':
          taskType = 'HCaptchaTaskProxyLess';
          break;
        default:
          taskType = opts.enterprise
            ? 'ReCaptchaV2EnterpriseTaskProxyLess'
            : 'ReCaptchaV2TaskProxyLess';
          if (opts.invisible) taskData.isInvisible = true;
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
        throw new Error(`CapSolver error: ${createResponse.data.errorDescription}`);
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
              '#g-recaptcha-response, textarea[name="g-recaptcha-response"], textarea.g-recaptcha-response, [name="h-captcha-response"]'
            ),
          ];
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

        // Also try enterprise / standard grecaptcha helpers if present
        try {
          if (window.grecaptcha?.enterprise) {
            const clients = window.___grecaptcha_cfg?.clients || {};
            const more = findCallbacks(clients);
            for (const cb of more) {
              try {
                cb(token);
                callbacks += 1;
              } catch (_) {
                /* ignore */
              }
            }
          }
        } catch (_) {
          /* ignore */
        }

        return { fields, callbacks };
      }, token);

      console.log(
        `   ✅ CAPTCHA token injected into page (fields=${result.fields} callbacks=${result.callbacks})`
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
