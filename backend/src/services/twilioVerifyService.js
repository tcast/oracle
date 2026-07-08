const axios = require('axios');

/**
 * Twilio Verify API Integration Service
 * Professional SMS verification service for email account creation
 * Documentation: https://www.twilio.com/docs/verify/api
 */
class TwilioVerifyService {
  constructor() {
    this.accountSid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
    this.authToken = (process.env.TWILIO_AUTH_TOKEN || '').trim();
    this.verifyServiceSid = (process.env.TWILIO_VERIFY_SERVICE_SID || '').trim();
    this.apiUrl = 'https://verify.twilio.com/v2/Services';
    this.twilioApiIssue = false;

    if (!this.accountSid || !this.authToken) {
      console.warn('⚠️  Twilio credentials not configured - SMS verification will not work');
      this.twilioApiIssue = true;
    } else if (!this.verifyServiceSid) {
      console.warn('⚠️  TWILIO_VERIFY_SERVICE_SID not set - you need to create a Verify Service first');
      console.warn('    Create one at: https://console.twilio.com/us1/develop/verify/services');
      this.twilioApiIssue = true;
    } else {
      this.validateApiKey();
    }
  }

  /**
   * Get auth header for Twilio API
   */
  getAuthHeader() {
    const credentials = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    return `Basic ${credentials}`;
  }

  /**
   * Validate Twilio credentials on service initialization
   */
  async validateApiKey() {
    try {
      const response = await axios.get(
        `${this.apiUrl}/${this.verifyServiceSid}`,
        {
          headers: {
            'Authorization': this.getAuthHeader()
          },
          timeout: 10000
        }
      );

      if (response.data && response.data.sid) {
        console.log(`✅ Twilio Verify connected - Service: ${response.data.friendly_name}`);
        this.twilioApiIssue = false;
      } else {
        console.error('❌ Twilio Verify validation failed - Invalid response');
        this.twilioApiIssue = true;
      }
    } catch (error) {
      console.error('❌ Twilio Verify validation error:', error.message);
      if (error.response?.status === 401) {
        console.error('   Invalid credentials - check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN');
      } else if (error.response?.status === 404) {
        console.error('   Verify Service not found - check TWILIO_VERIFY_SERVICE_SID');
      }
      this.twilioApiIssue = true;
    }
  }

  /**
   * Send verification code to phone number
   * @param {string} phoneNumber - Phone number with country code (e.g., +15551234567)
   * @param {string} channel - 'sms' or 'call' (default: sms)
   * @returns {Promise<Object>} { sid, to, channel, status }
   */
  async sendVerificationCode(phoneNumber, channel = 'sms') {
    if (this.twilioApiIssue) {
      throw new Error('Twilio Verify is not configured or unavailable');
    }

    try {
      // Ensure phone number has country code
      const formattedPhone = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;

      const response = await axios.post(
        `${this.apiUrl}/${this.verifyServiceSid}/Verifications`,
        new URLSearchParams({
          To: formattedPhone,
          Channel: channel
        }),
        {
          headers: {
            'Authorization': this.getAuthHeader(),
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          timeout: 15000
        }
      );

      console.log(`📱 Twilio verification sent to ${formattedPhone} via ${channel}`);

      return {
        sid: response.data.sid,
        to: response.data.to,
        channel: response.data.channel,
        status: response.data.status,
        valid: response.data.valid
      };

    } catch (error) {
      if (error.response?.data) {
        const errorMsg = error.response.data.message || 'Unknown error';
        throw new Error(`Twilio error: ${errorMsg}`);
      }
      throw new Error(`Failed to send verification: ${error.message}`);
    }
  }

  /**
   * Check verification code
   * @param {string} phoneNumber - Phone number that was verified
   * @param {string} code - Verification code entered by user
   * @returns {Promise<Object>} { valid, status }
   */
  async checkVerificationCode(phoneNumber, code) {
    if (this.twilioApiIssue) {
      throw new Error('Twilio Verify is not configured or unavailable');
    }

    try {
      const formattedPhone = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;

      const response = await axios.post(
        `${this.apiUrl}/${this.verifyServiceSid}/VerificationCheck`,
        new URLSearchParams({
          To: formattedPhone,
          Code: code
        }),
        {
          headers: {
            'Authorization': this.getAuthHeader(),
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          timeout: 10000
        }
      );

      const valid = response.data.status === 'approved';

      if (valid) {
        console.log(`✅ Verification code confirmed for ${formattedPhone}`);
      } else {
        console.log(`❌ Verification failed for ${formattedPhone}: ${response.data.status}`);
      }

      return {
        valid,
        status: response.data.status,
        to: response.data.to
      };

    } catch (error) {
      if (error.response?.data) {
        const errorMsg = error.response.data.message || 'Unknown error';
        throw new Error(`Twilio verification check failed: ${errorMsg}`);
      }
      throw new Error(`Failed to check verification: ${error.message}`);
    }
  }

  /**
   * For compatibility with SMS-Man pattern - use Twilio's own phone numbers
   * Note: Twilio doesn't provide temp numbers, this sends to user's actual number
   * For automation, you'd need to integrate with a temp number provider
   * @param {string} country - Country code
   * @param {string} service - Service name (ignored for Twilio)
   * @returns {Promise<Object>} Phone number info
   */
  async getNumber(country = 'US', service = 'yandex') {
    // For Twilio, we need to use a real phone number or integrate with a temp number service
    // This is a placeholder - in reality you'd use Twilio + a temp number provider combo
    // OR use a dedicated temp number service like 5SIM alongside Twilio Verify

    throw new Error('Twilio Verify requires actual phone numbers - use 5SIM or similar for temp numbers');
  }

  /**
   * Wait for verification code (for manual entry in browser)
   * With Twilio, the code is entered by user/automation, not retrieved via API
   * @param {string} phoneNumber - Phone that received code
   * @param {number} timeout - Not used (code is entered immediately)
   * @returns {Promise<Object>} Placeholder for compatibility
   */
  async getVerificationCode(phoneNumber, timeout = 120000) {
    // Twilio doesn't retrieve codes - the code is entered in the browser
    // This is called after the user/automation enters it
    return {
      note: 'Twilio verification - code entered in browser, not retrieved via API',
      phoneNumber
    };
  }

  /**
   * Cancel a verification (not needed with Twilio - codes expire automatically)
   */
  async cancelRequest(requestId) {
    // Twilio verifications expire automatically after 10 minutes
    console.log('Twilio verifications expire automatically - no cancellation needed');
  }

  /**
   * Health check for Twilio Verify service
   * @returns {Promise<Object>} Service status
   */
  async healthCheck() {
    try {
      if (!this.accountSid || !this.authToken || !this.verifyServiceSid) {
        return {
          status: 'unavailable',
          message: 'Twilio credentials not configured',
          balance: null
        };
      }

      // Check service exists
      const response = await axios.get(
        `${this.apiUrl}/${this.verifyServiceSid}`,
        {
          headers: {
            'Authorization': this.getAuthHeader()
          },
          timeout: 10000
        }
      );

      if (response.data && response.data.sid) {
        return {
          status: 'online',
          message: `Service operational: ${response.data.friendly_name}`,
          serviceName: response.data.friendly_name,
          serviceSid: response.data.sid
        };
      }

      return {
        status: 'error',
        message: 'Invalid response from Twilio',
        balance: null
      };

    } catch (error) {
      return {
        status: 'error',
        message: error.response?.data?.message || error.message,
        balance: null
      };
    }
  }
}

module.exports = new TwilioVerifyService();
