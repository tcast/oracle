/**
 * Scheduled script to update historical performance data
 * 
 * This script updates the historical performance data for all assets in the database.
 * It can be scheduled to run daily or weekly to keep the historical data up-to-date.
 */

const pool = require('./services/db');
const investmentScreenerService = require('./services/investmentScreenerService');

/**
 * Update historical performance data for all assets
 */
async function updateHistoricalPerformance() {
  try {
    console.log('Starting historical performance update...');
    console.log('Timestamp:', new Date().toISOString());
    
    // Get all unique assets from the database
    const assetsResult = await pool.query(`
      SELECT DISTINCT symbol, asset_type 
      FROM investment_screener_results 
      ORDER BY asset_type, symbol
    `);
    
    const assets = assetsResult.rows;
    console.log(`Found ${assets.length} unique assets to update`);
    
    // Process each asset
    for (const asset of assets) {
      try {
        console.log(`Updating historical performance for ${asset.symbol} (${asset.asset_type})...`);
        
        // Get historical performance data
        const performance = await investmentScreenerService.getHistoricalPerformance(
          asset.symbol, 
          asset.asset_type, 
          6 // Default to 6 months
        );
        
        console.log(`  - Total predictions: ${performance.totalPredictions}`);
        console.log(`  - Accuracy rate: ${performance.accuracyRate}%`);
        console.log(`  - Data points: ${performance.data.length}`);
        
        // Optional: Save the performance data to a separate table for quick access
        // This would require creating a new table to store the results
        
        // Count how many predictions were enhanced with historical news/social data
        const enhancedCount = performance.data.filter(item => 
          item.news_data_count > 0 || item.social_data_count > 0
        ).length;
        
        if (enhancedCount > 0) {
          console.log(`  - Enhanced predictions: ${enhancedCount}/${performance.data.length} (${((enhancedCount/performance.data.length)*100).toFixed(1)}%)`);
        }
      } catch (error) {
        console.error(`Error updating ${asset.symbol} (${asset.asset_type}):`, error.message);
        // Continue with next asset
      }
    }
    
    console.log('Historical performance update completed!');
  } catch (error) {
    console.error('Error updating historical performance:', error);
  } finally {
    // Close the database connection
    await pool.end();
  }
}

// Run the update
updateHistoricalPerformance().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
}); 