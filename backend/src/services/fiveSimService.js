const axios = require('axios');

/**
 * 5SIM API Integration Service
 * Provides temporary phone numbers for SMS verification
 * Documentation: https://5sim.net/docs | https://docs.5sim.net/v1/en/
 *
 * More affordable and reliable than SMS-Man
 * Pricing: $0.014-0.10 per verification
 */
class FiveSimService {
  constructor() {
    this.apiKey = (process.env.FIVESIM_API_KEY || '').trim();
    this.apiUrl = 'https://5sim.net/v1';
    this.fiveSimApiIssue = false;

    if (!this.apiKey) {
      console.warn('⚠️  FIVESIM_API_KEY not configured - SMS verification will not work');
      this.fiveSimApiIssue = true;
    } else {
      this.validateApiKey();
    }
  }

  /**
   * Get authorization header
   */
  getAuthHeader() {
    return `Bearer ${this.apiKey}`;
  }

  /**
   * Validate API key on service initialization
   */
  async validateApiKey() {
    try {
      const response = await axios.get(`${this.apiUrl}/user/profile`, {
        headers: {
          'Authorization': this.getAuthHeader(),
          'Accept': 'application/json'
        },
        timeout: 10000
      });

      if (response.data && response.data.email) {
        const balance = response.data.balance || 0;
        console.log(`✅ 5SIM API connected - Balance: ${balance} RUB (~$${(balance / 90).toFixed(2)} USD)`);
        this.fiveSimApiIssue = false;
      } else {
        console.error('❌ 5SIM API key validation failed - Invalid response');
        this.fiveSimApiIssue = true;
      }
    } catch (error) {
      console.error('❌ 5SIM validation error:', error.response?.data?.message || error.message);
      this.fiveSimApiIssue = true;
    }
  }

  /**
   * Get current account balance
   * @returns {Promise<number>} Balance in RUB
   */
  async getBalance() {
    try {
      const response = await axios.get(`${this.apiUrl}/user/profile`, {
        headers: {
          'Authorization': this.getAuthHeader(),
          'Accept': 'application/json'
        },
        timeout: 10000
      });

      return parseFloat(response.data.balance) || 0;
    } catch (error) {
      console.error('Error getting 5SIM balance:', error);
      throw new Error('Failed to get 5SIM balance');
    }
  }

  /**
   * Get phone number for verification
   * @param {string} country - Country code (russia, usa, uk, etc.) - lowercase
   * @param {string} service - Service name (yandex, gmail, gmx, etc.)
   * @returns {Promise<Object>} { id, number, country, service }
   */
  async getNumber(country = 'usa', service = 'yandex', operator = 'any') {
    if (this.fiveSimApiIssue) {
      throw new Error('5SIM API is not configured or unavailable');
    }

    try {
      // Map common codes to 5SIM format
      const countryMap = {
        'US': 'usa',
        'RU': 'russia',
        'UK': 'england',
        'GB': 'england',
        'CA': 'canada',
        'DE': 'germany'
      };

      const mappedCountry = countryMap[country.toUpperCase()] || country.toLowerCase();

      // Hard USA-only for email signup SMS (Yahoo/GMX/etc.)
      const usaOnlyServices = new Set(['yahoo', 'gmx', 'gmail', 'outlook', 'hotmail', 'microsoft']);
      if (usaOnlyServices.has(String(service).toLowerCase()) && mappedCountry !== 'usa') {
        throw new Error(`USA-only policy: refusing 5SIM country=${mappedCountry} for ${service}`);
      }

      // Prefer a known-good USA operator for Yahoo (guest prices: virtual63)
      let op = operator || 'any';
      if (mappedCountry === 'usa' && String(service).toLowerCase() === 'yahoo' && op === 'any') {
        op = process.env.FIVESIM_USA_YAHOO_OPERATOR || 'virtual63';
      }

      // Buy number using 5SIM API
      const response = await axios.get(
        `${this.apiUrl}/user/buy/activation/${mappedCountry}/${op}/${service}`,
        {
          headers: {
            'Authorization': this.getAuthHeader(),
            'Accept': 'application/json'
          },
          timeout: 15000
        }
      );

      // Response: { id: 123456, phone: "+1234567890", ... }
      if (response.data && response.data.id && response.data.phone) {
        console.log(`📱 5SIM number acquired: ${response.data.phone} (${mappedCountry}/${service})`);
        return {
          id: response.data.id,
          number: response.data.phone,
          country: mappedCountry,
          service,
          operator: response.data.operator,
          product: response.data.product
        };
      } else {
        throw new Error(`Invalid 5SIM response: ${JSON.stringify(response.data)}`);
      }
    } catch (error) {
      console.error('5SIM getNumber error details:', {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message
      });

      if (error.response?.data) {
        const errorMsg = error.response.data.message || error.response.data.error || JSON.stringify(error.response.data);
        throw new Error(`5SIM error: ${errorMsg}`);
      }
      throw new Error(`Failed to get phone number: ${error.message}`);
    }
  }

  /**
   * Wait for SMS verification code with polling
   * @param {string} orderId - Order ID from getNumber()
   * @param {number} timeout - Maximum wait time in ms (default 180s)
   * @returns {Promise<Object>} { code, timestamp }
   */
  async getVerificationCode(orderId, timeout = 180000) {
    const startTime = Date.now();
    const pollInterval = 3000; // Check every 3 seconds
    let attempts = 0;

    console.log(`⏳ Waiting for SMS code (order ${orderId})...`);

    while (Date.now() - startTime < timeout) {
      attempts++;

      try {
        const response = await axios.get(
          `${this.apiUrl}/user/check/${orderId}`,
          {
            headers: {
              'Authorization': this.getAuthHeader(),
              'Accept': 'application/json'
            },
            timeout: 10000
          }
        );

        // 5SIM response format:
        // { status: "RECEIVED", sms: [{ code: "123456", date: "..." }] }
        if (response.data && response.data.status === 'RECEIVED' && response.data.sms && response.data.sms.length > 0) {
          const code = response.data.sms[0].code;
          console.log(`✅ SMS code received: ${code} (after ${attempts} attempts)`);

          // Mark order as finished
          await this.finishOrder(orderId);

          return {
            code,
            timestamp: new Date(),
            fullText: response.data.sms[0].text
          };
        }

        // Check for terminal states
        if (response.data.status === 'CANCELED' || response.data.status === 'TIMEOUT') {
          throw new Error(`SMS request ${response.data.status.toLowerCase()}`);
        }

        // Still waiting (PENDING status)
        // Wait before next poll with slight exponential backoff
        const waitTime = Math.min(pollInterval * Math.pow(1.1, attempts / 10), 8000);
        await new Promise(resolve => setTimeout(resolve, waitTime));

      } catch (error) {
        if (error.message.includes('canceled') || error.message.includes('timeout')) {
          throw error;
        }
        // Network errors - continue polling
        console.warn(`Poll attempt ${attempts} failed:`, error.message);
      }
    }

    // Timeout reached
    console.error(`❌ SMS code timeout after ${timeout/1000}s`);
    await this.cancelOrder(orderId);
    throw new Error('SMS verification timeout - no code received');
  }

  /**
   * Cancel/finish an order
   * @param {string} orderId - Order ID
   */
  async cancelOrder(orderId) {
    try {
      await axios.get(
        `${this.apiUrl}/user/cancel/${orderId}`,
        {
          headers: {
            'Authorization': this.getAuthHeader(),
            'Accept': 'application/json'
          },
          timeout: 10000
        }
      );

      console.log(`🚫 5SIM order ${orderId} cancelled`);
    } catch (error) {
      console.error('Error cancelling 5SIM order:', error.message);
      // Don't throw - this is cleanup
    }
  }

  /**
   * Finish an order after receiving SMS
   * @param {string} orderId - Order ID
   */
  async finishOrder(orderId) {
    try {
      await axios.get(
        `${this.apiUrl}/user/finish/${orderId}`,
        {
          headers: {
            'Authorization': this.getAuthHeader(),
            'Accept': 'application/json'
          },
          timeout: 10000
        }
      );

      console.log(`✅ 5SIM order ${orderId} finished`);
    } catch (error) {
      console.error('Error finishing 5SIM order:', error.message);
      // Don't throw - order will auto-complete
    }
  }

  /**
   * Ban a phone number (if it didn't work)
   * @param {string} orderId - Order ID
   */
  async banNumber(orderId) {
    try {
      await axios.get(
        `${this.apiUrl}/user/ban/${orderId}`,
        {
          headers: {
            'Authorization': this.getAuthHeader(),
            'Accept': 'application/json'
          },
          timeout: 10000
        }
      );

      console.log(`⛔ 5SIM number ${orderId} banned (refund issued)`);
    } catch (error) {
      console.error('Error banning 5SIM number:', error.message);
    }
  }

  /**
   * Get available countries for a service
   * @param {string} service - Service name (yandex, gmail, etc.)
   * @returns {Promise<Array>} List of country objects
   */
  async getAvailableCountries(service = 'yandex') {
    try {
      const response = await axios.get(
        `${this.apiUrl}/guest/products/${service}/any`,
        {
          headers: {
            'Accept': 'application/json'
          },
          timeout: 10000
        }
      );

      // Returns object with country codes as keys
      const countries = Object.keys(response.data || {});
      return countries;
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
      const response = await axios.get(
        `${this.apiUrl}/guest/prices`,
        {
          params: {
            country,
            product: service
          },
          headers: {
            'Accept': 'application/json'
          },
          timeout: 10000
        }
      );

      const countryData = response.data[country];
      if (countryData && countryData[service]) {
        return {
          price: countryData[service].cost,
          currency: 'RUB',
          priceUSD: (countryData[service].cost / 90).toFixed(3) // Rough conversion
        };
      }

      return { price: 0, currency: 'RUB', priceUSD: 0 };
    } catch (error) {
      console.error('Error getting price:', error);
      return { price: 0, currency: 'RUB', priceUSD: 0 };
    }
  }

  /**
   * Health check for 5SIM service
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

      const profile = await axios.get(`${this.apiUrl}/user/profile`, {
        headers: {
          'Authorization': this.getAuthHeader(),
          'Accept': 'application/json'
        },
        timeout: 10000
      });

      const balanceRUB = profile.data.balance || 0;
      const balanceUSD = balanceRUB / 90; // Approximate conversion

      return {
        status: balanceRUB > 0 ? 'online' : 'low_balance',
        message: balanceRUB > 0 ? 'Service operational' : 'Balance too low - add funds',
        balance: balanceUSD,
        balanceRUB,
        email: profile.data.email,
        rating: profile.data.rating
      };
    } catch (error) {
      return {
        status: 'error',
        message: error.response?.data?.message || error.message,
        balance: null
      };
    }
  }

  /**
   * Alias for cancelOrder to maintain compatibility with SMS-Man interface
   */
  async cancelRequest(requestId) {
    return this.cancelOrder(requestId);
  }
}

module.exports = new FiveSimService();
