# Oxylabs Setup Guide

## 1. Sign Up & Purchase

1. Go to [Oxylabs dashboard](https://dashboard.oxylabs.io)
2. Start with **Pay-As-You-Go** plan
3. Purchase 5-10 GB to start (you can top up anytime)

## 2. Get Your Credentials

After signup, you'll get:
- **Username**: Your Oxylabs username
- **Password**: Your Oxylabs password

## 3. Add to Environment Variables

Add to your `/backend/.env` file:
```env
OXYLABS_USERNAME=your_username
OXYLABS_PASSWORD=your_password
```

## 4. Import Proxies to Database

Run the import script:
```bash
cd backend
node src/scripts/import-oxylabs-proxies.js
```

This will create:
- 10 US proxies (5 cities × 2 sessions each)
- 3 UK proxies
- 2 Canada proxies

## 5. Auto-Assign to Accounts (Optional)

```bash
node src/scripts/import-oxylabs-proxies.js --auto-assign
```

This assigns 3 proxies to each social account for rotation.

## 6. Test Your Setup

Test a proxy connection:
```bash
curl -x pr.oxylabs.io:7777 \
  -U "customer-YOUR_USERNAME-cc-US:YOUR_PASSWORD" \
  https://ip.oxylabs.io
```

You should see a US IP address in the response.

## Usage Estimation

### Bandwidth per Activity:
- **Login**: ~2-3 MB
- **Create Post**: ~3-5 MB
- **Add Comment**: ~1-2 MB
- **Browse Feed**: ~5-10 MB

### Monthly Estimates:
- **50 accounts, 1 post/day each**: ~7.5 GB/month
- **100 accounts, 2 posts/day each**: ~30 GB/month
- **200 accounts, 2 posts/day each**: ~60 GB/month

## Proxy Configuration

The system automatically configures:
- **Sticky Sessions**: 30-minute sessions to maintain login state
- **Geographic Targeting**: US cities (NY, LA, Chicago, Houston, Miami)
- **Rotation**: Each account rotates between 3 assigned proxies

## Best Practices

1. **Monitor Usage**: Check Oxylabs dashboard regularly
2. **Test First**: Run small batches before scaling
3. **Geographic Matching**: Use US proxies for US-targeted campaigns
4. **Session Duration**: 30-minute sticky sessions work well for social media

## Troubleshooting

### Proxy Not Working?
1. Check credentials in .env file
2. Verify you have remaining bandwidth
3. Test with curl command above

### High Detection Rate?
1. Ensure using residential proxies (not datacenter)
2. Increase delays between actions
3. Use different session IDs per account

### Connection Errors?
- Oxylabs endpoint: `pr.oxylabs.io:7777`
- Protocol: HTTP/HTTPS
- Authentication: Username with parameters
