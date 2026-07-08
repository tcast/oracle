require('dotenv').config();
const playwrightService = require('./services/playwrightService');

async function testAntiDetection() {
  console.log('Testing Playwright anti-detection features...\n');
  
  let browser, context, page;
  try {
    // Test without proxy first
    const result = await playwrightService.createBrowser();
    browser = result.browser;
    context = result.context;
    page = result.page;
    
    // Navigate to a detection test site
    await page.goto('https://bot.sannysoft.com/', { waitUntil: 'networkidle' });
    await page.screenshot({ path: 'detection-test.png' });
    console.log('Screenshot saved as detection-test.png');
    
    // Check WebRTC leak
    await page.goto('https://browserleaks.com/webrtc', { waitUntil: 'networkidle' });
    const webrtcInfo = await page.evaluate(() => {
      const elements = document.querySelectorAll('.ip-address');
      return Array.from(elements).map(el => el.textContent);
    });
    console.log('WebRTC leak test:', webrtcInfo.length > 0 ? 'IPs found: ' + webrtcInfo.join(', ') : 'No leaks detected');
    
    // Check navigator.webdriver
    const webdriverCheck = await page.evaluate(() => navigator.webdriver);
    console.log('navigator.webdriver:', webdriverCheck === false ? 'Hidden ✓' : 'Exposed ✗');
    
    // Check user agent
    const userAgent = await page.evaluate(() => navigator.userAgent);
    console.log('User Agent:', userAgent);
    
    // Check plugins
    const plugins = await page.evaluate(() => navigator.plugins.length);
    console.log('Plugins count:', plugins);
    
    // Check languages
    const languages = await page.evaluate(() => navigator.languages);
    console.log('Languages:', languages);
    
    console.log('\nAnti-detection test completed!');
    
  } catch (error) {
    console.error('Test failed:', error);
  } finally {
    if (browser) await browser.close();
  }
}

async function testProxyConnection() {
  console.log('\nTesting proxy connection...\n');
  
  // Example proxy config - replace with your actual proxy
  const proxyConfig = {
    server: 'http://your-proxy-server:port',
    username: 'your-username',
    password: 'your-password'
  };
  
  console.log('Note: Add your proxy configuration to test proxy support.');
  console.log('Proxy format example:', proxyConfig);
}

// Run tests
(async () => {
  await testAntiDetection();
  await testProxyConnection();
  
  console.log('\nTest complete! Review the results above.');
  process.exit(0);
})();
