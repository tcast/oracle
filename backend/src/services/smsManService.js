const axios = require('axios');

/**
 * SMS-Man API Integration Service (control API v2)
 * Docs: https://sms-man.com/site/docs-apiv2
 * USA-only policy for email signup SMS.
 */
class SmsManService {
  constructor() {
    this.apiKey = (process.env.SMSMAN_API_KEY || '').trim();
    this.apiUrl = (process.env.SMSMAN_API_URL || 'https://api.sms-man.com/control').replace(/\/$/, '');
    this.smsManApiIssue = false;

    // SMS-Man country_id / application_id
    this.countryIds = {
      US: 5,
      USA: 5,
      usa: 5,
    };
    this.applicationIds = {
      yahoo: 136,
      mb: 136,
      gmx: 5141,
      GMX: 5141,
      microsoft: 133,
      outlook: 133,
      hotmail: 133,
      gmail: 122,
      google: 122,
      reddit: 5512,
      Reddit: 5512,
    };

    if (!this.apiKey) {
      console.warn('⚠️  SMSMAN_API_KEY not configured - SMS verification will not work');
      this.smsManApiIssue = true;
    } else {
      this.validateApiKey();
    }
  }

  async validateApiKey() {
    try {
      const balance = await this.getBalance();
      console.log(`✅ SMS-Man API connected - Balance: ${balance}`);
      this.smsManApiIssue = false;
    } catch (error) {
      console.error('❌ SMS-Man API validation error:', error.message);
      this.smsManApiIssue = true;
    }
  }

  async getBalance() {
    const response = await axios.get(`${this.apiUrl}/get-balance`, {
      params: { token: this.apiKey },
      timeout: 10000,
    });
    if (response.data?.balance === undefined) {
      throw new Error(`Invalid SMS-Man balance response: ${JSON.stringify(response.data)}`);
    }
    return parseFloat(response.data.balance) || 0;
  }

  resolveCountryId(country = 'US') {
    const key = String(country);
    const id = this.countryIds[key] || this.countryIds[key.toUpperCase()] || Number(country);
    if (Number(id) !== 5) {
      throw new Error(`USA-only policy: refusing SMS-Man country_id=${id}`);
    }
    return 5;
  }

  resolveApplicationId(service = 'yahoo') {
    const key = String(service);
    const id = this.applicationIds[key] || this.applicationIds[key.toLowerCase()] || Number(service);
    if (!id || Number.isNaN(Number(id))) {
      throw new Error(`Unknown SMS-Man service: ${service}`);
    }
    return Number(id);
  }

  /**
   * @param {string} country - US only
   * @param {string} service - yahoo | gmx | ...
   */
  async getNumber(country = 'US', service = 'yahoo') {
    if (this.smsManApiIssue) {
      throw new Error('SMS-Man API is not configured or unavailable');
    }

    const countryId = this.resolveCountryId(country);
    const applicationId = this.resolveApplicationId(service);

    try {
      const response = await axios.get(`${this.apiUrl}/get-number`, {
        params: {
          token: this.apiKey,
          country_id: countryId,
          application_id: applicationId,
        },
        timeout: 15000,
      });

      const data = response.data;
      if (data?.error_code || data?.error_msg) {
        throw new Error(data.error_msg || `SMS-Man error ${data.error_code}`);
      }

      const requestId = data.request_id;
      let number = String(data.number || '');
      if (!requestId || !number) {
        throw new Error(`Invalid SMS-Man response: ${JSON.stringify(data)}`);
      }

      // Normalize to E.164 +1…
      number = number.replace(/\D/g, '');
      if (number.length === 10) number = `1${number}`;
      if (!/^1\d{10}$/.test(number)) {
        await this.cancelRequest(requestId);
        throw new Error(`USA-only policy: refusing non-US phone ${data.number}`);
      }
      number = `+${number}`;

      console.log(`📱 SMS-Man number acquired: ${number} (US/${service} app=${applicationId})`);
      return {
        id: String(requestId),
        number,
        country: 'usa',
        service,
        provider: 'smsman',
      };
    } catch (error) {
      if (error.response?.data) {
        const errorMsg =
          error.response.data.error_msg ||
          error.response.data.error ||
          JSON.stringify(error.response.data);
        throw new Error(`SMS-Man error: ${errorMsg}`);
      }
      throw new Error(`Failed to get phone number: ${error.message}`);
    }
  }

  async getVerificationCode(requestId, timeout = 180000) {
    const startTime = Date.now();
    const pollInterval = 3000;
    let attempts = 0;

    console.log(`⏳ Waiting for SMS-Man code (request ${requestId})...`);

    while (Date.now() - startTime < timeout) {
      attempts++;
      try {
        const response = await axios.get(`${this.apiUrl}/get-sms`, {
          params: {
            token: this.apiKey,
            request_id: requestId,
          },
          timeout: 10000,
        });

        const data = response.data || {};
        const code = data.sms_code || data.code;
        if (code) {
          console.log(`✅ SMS-Man code received: ${code} (after ${attempts} attempts)`);
          return { code: String(code), timestamp: new Date() };
        }

        if (data.error_code === 'wait_sms' || data.error_msg === 'wait_sms') {
          // still waiting
        } else if (data.status === 'CANCELLED' || data.status === 'EXPIRED') {
          throw new Error(`SMS request ${String(data.status).toLowerCase()}`);
        }
      } catch (error) {
        if (error.message.includes('cancelled') || error.message.includes('expired')) {
          throw error;
        }
        console.warn(`SMS-Man poll attempt ${attempts} failed:`, error.message);
      }

      const waitTime = Math.min(pollInterval * Math.pow(1.15, attempts / 5), 8000);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    console.error(`❌ SMS-Man code timeout after ${timeout / 1000}s`);
    await this.cancelRequest(requestId);
    throw new Error('SMS verification timeout - no code received');
  }

  async cancelRequest(requestId) {
    try {
      await axios.get(`${this.apiUrl}/set-status`, {
        params: {
          token: this.apiKey,
          request_id: requestId,
          status: 'reject',
        },
        timeout: 10000,
      });
      console.log(`🚫 SMS-Man request ${requestId} cancelled`);
    } catch (error) {
      // Alternate cancel endpoint used by some SMS-Man versions
      try {
        await axios.get(`${this.apiUrl}/reject-number`, {
          params: { token: this.apiKey, request_id: requestId },
          timeout: 10000,
        });
        console.log(`🚫 SMS-Man request ${requestId} rejected`);
      } catch (e2) {
        console.error('Error cancelling SMS-Man request:', error.message);
      }
    }
  }

  async healthCheck() {
    try {
      if (!this.apiKey) {
        return { status: 'unavailable', message: 'API key not configured', balance: null };
      }
      const balance = await this.getBalance();
      return {
        status: balance > 0 ? 'online' : 'low_balance',
        message: balance > 0 ? 'Service operational' : 'Balance too low',
        balance,
      };
    } catch (error) {
      return { status: 'error', message: error.message, balance: null };
    }
  }
}

module.exports = new SmsManService();
