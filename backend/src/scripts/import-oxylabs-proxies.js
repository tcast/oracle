#!/usr/bin/env node

require('dotenv').config();
const proxyService = require('../services/proxyService');
const OxylabsProxyFormatter = require('../services/oxylabsProxyFormatter');
const pool = require('../services/db');

async function importOxylabsProxies() {
  console.log('🔷 Oxylabs Proxy Import Tool\n');

  // Check for Oxylabs credentials in environment
  const oxylabsUsername = process.env.OXYLABS_USERNAME;
  const oxylabsPassword = process.env.OXYLABS_PASSWORD;

  if (!oxylabsUsername || !oxylabsPassword) {
    console.error('❌ Missing Oxylabs credentials!');
    console.log('\nPlease add to your .env file:');
    console.log('OXYLABS_USERNAME=your_username');
    console.log('OXYLABS_PASSWORD=your_password\n');
    process.exit(1);
  }

  try {
    // Generate proxy configurations
    console.log('📋 Generating proxy configurations...\n');
    
    const proxies = OxylabsProxyFormatter.generateImportConfig({
      username: oxylabsUsername,
      password: oxylabsPassword
    });

    console.log(`Generated ${proxies.length} proxy configurations:`);
    console.log('- US proxies: 10 (5 cities × 2 sessions)');
    console.log('- UK proxies: 3');
    console.log('- CA proxies: 2\n');

    // Import proxies
    console.log('💾 Importing proxies to database...\n');
    
    const results = await proxyService.bulkImportProxies(proxies);
    
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    
    console.log(`✅ Import complete:`);
    console.log(`- Successful: ${successful}`);
    console.log(`- Failed: ${failed}`);
    
    if (failed > 0) {
      console.log('\n❌ Failed imports:');
      results.filter(r => !r.success).forEach(r => {
        console.log(`  - ${r.data.name}: ${r.error}`);
      });
    }

    // Show proxy distribution
    console.log('\n📊 Proxy Distribution:');
    const stats = await proxyService.getProxyStats();
    stats.byCountry.forEach(country => {
      console.log(`  - ${country.country}: ${country.count} proxies`);
    });

    // Suggest account assignment
    console.log('\n💡 Next Steps:');
    console.log('1. Test a proxy:');
    console.log('   curl -x pr.oxylabs.io:7777 -U "customer-USERNAME-cc-US:PASSWORD" https://ip.oxylabs.io\n');
    
    console.log('2. Assign proxies to accounts:');
    console.log('   - US accounts → US proxies');
    console.log('   - UK accounts → UK proxies');
    console.log('   - Each account should have 2-3 proxies for rotation\n');

    // Optional: Auto-assign to accounts
    const autoAssign = process.argv.includes('--auto-assign');
    if (autoAssign) {
      console.log('🔄 Auto-assigning proxies to accounts...\n');
      await autoAssignProxies();
    } else {
      console.log('Run with --auto-assign to automatically assign proxies to accounts');
    }

  } catch (error) {
    console.error('❌ Import failed:', error.message);
  } finally {
    await pool.end();
  }
}

async function autoAssignProxies() {
  try {
    // Get all accounts
    const accountsResult = await pool.query(
      'SELECT id, username, platform FROM social_accounts WHERE is_active = true'
    );
    
    const accounts = accountsResult.rows;
    console.log(`Found ${accounts.length} active accounts\n`);

    // Get all proxies grouped by country
    const usProxies = await proxyService.getActiveProxies({ country: 'US' });
    const ukProxies = await proxyService.getActiveProxies({ country: 'GB' });
    const caProxies = await proxyService.getActiveProxies({ country: 'CA' });

    let assignmentCount = 0;

    for (const account of accounts) {
      // Assign 3 proxies per account (round-robin from available pool)
      let availableProxies = usProxies; // Default to US
      
      // You can add logic here to match accounts to specific regions
      // For now, we'll use US proxies for all accounts
      
      if (availableProxies.length >= 3) {
        // Take 3 proxies from the pool
        const selectedProxies = availableProxies.slice(0, 3);
        const proxyIds = selectedProxies.map(p => p.id);
        
        await proxyService.assignProxiesToAccount(account.id, proxyIds);
        
        console.log(`✅ Assigned 3 proxies to ${account.username} (${account.platform})`);
        assignmentCount++;
        
        // Remove used proxies from pool to ensure distribution
        availableProxies = availableProxies.slice(3);
      }
    }

    console.log(`\n✅ Assigned proxies to ${assignmentCount} accounts`);

  } catch (error) {
    console.error('❌ Auto-assignment failed:', error.message);
  }
}

// Show usage examples
function showUsageExamples() {
  console.log('\n📚 Oxylabs Integration Examples:\n');
  
  console.log('1. Basic Connection Test:');
  console.log('```bash');
  console.log('curl -x pr.oxylabs.io:7777 \\');
  console.log('  -U "customer-USERNAME-cc-US:PASSWORD" \\');
  console.log('  https://ip.oxylabs.io');
  console.log('```\n');

  console.log('2. With City Targeting:');
  console.log('```bash');
  console.log('curl -x pr.oxylabs.io:7777 \\');
  console.log('  -U "customer-USERNAME-cc-US-city-new_york:PASSWORD" \\');
  console.log('  https://ip.oxylabs.io');
  console.log('```\n');

  console.log('3. Sticky Session (30 min):');
  console.log('```bash');
  console.log('curl -x pr.oxylabs.io:7777 \\');
  console.log('  -U "customer-USERNAME-cc-US-sessid-123-sesstime-30:PASSWORD" \\');
  console.log('  https://ip.oxylabs.io');
  console.log('```\n');

  console.log('4. In Your Code:');
  console.log('```javascript');
  console.log('// Proxies are automatically used when posting!');
  console.log('await playwrightService.createRedditPost(accountId, subreddit, title, content);');
  console.log('// The system will use the assigned Oxylabs proxy');
  console.log('```');
}

// Run the import
importOxylabsProxies().then(() => {
  showUsageExamples();
});
