const marketDataService = require('./services/marketDataService');

// Enhanced console logging for debugging
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

console.log = function() {
  originalConsoleLog.apply(console, [
    `[${new Date().toISOString()}]`,
    ...arguments
  ]);
};

console.error = function() {
  originalConsoleError.apply(console, [
    `[${new Date().toISOString()}] ERROR:`,
    ...arguments
  ]);
};

async function debugMarketDataService() {
  try {
    console.log('Debugging Market Data Service');
    
    // Check environment variables
    console.log('Environment variables:');
    console.log('- FINNHUB_API_KEY:', process.env.FINNHUB_API_KEY ? 'Set' : 'Not set');
    console.log('- ALPHA_VANTAGE_API_KEY:', process.env.ALPHA_VANTAGE_API_KEY ? 'Set' : 'Not set');
    console.log('- POLYGON_API_KEY:', process.env.POLYGON_API_KEY ? 'Set' : 'Not set');
    
    // Check data directory
    console.log('Checking data directory...');
    await marketDataService.ensureDataDirExists();
    
    // Add mock data for testing
    console.log('Creating mock data for testing...');
    const mockSymbols = [
      { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', type: 'stock', currency: 'USD', active: true },
      { symbol: 'MSFT', name: 'Microsoft Corporation', exchange: 'NASDAQ', type: 'stock', currency: 'USD', active: true },
      { symbol: 'GOOGL', name: 'Alphabet Inc.', exchange: 'NASDAQ', type: 'stock', currency: 'USD', active: true },
      { symbol: 'AMZN', name: 'Amazon.com Inc.', exchange: 'NASDAQ', type: 'stock', currency: 'USD', active: true },
      { symbol: 'META', name: 'Meta Platforms Inc.', exchange: 'NASDAQ', type: 'stock', currency: 'USD', active: true },
      { symbol: 'TSLA', name: 'Tesla Inc.', exchange: 'NASDAQ', type: 'stock', currency: 'USD', active: true },
      { symbol: 'JPM', name: 'JPMorgan Chase & Co.', exchange: 'NYSE', type: 'stock', currency: 'USD', active: true },
      { symbol: 'V', name: 'Visa Inc.', exchange: 'NYSE', type: 'stock', currency: 'USD', active: true },
      { symbol: 'JNJ', name: 'Johnson & Johnson', exchange: 'NYSE', type: 'stock', currency: 'USD', active: true },
      { symbol: 'WMT', name: 'Walmart Inc.', exchange: 'NYSE', type: 'stock', currency: 'USD', active: true }
    ];
    
    await marketDataService.cacheSymbols(mockSymbols);
    console.log('Mock data created successfully');
    
    // Test getting all exchange symbols
    console.log('Testing getAllExchangeSymbols...');
    const symbols = await marketDataService.getAllExchangeSymbols();
    console.log(`Retrieved ${symbols.length} symbols`);
    console.log('Sample symbols:', symbols.slice(0, 3));
    
    console.log('Debug complete');
  } catch (error) {
    console.error('Debug error:', error);
  }
}

// Run the debug function
debugMarketDataService()
  .then(() => console.log('Debug script finished'))
  .catch(err => console.error('Debug script failed:', err));