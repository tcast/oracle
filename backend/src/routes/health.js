const express = require('express');
const router = express.Router();
const pool = require('../services/db');
const { version } = require('../../package.json');
const axios = require('axios');
const lambdaService = require('../services/lambdaService');

/**
 * @route GET /api/health/status
 * @desc Get overall API health status
 * @access Public
 */
router.get('/status', async (req, res) => {
  try {
    // Check database connection
    const dbCheck = await pool.query('SELECT NOW()');
    const dbStatus = dbCheck ? 'online' : 'offline';
    
    // Get uptime in hours
    const uptime = process.uptime() / 3600; // Convert seconds to hours
    
    // Return health information
    return res.json({
      status: 'healthy',
      version,
      uptime: uptime.toFixed(2) + ' hours',
      timestamp: new Date().toISOString(),
      services: {
        api: 'online',
        database: dbStatus
      }
    });
  } catch (error) {
    console.error('Health check error:', error);
    return res.status(500).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString(),
      services: {
        api: 'degraded',
        database: 'offline'
      }
    });
  }
});

/**
 * @route GET /api/health/routes
 * @desc Get list of all available API routes
 * @access Public
 */
router.get('/routes', (req, res) => {
  // Get all route information from the Express app
  const routes = [];
  
  // Get the Express app instance (this requires the app to be passed to this module)
  const app = req.app;
  if (!app || !app._router) {
    return res.status(500).json({
      error: 'Could not access route information'
    });
  }
  
  // Get routes from the Express router
  const stack = app._router.stack;
  
  // Process the routes
  stack.forEach(layer => {
    if (layer.route) {
      // Routes directly on the app
      const path = layer.route.path;
      const methods = Object.keys(layer.route.methods).map(m => m.toUpperCase());
      routes.push({ path, methods });
    } else if (layer.name === 'router' && layer.handle.stack) {
      // Router middleware
      layer.handle.stack.forEach(routerLayer => {
        if (routerLayer.route) {
          const path = layer.regexp.toString().includes('/api/') 
            ? layer.regexp.toString().split('/api')[1].split('\\')[0] + routerLayer.route.path
            : routerLayer.route.path;
          const methods = Object.keys(routerLayer.route.methods).map(m => m.toUpperCase());
          routes.push({ path: '/api' + path, methods });
        }
      });
    }
  });
  
  // Sort routes by path
  routes.sort((a, b) => a.path.localeCompare(b.path));
  
  return res.json({
    count: routes.length,
    routes
  });
});

/**
 * @route GET /api/health/external/:provider
 * @desc Check health of external API providers
 * @access Public
 */
router.get('/external/:provider', async (req, res) => {
  try {
    const { provider } = req.params;
    let status = 'offline';
    let message = '';
    let data = null;
    let startTime = Date.now();
    let responseTime = 0;
    
    switch (provider) {
      case 'finnhub':
        try {
          // Check if API key is configured
          const finnhubApiKey = process.env.FINNHUB_API_KEY;
          
          console.log(`[Finnhub Health Check] API Key: ${finnhubApiKey ? finnhubApiKey.substring(0, 5) + '...' : 'NOT SET'}, Length: ${finnhubApiKey ? finnhubApiKey.length : 0}`);
          
          if (!finnhubApiKey || finnhubApiKey === 'your_finnhub_api_key') {
            status = 'unavailable';
            message = 'Finnhub API key is not configured';
            data = { 
              configRequired: true,
              missingKey: 'FINNHUB_API_KEY',
              registerUrl: 'https://finnhub.io/'
            };
          } else {
            // Simple health check to Finnhub API
            const finnhubUrl = `https://finnhub.io/api/v1/stock/symbol?exchange=US&token=${finnhubApiKey.trim()}`;
            console.log(`[Finnhub Health Check] Testing URL: ${finnhubUrl.replace(finnhubApiKey, 'API_KEY')}`);
            
            const response = await axios.get(finnhubUrl, {
              timeout: 5000
            });
            responseTime = Date.now() - startTime;
            status = response.status === 200 ? 'online' : 'degraded';
            message = 'Finnhub API is available';
            data = { symbols: response.data.slice(0, 3) }; // Just return a sample
          }
        } catch (error) {
          status = 'offline';
          message = `Finnhub API error: ${error.message}`;
          console.error('[Finnhub Health Check] Error details:', error.response?.data || error.message);
          data = {
            registerUrl: 'https://finnhub.io/',
            error: error.response?.data || error.message
          };
        }
        break;
        
      case 'alphavantage':
        try {
          // Check if API key is configured
          const alphaVantageApiKey = process.env.ALPHA_VANTAGE_API_KEY;
          
          if (!alphaVantageApiKey || alphaVantageApiKey === 'your_alphavantage_api_key') {
            status = 'unavailable';
            message = 'Alpha Vantage API key is not configured';
            data = { 
              configRequired: true,
              missingKey: 'ALPHA_VANTAGE_API_KEY',
              registerUrl: 'https://www.alphavantage.co/'
            };
          } else {
            // Simple health check to Alpha Vantage API
            const response = await axios.get(`https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=IBM&interval=5min&apikey=${alphaVantageApiKey}`, {
              timeout: 5000
            });
            responseTime = Date.now() - startTime;
            status = response.data && !response.data.hasOwnProperty('Error Message') ? 'online' : 'degraded';
            message = 'Alpha Vantage API is available';
            data = { metaData: response.data['Meta Data'] }; // Just return metadata
          }
        } catch (error) {
          status = 'offline';
          message = `Alpha Vantage API error: ${error.message}`;
          data = {
            registerUrl: 'https://www.alphavantage.co/',
            error: error.response?.data || error.message
          };
        }
        break;
        
      case 'cryptocompare':
        try {
          // Check if API key is configured
          const cryptoCompareApiKey = process.env.CRYPTO_COMPARE_API_KEY;
          
          if (!cryptoCompareApiKey || cryptoCompareApiKey === 'your_cryptocompare_api_key') {
            status = 'unavailable';
            message = 'CryptoCompare API key is not configured';
            data = { 
              configRequired: true,
              missingKey: 'CRYPTO_COMPARE_API_KEY',
              registerUrl: 'https://min-api.cryptocompare.com/'
            };
          } else {
            // Simple health check to CryptoCompare API
            const headers = { 'authorization': `Apikey ${cryptoCompareApiKey}` };
            const response = await axios.get('https://min-api.cryptocompare.com/data/pricemultifull?fsyms=BTC&tsyms=USD', {
              timeout: 5000,
              headers
            });
            responseTime = Date.now() - startTime;
            status = response.status === 200 ? 'online' : 'degraded';
            message = 'CryptoCompare API is available';
            data = { price: response.data.RAW?.BTC?.USD?.PRICE };
          }
        } catch (error) {
          status = 'offline';
          message = `CryptoCompare API error: ${error.message}`;
          data = {
            registerUrl: 'https://min-api.cryptocompare.com/',
            error: error.response?.data || error.message
          };
        }
        break;
        
      case 'reddit':
        try {
          // Reddit allows some public access without an API key
          const response = await axios.get('https://www.reddit.com/r/wallstreetbets/hot.json?limit=1', {
            timeout: 5000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; OracleBot/1.0; +http://www.mywebsite.com)'
            }
          });
          responseTime = Date.now() - startTime;
          status = response.status === 200 ? 'online' : 'degraded';
          message = 'Reddit API is available';
          data = { posts: response.data.data.children.length }; 
        } catch (error) {
          status = 'offline';
          message = `Reddit API error: ${error.message}`;
          data = {
            note: 'Reddit API may require authentication for full access',
            error: error.response?.data || error.message
          };
        }
        break;
        
      case 'twitter':
        try {
          // Check if API key is configured
          const twitterBearerToken = process.env.TWITTER_BEARER_TOKEN;
          
          if (!twitterBearerToken) {
            status = 'unavailable';
            message = 'Twitter API key is not configured';
            data = { 
              configRequired: true,
              missingKey: 'TWITTER_BEARER_TOKEN',
              registerUrl: 'https://developer.twitter.com/'
            };
          } else {
            // Twitter API health check with auth
            const response = await axios.get('https://api.twitter.com/2/tweets/search/recent?query=stocks', {
              timeout: 5000,
              headers: {
                'Authorization': `Bearer ${twitterBearerToken}`
              }
            });
            responseTime = Date.now() - startTime;
            status = response.status === 200 ? 'online' : 'degraded';
            message = 'Twitter API is available';
            data = { count: response.data.meta?.result_count };
          }
        } catch (error) {
          status = 'offline';
          message = `Twitter API error: ${error.message}`;
          data = {
            registerUrl: 'https://developer.twitter.com/',
            error: error.response?.data || error.message
          };
        }
        break;
        
      case 'stocktwits':
        try {
          // StockTwits has some public endpoints without API key
          const response = await axios.get('https://api.stocktwits.com/api/2/streams/trending.json', {
            timeout: 5000
          });
          responseTime = Date.now() - startTime;
          status = response.status === 200 ? 'online' : 'degraded';
          message = 'StockTwits API is available';
          data = { symbols: response.data.symbols?.slice(0, 3) }; // Just return a few trending symbols
        } catch (error) {
          status = 'offline';
          message = `StockTwits API error: ${error.message}`;
          data = {
            registerUrl: 'https://api.stocktwits.com/',
            error: error.response?.data || error.message
          };
        }
        break;
        
      case 'scrapebee':
        try {
          // Check if API key is configured
          const scrapeBeeApiKey = process.env.SCRAPEBEE_API_KEY;
          
          if (!scrapeBeeApiKey) {
            status = 'unavailable';
            message = 'ScrapeBee API key is not configured';
            data = { 
              configRequired: true,
              missingKey: 'SCRAPEBEE_API_KEY',
              registerUrl: 'https://app.scrapebee.com/'
            };
          } else {
            // Perform a real test of the ScrapeBee API with a very simple scraping job
            const response = await axios.post('https://app.scrapebee.com/api/v1', {
              api_key: scrapeBeeApiKey,
              url: 'https://news.ycombinator.com',  // Hacker News is a good test site
              javascript: true,
              selector: '.titleline',  // Grab just the headlines
              scroll_count: 0
            }, {
              timeout: 8000,  // Longer timeout for web scraping
              headers: {
                'Content-Type': 'application/json'
              }
            });
            
            responseTime = Date.now() - startTime;
            
            if (response.data && response.data.success) {
              status = 'online';
              message = 'ScrapeBee API is fully operational';
              // Count the number of headlines grabbed as a basic test
              const headlines = response.data.html.match(/<a[^>]*class="titleline"[^>]*>/g) || [];
              data = { 
                success: true,
                itemsScraped: headlines.length,
                sample: headlines.length > 0 ? 'Successfully scraped headlines from Hacker News' : 'No headlines found'
              };
            } else {
              status = 'degraded';
              message = 'ScrapeBee API responded but scraping failed';
              data = {
                success: false,
                error: response.data.error || 'Unknown error in scraping response'
              };
            }
          }
        } catch (error) {
          status = 'offline';
          message = `ScrapeBee API error: ${error.message}`;
          data = {
            registerUrl: 'https://app.scrapebee.com/',
            error: error.response?.data || error.message
          };
        }
        break;
        
      default:
        return res.status(404).json({ 
          status: 'unknown',
          message: `Unknown provider: ${provider}` 
        });
    }
    
    return res.json({
      provider,
      status,
      message,
      responseTime,
      timestamp: new Date().toISOString(),
      data
    });
    
  } catch (error) {
    console.error(`External API health check error for ${req.params.provider}:`, error);
    return res.status(500).json({
      provider: req.params.provider,
      status: 'error',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * @route GET /api/health/lambda
 * @desc Check the status of the Oracle Lambda scraper functions
 * @access Public
 */
router.get('/lambda', async (req, res) => {
  try {
    const lambdaStatus = await lambdaService.checkAllScraperFunctions();
    return res.json(lambdaStatus);
  } catch (error) {
    console.error('Lambda status check error:', error);
    return res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

module.exports = router;