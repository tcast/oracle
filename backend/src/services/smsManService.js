const axios = require('axios');

/**
 * SMS-Man API Integration Service
 * Provides phone numbers for SMS verification during email account creation
 * Documentation: https://sms-man.com/api
 */
class SmsManService {
  constructor() {
    this.apiKey = (process.env.SMSMAN_API_KEY || '').trim();
    this.apiUrl = process.env.SMSMAN_API_URL || 'https://api.sms-man.com/stubs/handler_api.php';
    this.smsManApiIssue = false;

    if (!this.apiKey) {
      console.warn('⚠️  SMSMAN_API_KEY not configured - SMS verification will not work');
      this.smsManApiIssue = true;
    } else {
      this.validateApiKey();
    }
  }

  /**
   * Validate API key on service initialization
   */
  async validateApiKey() {
    try {
      const response = await axios.get(this.apiUrl, {
        params: {
          action: 'getBalance',
          api_key: this.apiKey
        },
        timeout: 10000
      });

      if (response.data && response.data.balance !== undefined) {
        console.log(`✅ SMS-Man API connected - Balance: $${response.data.balance}`);
        this.smsManApiIssue = false;
      } else {
        console.error('❌ SMS-Man API key validation failed - Invalid response');
        this.smsManApiIssue = true;
      }
    } catch (error) {
      console.error('❌ SMS-Man API validation error:', error.message);
      this.smsManApiIssue = true;
    }
  }

  /**
   * Get current account balance
   * @returns {Promise<number>} Balance in USD
   */
  async getBalance() {
    try {
      const response = await axios.get(this.apiUrl, {
        params: {
          action: 'getBalance',
          api_key: this.apiKey
        },
        timeout: 10000
      });

      return parseFloat(response.data.balance) || 0;
    } catch (error) {
      console.error('Error getting SMS-Man balance:', error);
      throw new Error('Failed to get SMS-Man balance');
    }
  }

  /**
   * Get phone number for verification
   * @param {string} country - Country code (US, RU, UK, etc.)
   * @param {string} service - Service name ('yandex', 'gmx', 'gmail', etc.)
   * @returns {Promise<Object>} { id, number, country }
   */
  async getNumber(country = 'RU', service = 'yandex') {
    if (this.smsManApiIssue) {
      throw new Error('SMS-Man API is not configured or unavailable');
    }

    try {
      const response = await axios.get(this.apiUrl, {
        params: {
          action: 'getNumber',
          api_key: this.apiKey,
          service,
          country
        },
        timeout: 15000
      });

      // Response format: { request_id: "123", number: "1234567890" }
      if (response.data && response.data.request_id && response.data.number) {
        console.log(`📱 SMS-Man number acquired: ${response.data.number} (${country}/${service})`);
        return {
          id: response.data.request_id,
          number: response.data.number,
          country,
          service
        };
      } else {
        throw new Error(`Invalid SMS-Man response: ${JSON.stringify(response.data)}`);
      }
    } catch (error) {
      if (error.response?.data) {
        const errorMsg = error.response.data.error_msg || error.response.data.error || 'Unknown error';
        throw new Error(`SMS-Man error: ${errorMsg}`);
      }
      throw new Error(`Failed to get phone number: ${error.message}`);
    }
  }

  /**
   * Wait for SMS verification code with polling
   * @param {string} requestId - SMS request ID from getNumber()
   * @param {number} timeout - Maximum wait time in ms (default 120s)
   * @returns {Promise<Object>} { code, timestamp }
   */
  async getVerificationCode(requestId, timeout = 120000) {
    const startTime = Date.now();
    const pollInterval = 3000; // Check every 3 seconds
    let attempts = 0;

    console.log(`⏳ Waiting for SMS code (request ${requestId})...`);

    while (Date.now() - startTime < timeout) {
      attempts++;

      try {
        const response = await axios.get(this.apiUrl, {
          params: {
            action: 'getStatus',
            api_key: this.apiKey,
            request_id: requestId
          },
          timeout: 10000
        });

        // Check response status
        if (response.data && response.data.sms_code) {
          console.log(`✅ SMS code received: ${response.data.sms_code} (after ${attempts} attempts)`);
          return {
            code: response.data.sms_code,
            timestamp: new Date()
          };
        }

        // Status codes:
        // PENDING - waiting for SMS
        // RECEIVED - code received
        // CANCELLED - request cancelled
        // EXPIRED - timeout
        if (response.data.status === 'CANCELLED' || response.data.status === 'EXPIRED') {
          throw new Error(`SMS request ${response.data.status.toLowerCase()}`);
        }

        // Wait before next poll (exponential backoff)
        const waitTime = Math.min(pollInterval * Math.pow(1.2, attempts / 5), 10000);
        await new Promise(resolve => setTimeout(resolve, waitTime));

      } catch (error) {
        if (error.message.includes('cancelled') || error.message.includes('expired')) {
          throw error;
        }
        // Network errors - continue polling
        console.warn(`Poll attempt ${attempts} failed:`, error.message);
      }
    }

    // Timeout reached
    console.error(`❌ SMS code timeout after ${timeout/1000}s`);
    await this.cancelRequest(requestId);
    throw new Error('SMS verification timeout - no code received');
  }

  /**
   * Cancel an SMS request (if taking too long or no longer needed)
   * @param {string} requestId - SMS request ID
   */
  async cancelRequest(requestId) {
    try {
      await axios.get(this.apiUrl, {
        params: {
          action: 'setStatus',
          api_key: this.apiKey,
          request_id: requestId,
          status: 8 // Status 8 = Cancel
        },
        timeout: 10000
      });

      console.log(`🚫 SMS request ${requestId} cancelled`);
    } catch (error) {
      console.error('Error cancelling SMS request:', error.message);
      // Don't throw - this is cleanup
    }
  }

  /**
   * Get available countries for a service
   * @param {string} service - Service name ('yandex', 'gmx', etc.)
   * @returns {Promise<Array>} List of country codes
   */
  async getAvailableCountries(service = 'yandex') {
    try {
      const response = await axios.get(this.apiUrl, {
        params: {
          action: 'getCountries',
          api_key: this.apiKey,
          service
        },
        timeout: 10000
      });

      return response.data.countries || [];
    } catch (error) {
      console.error('Error getting available countries:', error);
      return [];
    }
  }

  /**
   * Get pricing for a service in a country
   * @param {string} country - Country code
   * @param {string} service - Service name
   * @returns {Promise<Object>} { price, currency }
   */
  async getPrice(country, service) {
    try {
      const response = await axios.get(this.apiUrl, {
        params: {
          action: 'getPrices',
          api_key: this.apiKey,
          country,
          service
        },
        timeout: 10000
      });

      return {
        price: response.data.price || 0,
        currency: response.data.currency || 'USD'
      };
    } catch (error) {
      console.error('Error getting price:', error);
      return { price: 0, currency: 'USD' };
    }
  }

  /**
   * Health check for SMS-Man service
   * @returns {Promise<Object>} Service status
   */
  async healthCheck() {
    try {
      if (!this.apiKey) {
        return {
          status: 'unavailable',
          message: 'API key not configured',
          balance: null
        };
      }

      const balance = await this.getBalance();

      return {
        status: balance > 0 ? 'online' : 'low_balance',
        message: balance > 0 ? 'Service operational' : 'Balance too low',
        balance
      };
    } catch (error) {
      return {
        status: 'error',
        message: error.message,
        balance: null
      };
    }
  }
}

module.exports = new SmsManService();
