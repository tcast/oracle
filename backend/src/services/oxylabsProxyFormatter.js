/**
 * Oxylabs Proxy Formatter
 * Converts Oxylabs proxy format to our system format
 */

class OxylabsProxyFormatter {
  /**
   * Format Oxylabs residential proxy for our system
   * 
   * Oxylabs format:
   * - Endpoint: pr.oxylabs.io:7777
   * - Username: customer-USERNAME-cc-US-sessid-SESSION_ID
   * - Password: PASSWORD
   */
  static formatResidentialProxy(config) {
    const {
      username,      // Your Oxylabs username
      password,      // Your Oxylabs password
      country = 'US',
      city = null,
      sessionId = null,  // For sticky sessions
      sessionTime = 10   // Session duration in minutes
    } = config;

    // Build username with parameters
    let proxyUsername = `customer-${username}`;
    
    // Add country code
    if (country) {
      proxyUsername += `-cc-${country.toUpperCase()}`;
    }
    
    // Add city if specified
    if (city) {
      proxyUsername += `-city-${city.toLowerCase().replace(/\s+/g, '_')}`;
    }
    
    // Add session ID for sticky sessions
    if (sessionId) {
      proxyUsername += `-sessid-${sessionId}`;
      proxyUsername += `-sesstime-${sessionTime}`;
    }

    return {
      name: `Oxylabs ${country} Residential${city ? ` - ${city}` : ''}${sessionId ? ` (Session ${sessionId})` : ''}`,
      type: 'http',
      server: 'pr.oxylabs.io:7777',
      username: proxyUsername,
      password: password,
      country: country,
      city: city,
      provider: 'Oxylabs',
      is_residential: true,
      metadata: {
        session_id: sessionId,
        session_time: sessionTime,
        endpoint_type: 'residential'
      }
    };
  }

  /**
   * Generate multiple proxies with different session IDs
   * Perfect for assigning to different social accounts
   */
  static generateProxyPool(config, count = 10) {
    const proxies = [];
    
    for (let i = 1; i <= count; i++) {
      const proxyConfig = {
        ...config,
        sessionId: `session_${Date.now()}_${i}`
      };
      
      proxies.push(this.formatResidentialProxy(proxyConfig));
    }
    
    return proxies;
  }

  /**
   * Format Oxylabs datacenter proxy (not recommended for social media)
   */
  static formatDatacenterProxy(config) {
    const {
      username,
      password,
      country = 'US'
    } = config;

    return {
      name: `Oxylabs ${country} Datacenter`,
      type: 'http',
      server: `${country.toLowerCase()}.oxylabs.io:8001`,
      username: username,
      password: password,
      country: country,
      provider: 'Oxylabs',
      is_residential: false,
      metadata: {
        endpoint_type: 'datacenter'
      }
    };
  }

  /**
   * Import Oxylabs proxies with different configurations
   */
  static generateImportConfig(oxylabsCredentials) {
    const { username, password } = oxylabsCredentials;
    const proxies = [];

    // US Proxies with different cities
    const usCities = ['new_york', 'los_angeles', 'chicago', 'houston', 'miami'];
    usCities.forEach((city, index) => {
      // Generate 2 sessions per city
      for (let session = 1; session <= 2; session++) {
        proxies.push(this.formatResidentialProxy({
          username,
          password,
          country: 'US',
          city: city,
          sessionId: `us_${city}_${session}`,
          sessionTime: 30 // 30-minute sticky sessions
        }));
      }
    });

    // UK Proxies
    for (let i = 1; i <= 3; i++) {
      proxies.push(this.formatResidentialProxy({
        username,
        password,
        country: 'GB',
        city: 'london',
        sessionId: `uk_london_${i}`,
        sessionTime: 30
      }));
    }

    // Canada Proxies
    for (let i = 1; i <= 2; i++) {
      proxies.push(this.formatResidentialProxy({
        username,
        password,
        country: 'CA',
        city: 'toronto',
        sessionId: `ca_toronto_${i}`,
        sessionTime: 30
      }));
    }

    return proxies;
  }

  /**
   * Get proxy endpoint documentation
   */
  static getEndpoints() {
    return {
      residential: {
        endpoint: 'pr.oxylabs.io:7777',
        documentation: 'https://developers.oxylabs.io/proxies/residential-proxies',
        parameters: {
          'cc': 'Country code (e.g., US, GB, CA)',
          'city': 'City name (lowercase, underscores for spaces)',
          'sessid': 'Session ID for sticky sessions',
          'sesstime': 'Session duration in minutes (1-120)'
        }
      },
      datacenter: {
        endpoint: '{country}.oxylabs.io:8001',
        documentation: 'https://developers.oxylabs.io/proxies/datacenter-proxies',
        note: 'Not recommended for social media automation'
      }
    };
  }
}

module.exports = OxylabsProxyFormatter;
