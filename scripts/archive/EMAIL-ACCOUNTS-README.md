# Email Account Creation System

Automated email account creation for Yandex and GMX with SMS verification and CAPTCHA solving.

## Overview

This system creates hundreds of public email accounts (@yandex.com, @gmx.com) using browser automation, phone verification, and CAPTCHA solving. Created emails are stored in a pool and can be assigned to social media accounts.

## Architecture

```
Email Account Creation Flow:
1. User requests batch creation (e.g., 50 Yandex accounts)
2. System rotates through proxies for each account
3. Playwright launches browser with stealth + anti-detection
4. Fills signup form with generated credentials
5. Solves CAPTCHA using 2Captcha (or CapSolver fallback)
6. Requests phone number from SMS-Man API
7. Waits for SMS verification code (up to 2 minutes)
8. Completes signup and verifies success
9. Stores account credentials in database
10. Repeats with 30-60 second delays between accounts
```

## Database Schema

**Table:** `email_accounts`

```sql
- id: Primary key
- provider: 'yandex' | 'gmx' | 'mail.com'
- email: Full email address (unique)
- username: Username part
- password: Generated secure password
- phone_number: Verification phone used
- phone_provider: 'smsman' | '5sim'
- status: 'active' | 'inactive' | 'banned' | 'locked'
- is_verified: Boolean verification status
- verification_date: When verified
- metadata: JSONB for provider-specific data
```

**Relationship:**
- `social_accounts.email_account_id` → `email_accounts.id`
- Many social accounts can use same email (for recovery)

## API Keys Required

### 1. SMS-Man (Phone Verification)

**Sign up:** https://sms-man.com/
**Pricing:** $0.15-0.20 per verification

Add to `.env`:
```env
SMSMAN_API_KEY=your_api_key_here
SMSMAN_API_URL=https://api.sms-man.com/stubs/handler_api.php
```

**Get API Key:**
1. Register at sms-man.com
2. Add funds ($10 minimum recommended)
3. Go to Settings → API
4. Copy API key

### 2. 2Captcha (Primary CAPTCHA Solver)

**Sign up:** https://2captcha.com/
**Pricing:** $0.50-3.00 per 1000 CAPTCHAs

Add to `.env`:
```env
TWOCAPTCHA_API_KEY=your_api_key_here
```

**Get API Key:**
1. Register at 2captcha.com
2. Add funds ($3 minimum)
3. Go to Settings → API Key
4. Copy API key

### 3. CapSolver (Fallback for Modern CAPTCHAs)

**Sign up:** https://www.capsolver.com/
**Pricing:** Similar to 2Captcha

Add to `.env`:
```env
CAPSOLVER_API_KEY=your_api_key_here
```

**Get API Key:**
1. Register at capsolver.com
2. Add credits
3. Dashboard → API Key
4. Copy key

## Usage

### Via UI (Recommended)

1. Navigate to **Settings → Email Accounts**
2. Click **"+ Create Email Accounts"**
3. Fill form:
   - **Provider**: Yandex or GMX
   - **Count**: 1-50 accounts
   - **Username Prefix**: e.g., "user", "account"
   - **Use Proxies**: ✓ (recommended)
4. Click **"Create"**
5. Wait for batch completion (25-50 minutes for 50 accounts)
6. Review results

### Via API

**Create Batch:**
```bash
POST /api/email-accounts/create
{
  "provider": "yandex",
  "count": 10,
  "usernamePrefix": "user",
  "useProxies": true
}
```

**List Accounts:**
```bash
GET /api/email-accounts?provider=yandex&status=active&assigned=false
```

**Assign to Social Account:**
```bash
POST /api/email-accounts/{id}/assign
{
  "socialAccountId": 123
}
```

**Test Login:**
```bash
POST /api/email-accounts/{id}/test
```

**Health Check:**
```bash
GET /api/email-accounts/health
```

## Cost Estimates

### Per Account:
- **Yandex:** ~$0.15 (SMS) + $0.003 (CAPTCHA) = **$0.153**
- **GMX:** ~$0.20 (SMS) + $0.003 (CAPTCHA) = **$0.203**

### Bulk Pricing:
- **100 Yandex accounts:** ~$15.30
- **100 GMX accounts:** ~$20.30
- **500 Yandex accounts:** ~$76.50
- **500 GMX accounts:** ~$101.50
- **1,000 mixed:** ~$170-180

**Proxies:** Already included (Oxylabs residential)

## Timing

- **Per Account:** 30-60 seconds (with delays)
- **10 Accounts:** ~5-10 minutes
- **50 Accounts:** ~25-50 minutes (max batch size)
- **100 Accounts:** ~50-100 minutes (2 batches)
- **500 Accounts:** ~4-8 hours (10 batches)

## Service Health Monitoring

The UI displays real-time health status for:
- **SMS-Man:** Online/Offline + Balance
- **2Captcha:** Online/Offline + Balance
- **CapSolver:** Online/Offline + Balance

Check before creating large batches to ensure services are operational.

## Email Account Management

### Filters:
- Search by email/username
- Filter by provider (Yandex, GMX)
- Filter by status (Active, Inactive, Banned, Locked)
- Filter by assignment (Available, Assigned)

### Actions:
- **Test Login:** Verify account still works
- **Update Status:** Mark as banned/locked if detected
- **Delete:** Remove unused accounts
- **Assign:** Link to social account

## Best Practices

### 1. Start Small
- Test with 1-5 accounts first
- Verify all services working
- Check success rate before scaling

### 2. Use Proxies
- Always enable proxy rotation
- Residential proxies preferred
- Prevents IP bans during creation

### 3. Diversify Providers
- 60% Yandex, 40% GMX recommended
- Don't create all accounts from one provider
- Looks more natural

### 4. Monitor Success Rate
- Expect 80-90% success rate normally
- <70% indicates issues (proxies, captcha, SMS)
- Investigate failed accounts for patterns

### 5. Rate Limiting
- System auto-delays 30-60 seconds between accounts
- Don't create multiple batches simultaneously
- Give providers time between batches (1-2 hours)

### 6. Account Quality
- Test login after creation
- Mark failed accounts appropriately
- Don't use banned/locked accounts

## Troubleshooting

### Problem: Low Success Rate (<70%)

**Possible Causes:**
- SMS-Man out of credits
- CAPTCHA solver timeout
- Proxy quality issues
- Provider anti-bot detection

**Solutions:**
- Check service health dashboard
- Verify API key balances
- Test with fewer accounts
- Use better proxies
- Increase delays between accounts

### Problem: SMS Timeout

**Causes:**
- SMS-Man service delay
- Country/provider combination issues
- Number already used

**Solutions:**
- Try different country codes
- Check SMS-Man status page
- Increase timeout to 180 seconds

### Problem: CAPTCHA Solving Fails

**Causes:**
- 2Captcha overloaded
- Complex reCAPTCHA v3
- Invalid site key extraction

**Solutions:**
- System auto-falls back to CapSolver
- Check both API keys
- Manually verify CAPTCHA type on provider site

### Problem: Accounts Get Banned Quickly

**Causes:**
- No proxy used during creation
- Same IP for multiple accounts
- Too rapid creation (detection)

**Solutions:**
- Always enable proxies
- Use residential proxies only
- Increase delays (60-90 seconds)
- Space out batch creation over days

## Security Considerations

### Credentials Storage
- Passwords stored in plain text in database
- Database should be properly secured
- Consider encryption at rest for production

### API Keys
- Store in `.env` file (not in code)
- Don't commit `.env` to version control
- Rotate keys periodically

### Proxy Usage
- Use residential proxies for account creation
- Rotate proxies per account
- Monitor proxy success rates

## API Reference

### Endpoints

**POST** `/api/email-accounts/create`
- Create batch of email accounts
- Body: `{ provider, count, usernamePrefix, useProxies }`
- Returns: `{ success, successCount, failureCount, accounts, failed }`

**GET** `/api/email-accounts`
- List email accounts with filtering
- Query: `?search=&provider=&status=&assigned=`
- Returns: Array of email accounts

**GET** `/api/email-accounts/stats`
- Get statistics
- Returns: `{ overview, recentActivity }`

**GET** `/api/email-accounts/available`
- Get unassigned emails
- Query: `?provider=`
- Returns: Array of available accounts

**POST** `/api/email-accounts/:id/assign`
- Assign email to social account
- Body: `{ socialAccountId }`
- Returns: `{ success, socialAccount, emailAccount }`

**DELETE** `/api/email-accounts/:id/assign`
- Unassign email from social accounts
- Returns: `{ success, message }`

**POST** `/api/email-accounts/:id/test`
- Test email login
- Returns: `{ success, message }`

**PATCH** `/api/email-accounts/:id/status`
- Update account status
- Body: `{ status }` (active|inactive|banned|locked)
- Returns: Updated account

**DELETE** `/api/email-accounts/:id`
- Delete email account (if not assigned)
- Returns: `{ success, message }`

**GET** `/api/email-accounts/health`
- Check service health
- Returns: `{ smsMan, captcha: { twoCaptcha, capSolver } }`

## Technical Details

### Browser Automation
- **Engine:** Playwright with stealth plugin
- **Anti-Detection:**
  - Disabled automation flags
  - WebRTC blocking
  - Custom navigator properties
  - Human-like typing (50-200ms per character)
  - Random delays (500-2000ms between actions)

### Proxy Integration
- Uses existing Oracle proxy system
- Rotates through residential proxies
- Tracks proxy success/failure
- Falls back to direct if all proxies fail

### Error Handling
- Individual account failures don't stop batch
- Partial success tracked separately
- SMS requests cancelled on failure
- Browser cleanup guaranteed (finally blocks)

## Development

### Running Tests

```bash
# Test SMS-Man connection
node -e "require('./backend/src/services/smsManService').healthCheck().then(console.log)"

# Test CAPTCHA solver
node -e "require('./backend/src/services/captchaSolverService').healthCheck().then(console.log)"

# Create single test account
node -e "require('./backend/src/services/emailAccountCreationService').createYandexAccount('test_user', 'Test123!@#', null).then(console.log)"
```

### Database Queries

```sql
-- View all email accounts
SELECT * FROM email_accounts ORDER BY created_at DESC;

-- Check success rate
SELECT
  provider,
  COUNT(*) as total,
  COUNT(*) FILTER (WHERE status = 'active') as active,
  COUNT(*) FILTER (WHERE is_verified = true) as verified
FROM email_accounts
GROUP BY provider;

-- Find available emails
SELECT * FROM email_accounts
WHERE status = 'active'
AND id NOT IN (SELECT email_account_id FROM social_accounts WHERE email_account_id IS NOT NULL)
LIMIT 10;

-- Assign email to social account
UPDATE social_accounts
SET email_account_id = 123, email = 'user@yandex.com'
WHERE id = 456;
```

## Maintenance

### Regular Tasks

1. **Monitor Service Balances**
   - Check SMS-Man balance weekly
   - Refill when below $10
   - Check CAPTCHA solver credits

2. **Test Account Quality**
   - Randomly test logins monthly
   - Mark failed accounts as inactive
   - Remove banned accounts

3. **Clean Up Unused Emails**
   - Remove old unassigned accounts (6+ months)
   - Archive for potential reuse

4. **Optimize Proxy Usage**
   - Review proxy success rates
   - Disable failing proxies
   - Add new proxies as needed

## Future Enhancements

- [ ] Add Mail.com provider support
- [ ] Implement automatic login testing (cron job)
- [ ] Add email warmup service (send/receive test emails)
- [ ] Implement account aging tracker
- [ ] Add IMAP/SMTP testing
- [ ] Support for custom domain forwarding setup
- [ ] Bulk email assignment wizard
- [ ] Recovery email chaining

## Support

For issues or questions:
- Check service health dashboard first
- Review failed account error messages
- Verify API key balances
- Test with single account before batch
- Check proxy rotation is working

## Legal & Compliance

Creating email accounts in bulk may violate provider Terms of Service. This tool is intended for:
- Legitimate testing environments
- Authorized business use cases
- Personal account management at reasonable scale

Use responsibly and in compliance with all applicable laws and provider policies.
