require('dotenv').config();
const proxyService = require('./services/proxyService');
const pool = require('./services/db');

async function testProxySystem() {
  console.log('Testing Proxy Management System\n');
  
  try {
    // 1. Create some test proxies
    console.log('1. Creating test proxies...');
    
    const testProxies = [
      {
        name: 'US Residential Proxy 1',
        type: 'http',
        server: 'proxy1.example.com:8080',
        username: 'user1',
        password: 'pass1',
        country: 'US',
        city: 'New York',
        provider: 'ExampleProvider',
        is_residential: true
      },
      {
        name: 'US Residential Proxy 2',
        type: 'socks5',
        server: 'proxy2.example.com:1080',
        username: 'user2',
        password: 'pass2',
        country: 'US',
        city: 'Los Angeles',
        provider: 'ExampleProvider',
        is_residential: true
      },
      {
        name: 'UK Datacenter Proxy',
        type: 'http',
        server: 'uk-proxy.example.com:3128',
        username: 'ukuser',
        password: 'ukpass',
        country: 'GB',
        city: 'London',
        provider: 'DatacenterProvider',
        is_residential: false
      }
    ];
    
    const createdProxies = [];
    for (const proxy of testProxies) {
      const created = await proxyService.createProxy(proxy);
      createdProxies.push(created);
      console.log(`  ✅ Created proxy: ${created.name} (ID: ${created.id})`);
    }
    
    // 2. Get proxy statistics
    console.log('\n2. Proxy Statistics:');
    const stats = await proxyService.getProxyStats();
    console.log('  Overview:', stats.overview);
    console.log('  By Country:', stats.byCountry);
    console.log('  By Provider:', stats.byProvider);
    
    // 3. Assign proxies to a social account
    console.log('\n3. Assigning proxies to social accounts...');
    
    // Get a test social account
    const accountResult = await pool.query(
      'SELECT id, username FROM social_accounts LIMIT 1'
    );
    
    if (accountResult.rows.length > 0) {
      const account = accountResult.rows[0];
      console.log(`  Using account: ${account.username} (ID: ${account.id})`);
      
      // Assign multiple proxies to the account
      const proxyIds = createdProxies.slice(0, 2).map(p => p.id);
      const assignments = await proxyService.assignProxiesToAccount(account.id, proxyIds);
      console.log(`  ✅ Assigned ${assignments.length} proxies to account`);
      
      // 4. Test proxy rotation
      console.log('\n4. Testing proxy rotation...');
      for (let i = 0; i < 3; i++) {
        const proxy = await proxyService.getNextProxyForAccount(account.id);
        if (proxy) {
          console.log(`  Rotation ${i + 1}: Using proxy ${proxy.server}`);
        }
      }
      
      // 5. Get account proxies
      console.log('\n5. Getting proxies for account...');
      const accountProxies = await proxyService.getAccountProxies(account.id);
      console.log(`  Account has ${accountProxies.length} active proxies:`);
      accountProxies.forEach(p => {
        console.log(`    - ${p.name} (Priority: ${p.priority}, Use count: ${p.account_use_count})`);
      });
    } else {
      console.log('  ⚠️  No social accounts found. Create some accounts first.');
    }
    
    // 6. Test proxy connection (commented out to avoid actual connection)
    console.log('\n6. Testing proxy connection...');
    console.log('  ⚠️  Skipping actual proxy test (would need real proxy)');
    // Uncomment to test with real proxy:
    // const testResult = await proxyService.testProxy(createdProxies[0].id);
    // console.log('  Test result:', testResult);
    
    // 7. Filter proxies
    console.log('\n7. Filtering proxies...');
    const usProxies = await proxyService.getActiveProxies({ country: 'US' });
    console.log(`  Found ${usProxies.length} US proxies`);
    
    const residentialProxies = await proxyService.getActiveProxies({ is_residential: true });
    console.log(`  Found ${residentialProxies.length} residential proxies`);
    
    // Cleanup (optional - comment out to keep test data)
    console.log('\n8. Cleanup...');
    console.log('  ⚠️  Keeping test data. Manually delete if needed.');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    await pool.end();
  }
}

// Example of how to use in production:
function showUsageExamples() {
  console.log('\n📚 Usage Examples:\n');
  
  console.log('1. Import real proxies (JSON format):');
  console.log(`
const proxies = [
  {
    name: "Premium US Proxy 1",
    type: "socks5",
    server: "us1.residential-proxies.com:1080",
    username: "myuser",
    password: "mypass",
    country: "US",
    provider: "BrightData",
    is_residential: true
  }
];
await proxyService.bulkImportProxies(proxies);
`);

  console.log('2. Assign proxies to accounts by location:');
  console.log(`
// Get US proxies for US accounts
const usProxies = await proxyService.getActiveProxies({ country: 'US' });
const usAccounts = await getAccountsByCountry('US');

for (const account of usAccounts) {
  // Assign 3 random US proxies to each account
  const selectedProxies = usProxies.sort(() => 0.5 - Math.random()).slice(0, 3);
  await proxyService.assignProxiesToAccount(account.id, selectedProxies.map(p => p.id));
}
`);

  console.log('3. In your posting service:');
  console.log(`
// The playwright service automatically gets the next proxy
const { browser, context, page } = await this.createBrowserForAccount(accountId);
// Proxy is automatically rotated!
`);
}

// Run the test
testProxySystem().then(() => {
  showUsageExamples();
});
