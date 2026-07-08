# Playwright Migration Guide

## Overview
We've replaced Selenium with Playwright for better anti-detection capabilities and improved social media automation.

## Key Changes

### 1. Removed Dependencies
- `selenium-webdriver`
- `chromedriver`

### 2. Added Dependencies
- `playwright` - Modern browser automation
- `playwright-extra` - Extended functionality
- `puppeteer-extra-plugin-stealth` - Anti-detection features

### 3. Updated Services
- `seleniumService.js` → `playwrightService.js`
- All references updated in:
  - `postingService.js`
  - `commentingService.js`
  - `accountCreationService.js`
  - `app.js`

## Anti-Detection Features

### WebRTC Leak Prevention
```javascript
// Completely blocks WebRTC to prevent IP leaks
'--disable-webrtc',
'--disable-features=WebRtcHideLocalIpsWithMdns',
```

### Browser Fingerprinting Protection
- Hides `navigator.webdriver` property
- Realistic plugin array
- Proper language settings
- Human-like typing delays
- Random mouse movements

## Proxy/VPN Support

### Configuration
```javascript
const proxyConfig = {
  server: 'http://residential-proxy.com:8080',
  username: 'user',
  password: 'pass'
};
```

### Database Schema Update
Run the migration to add proxy support:
```sql
-- 020_add_proxy_config.sql
ALTER TABLE social_accounts 
ADD COLUMN IF NOT EXISTS proxy_config JSONB DEFAULT NULL;
```

## Platform Support

### Implemented
- **Reddit**: Login, Post Creation, Comments
- **X (Twitter)**: Login, Post Creation, Comments  
- **LinkedIn**: Login, Post Creation, Comments

### Not Implemented
- **TikTok**: Requires mobile emulation or API
- **Facebook/Instagram**: High detection risk

## Usage Examples

### Creating a Post
```javascript
const postId = await playwrightService.createRedditPost(
  accountId,
  'subredditName',
  'Post Title',
  'Post content text'
);
```

### With Proxy
```javascript
const account = {
  id: 1,
  username: 'user',
  credentials: { password: 'pass' },
  proxy_config: {
    server: 'socks5://proxy.example.com:1080',
    username: 'proxyuser',
    password: 'proxypass'
  }
};
```

## Testing

Run the anti-detection test:
```bash
node src/test-playwright.js
```

This will:
1. Test browser fingerprinting
2. Check WebRTC leaks
3. Verify anti-detection measures

## Best Practices

### 1. Human-like Behavior
- Random delays between actions
- Gradual typing speed
- Natural mouse movements

### 2. Proxy Rotation
- Use different proxies per account
- Residential proxies recommended
- Avoid datacenter IPs

### 3. Session Management
- Don't keep browsers open too long
- Clear cookies between sessions
- Rotate user agents

### 4. Rate Limiting
- 30-60 seconds between account creations
- Respect platform limits
- Monitor for shadowbans

## Troubleshooting

### Browser Not Launching
```bash
npx playwright install chromium
```

### Proxy Connection Failed
- Verify proxy credentials
- Check proxy format (http/socks5)
- Test proxy separately first

### High Detection Rate
- Enable headless: false for debugging
- Check all anti-detection features
- Use residential proxies
- Add more human-like delays

## Security Notes

1. **Never commit proxy credentials**
2. **Use environment variables for sensitive data**
3. **Rotate accounts regularly**
4. **Monitor for platform changes**

## Future Improvements

1. **CAPTCHA Solving**
   - Integrate 2captcha or similar
   - Handle verification challenges

2. **Advanced Fingerprinting**
   - Canvas fingerprinting
   - WebGL spoofing
   - Audio context masking

3. **Mobile Emulation**
   - For TikTok support
   - Instagram app automation

4. **Session Persistence**
   - Save/restore browser states
   - Cookie management
