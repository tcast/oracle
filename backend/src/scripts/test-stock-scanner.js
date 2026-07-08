/**
 * Test script for the stock scanner service
 * Run this script to test the stock scanner functionality
 */

const stockScannerService = require('../services/stockScannerService');

async function testStockScanner() {
  try {
    console.log('Testing Stock Scanner Service');
    
    // Initialize database
    console.log('Initializing database...');
    await stockScannerService.initializeDatabase();
    console.log('Database initialized');
    
    // Populate with mock data
    console.log('Populating database with mock data...');
    const populateResult = await stockScannerService.populateWithMockData();
    console.log('Database populated:', populateResult);
    
    // Run a scan
    console.log('Running stock scanner...');
    const scanOptions = {
      minMarketCap: 0,  // No minimum for testing
      maxPE: 100,       // High maximum for testing
      minVolume: 0,     // No minimum for testing
      minSentiment: 0,  // No minimum for testing
      regimeFilter: 'all',
      limit: 5,         // Just get top 5 for testing
      exchange: 'all'
    };
    
    const scanResults = await stockScannerService.scanForBuyingOpportunities(scanOptions);
    console.log(`Scan returned ${scanResults.length} results:`);
    
    // Display results
    scanResults.forEach((result, index) => {
      console.log(`\n${index + 1}. ${result.symbol} (${result.name})`);
      console.log(`   Price: $${result.price}, Score: ${(result.combinedScore * 100).toFixed(1)}%`);
      console.log(`   Regime: ${result.regime}, Sentiment: ${result.sentimentDetails.overall}/10`);
      console.log(`   Technical Score: ${(result.technicalScore * 100).toFixed(1)}%`);
      
      if (result.keyFactors.length > 0) {
        console.log('   Key Factors:');
        result.keyFactors.forEach(factor => console.log(`   - ${factor}`));
      }
      
      if (result.technicalSignals.length > 0) {
        console.log('   Technical Signals:');
        result.technicalSignals.forEach(signal => console.log(`   - ${signal}`));
      }
    });
    
    console.log('\nTest completed successfully');
  } catch (error) {
    console.error('Error testing stock scanner:', error);
  }
}

// Run the test
testStockScanner()
  .then(() => {
    console.log('Test script finished');
    // Keep the process running until all promises are resolved, then exit
    setTimeout(() => process.exit(0), 1000);
  })
  .catch(error => {
    console.error('Test script failed:', error);
    process.exit(1);
  });