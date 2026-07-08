# Proxy Management System

## Overview
A comprehensive proxy management system that allows you to:
- Store multiple proxies in the database
- Assign one or more proxies to each social account
- Automatically rotate proxies for each account
- Track proxy usage and performance
- Support HTTP, HTTPS, and SOCKS5 proxies

## Database Schema

### Tables

#### `proxies`
Stores all proxy configurations:
- `id` - Unique identifier
- `name` - Descriptive name
- `type` - Protocol type (http, https, socks5)
- `server` - Proxy server address with port
- `username` - Authentication username
- `password` - Authentication password
- `country` - ISO country code
- `city` - City location
- `provider` - Proxy provider name
- `is_residential` - Whether it's a residential proxy
- `is_active` - Enable/disable proxy
- `success_count` - Successful connections
- `failure_count` - Failed connections

#### `social_account_proxies`
Links accounts to proxies (many-to-many):
- `social_account_id` - Reference to social account
- `proxy_id` - Reference to proxy
- `priority` - Priority for rotation (1 = highest)
- `use_count` - Times used by this account
- `last_used_at` - Last usage timestamp

## API Endpoints

### Proxy Management

#### GET /api/proxies
Get all active proxies with optional filters:
```bash
GET /api/proxies?type=socks5&country=US&is_residential=true
```

#### POST /api/proxies
Create a new proxy:
```json
{
  "name": "US Residential Proxy 1",
  "type": "socks5",
  "server": "proxy.example.com:1080",
  "username": "user",
  "password": "pass",
  "country": "US",
  "city": "New York",
  "provider": "BrightData",
  "is_residential": true
}
```

#### POST /api/proxies/bulk
Import multiple proxies:
```json
{
  "proxies": [
    {
      "name": "Proxy 1",
      "type": "http",
      "server": "proxy1.com:8080",
      "username": "user1",
      "password": "pass1"
    },
    {
      "name": "Proxy 2",
      "type": "socks5",
      "server": "proxy2.com:1080",
      "username": "user2",
      "password": "pass2"
    }
  ]
}
```

#### POST /api/proxies/:id/test
Test a proxy connection

#### PATCH /api/proxies/:id/status
Enable/disable a proxy:
```json
{
  "is_active": false
}
```

### Account Proxy Assignment

#### GET /api/proxies/account/:accountId
Get proxies assigned to an account

#### POST /api/proxies/account/:accountId/assign
Assign proxies to an account:
```json
{
  "proxy_ids": [1, 2, 3]
}
```

#### DELETE /api/proxies/account/:accountId/proxy/:proxyId
Remove a proxy from an account

## Usage Examples

### 1. Setting Up Proxies

```javascript
// Import residential proxies for different regions
const proxies = [
  {
    name: "US East Residential 1",
    type: "socks5",
    server: "us-east.residential.example.com:1080",
    username: "myuser",
    password: "mypass",
    country: "US",
    city: "New York",
    provider: "BrightData",
    is_residential: true
  },
  {
    name: "US West Residential 1",
    type: "socks5",
    server: "us-west.residential.example.com:1080",
    username: "myuser",
    password: "mypass",
    country: "US",
    city: "Los Angeles",
    provider: "BrightData",
    is_residential: true
  },
  {
    name: "UK Residential 1",
    type: "http",
    server: "uk.residential.example.com:8080",
    username: "ukuser",
    password: "ukpass",
    country: "GB",
    city: "London",
    provider: "SmartProxy",
    is_residential: true
  }
];

// Bulk import
const response = await fetch('/api/proxies/bulk', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ proxies })
});
```

### 2. Assigning Proxies to Accounts

```javascript
// Assign US proxies to US-based accounts
const usProxies = await fetch('/api/proxies?country=US').then(r => r.json());
const usAccounts = await fetch('/api/social-accounts?region=US').then(r => r.json());

for (const account of usAccounts) {
  // Assign 3 proxies per account for rotation
  const selectedProxies = usProxies.slice(0, 3);
  await fetch(`/api/proxies/account/${account.id}/assign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proxy_ids: selectedProxies.map(p => p.id)
    })
  });
}
```

### 3. Automatic Proxy Rotation

The system automatically rotates proxies when posting:

```javascript
// In playwrightService.js
const { browser, context, page } = await this.createBrowserForAccount(accountId);
// The proxy is automatically selected and rotated!
```

Rotation algorithm:
1. Gets all active proxies assigned to the account
2. Selects the proxy used least recently
3. Updates usage timestamps and counts
4. Returns formatted proxy configuration

### 4. Monitoring Proxy Health

```javascript
// Get proxy statistics
const stats = await fetch('/api/proxies/stats').then(r => r.json());
console.log(stats);
// {
//   overview: {
//     total_proxies: 50,
//     active_proxies: 48,
//     residential_proxies: 40
//   },
//   byCountry: [...],
//   byProvider: [...]
// }

// Test proxy connection
const testResult = await fetch('/api/proxies/1/test', {
  method: 'POST'
}).then(r => r.json());
```

## Best Practices

### 1. Proxy Selection
- Use **residential proxies** for social media (better success rate)
- Match proxy location to account location
- Assign 3-5 proxies per account for rotation

### 2. Proxy Providers
Recommended providers for social media:
- **BrightData** (formerly Luminati)
- **SmartProxy**
- **Oxylabs**
- **IPRoyal**
- **Proxy-Cheap** (budget option)

### 3. Configuration Tips
```javascript
// Good proxy configuration
{
  name: "Premium US Residential",
  type: "socks5",  // SOCKS5 is more versatile
  server: "gate.provider.com:port",
  username: "user-session-randomid",  // Session-based
  password: "password",
  country: "US",
  is_residential: true  // Critical for social media
}
```

### 4. Security
- Store proxy credentials securely
- Use environment variables for sensitive data
- Regularly rotate proxy passwords
- Monitor for compromised proxies

### 5. Maintenance
```javascript
// Disable failing proxies automatically
if (proxy.failure_count > 10) {
  await proxyService.disableProxy(proxy.id);
}

// Clean up old assignments
await pool.query(`
  DELETE FROM social_account_proxies 
  WHERE last_used_at < NOW() - INTERVAL '30 days'
`);
```

## Troubleshooting

### Common Issues

1. **Proxy Connection Failed**
   - Verify credentials
   - Check proxy format (http:// vs socks5://)
   - Test proxy manually first

2. **High Detection Rate**
   - Ensure using residential proxies
   - Check proxy quality/reputation
   - Increase delays between actions

3. **Rotation Not Working**
   - Verify proxies are assigned to account
   - Check proxy priorities
   - Ensure proxies are active

### Debug Mode

Enable detailed logging:
```javascript
// In playwrightService.js
console.log(`Using proxy for account ${accountId}:`, proxyConfig.server);
```

## Integration with Existing Code

The proxy system is fully integrated:

1. **Automatic Selection**: When creating a browser for any account, the system automatically selects and uses the next available proxy

2. **Transparent Usage**: No code changes needed in posting/commenting logic

3. **Fallback**: If no proxy is assigned, uses direct connection

4. **Performance Tracking**: Automatically tracks success/failure rates

## Migration from Old System

If you had proxy_config in social_accounts:
```sql
-- Migrate existing proxy configs
INSERT INTO proxies (name, type, server, username, password)
SELECT 
  username || ' proxy',
  'http',
  proxy_config->>'server',
  proxy_config->>'username',
  proxy_config->>'password'
FROM social_accounts
WHERE proxy_config IS NOT NULL;

-- Then assign to accounts and remove old column
-- ALTER TABLE social_accounts DROP COLUMN proxy_config;
```

## Future Enhancements

1. **Proxy Pools**: Group proxies by quality/purpose
2. **Geographic Routing**: Auto-select proxies by target region
3. **Cost Tracking**: Monitor proxy usage costs
4. **Health Monitoring**: Automated proxy testing
5. **Failover**: Automatic fallback to backup proxies
