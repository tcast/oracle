/**
 * Script to generate sample historical stock data files locally
 */

const fs = require('fs');
const path = require('path');

// Directory to store data files
const DATA_DIR = path.join(__dirname, 'data', 'stocks');

// List of stock symbols to create data for
const symbols = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META'];

/**
 * Ensure directory exists
 * @param {string} dir - Directory path
 */
function ensureDirectoryExists(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`Created directory: ${dir}`);
  }
}

/**
 * Generate sample stock data CSV content
 * @param {string} symbol - Stock symbol
 * @returns {string} - CSV content
 */
function generateSampleData(symbol) {
  const startDate = new Date('2003-01-01');
  const endDate = new Date('2023-12-31');
  const rows = ['date,open,high,low,close,volume,adj_close'];
  
  // Generate random but realistic stock data
  let currentPrice = 50 + (Math.random() * 50); // Starting price between $50-$100
  
  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    // Skip weekends
    if (d.getDay() === 0 || d.getDay() === 6) {
      continue;
    }
    
    // Generate random price movements (max 3% daily change)
    const changePercent = (Math.random() * 6) - 3; // -3% to +3%
    const change = currentPrice * (changePercent / 100);
    
    const open = currentPrice;
    const close = currentPrice + change;
    currentPrice = close; // Set for next day
    
    // High is the higher of open/close plus a random amount
    const high = Math.max(open, close) + (Math.random() * Math.abs(change));
    
    // Low is the lower of open/close minus a random amount
    const low = Math.min(open, close) - (Math.random() * Math.abs(change));
    
    // Volume - random between 1M and 10M
    const volume = Math.floor(1000000 + (Math.random() * 9000000));
    
    // Format date as YYYY-MM-DD
    const dateStr = d.toISOString().split('T')[0];
    
    rows.push(`${dateStr},${open.toFixed(2)},${high.toFixed(2)},${low.toFixed(2)},${close.toFixed(2)},${volume},${close.toFixed(2)}`);
  }
  
  return rows.join('\n');
}

/**
 * Save sample stock data to a local file
 * @param {string} symbol - Stock symbol
 * @returns {Promise<string>} - File path
 */
function saveSampleData(symbol) {
  const filePath = path.join(DATA_DIR, `${symbol}.csv`);
  const data = generateSampleData(symbol);
  
  console.log(`Generating sample data for ${symbol} to ${filePath}`);
  fs.writeFileSync(filePath, data);
  console.log(`Successfully saved sample data for ${symbol}`);
  
  return filePath;
}

/**
 * Main function
 */
function main() {
  try {
    ensureDirectoryExists(DATA_DIR);
    
    const results = [];
    
    for (const symbol of symbols) {
      try {
        const filePath = saveSampleData(symbol);
        results.push({
          symbol,
          filePath,
          success: true
        });
      } catch (error) {
        console.error(`Error generating sample data for ${symbol}:`, error);
        results.push({
          symbol,
          success: false,
          error: error.message
        });
      }
    }
    
    console.log('Generation summary:');
    console.log(JSON.stringify(results, null, 2));
    
    console.log('\nSample data generation complete.');
    console.log(`Data directory: ${DATA_DIR}`);
    
    // Count the total number of data points
    let totalRows = 0;
    for (const result of results) {
      if (result.success) {
        const content = fs.readFileSync(result.filePath, 'utf8');
        const lines = content.split('\n').length - 1; // Subtract header
        totalRows += lines;
        console.log(`${result.symbol}: ${lines} days of data`);
      }
    }
    console.log(`Total: ${totalRows} days of data across ${results.filter(r => r.success).length} symbols`);
    
  } catch (error) {
    console.error('Error in main function:', error);
  }
}

// Run the script
main(); 