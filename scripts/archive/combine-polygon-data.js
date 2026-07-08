const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { createReadStream, createWriteStream } = require('fs');

// Configuration
const rootDir = '/Users/tcast/Downloads/polygon';
const stocksPath = 'us_stocks_sip/day_aggs_v1';
const outputFile = '/Users/tcast/Downloads/polygon/combined_stock_data.csv';

async function main() {
  try {
    console.log('Starting CSV file combination process...');
    
    // Find all .csv.gz files
    const files = findAllGzippedFiles(path.join(rootDir, stocksPath));
    console.log(`Found ${files.length} .csv.gz files to process`);
    
    // Sort files by year/month/day for chronological order
    files.sort();
    
    // Process and combine files
    await combineFiles(files, outputFile);
    
    console.log(`\nProcess complete! All data combined into ${outputFile}`);
    console.log(`Total files processed: ${files.length}`);
  } catch (error) {
    console.error('Error in main process:', error);
  }
}

function findAllGzippedFiles(dir) {
  let results = [];
  
  // Check if base directory exists
  if (!fs.existsSync(dir)) {
    console.error(`Base directory not found: ${dir}`);
    return results;
  }
  
  // Walk through directory structure to find all .csv.gz files
  function walkDir(currentPath) {
    const files = fs.readdirSync(currentPath);
    
    for (const file of files) {
      const filePath = path.join(currentPath, file);
      const stat = fs.statSync(filePath);
      
      if (stat.isDirectory()) {
        walkDir(filePath);
      } else if (stat.isFile() && file.endsWith('.csv.gz')) {
        results.push(filePath);
      }
    }
  }
  
  walkDir(dir);
  return results;
}

async function combineFiles(files, outputFile) {
  // Create output directory if it doesn't exist
  const outputDir = path.dirname(outputFile);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  const writeStream = createWriteStream(outputFile);
  let headerWritten = false;
  let processedCount = 0;
  
  for (const file of files) {
    try {
      processedCount++;
      
      // Log progress
      if (processedCount % 100 === 0 || processedCount === 1 || processedCount === files.length) {
        console.log(`Processing file ${processedCount}/${files.length}: ${path.basename(file)}`);
      }
      
      await processFile(file, writeStream, headerWritten);
      
      // After first file, we've written the header
      if (!headerWritten) headerWritten = true;
    } catch (error) {
      console.error(`Error processing file ${file}:`, error);
    }
  }
  
  writeStream.end();
  console.log('\nFinished writing to combined file');
}

function processFile(file, writeStream, skipHeader) {
  return new Promise((resolve, reject) => {
    try {
      const gunzip = zlib.createGunzip();
      const fileStream = createReadStream(file);
      const rl = readline.createInterface({
        input: fileStream.pipe(gunzip),
        crlfDelay: Infinity
      });
      
      let isFirstLine = true;
      
      rl.on('line', (line) => {
        // Skip header on all files except the first one
        if (isFirstLine && skipHeader) {
          isFirstLine = false;
          return;
        }
        
        isFirstLine = false;
        writeStream.write(line + '\n');
      });
      
      rl.on('close', () => {
        resolve();
      });
      
      rl.on('error', (err) => {
        reject(err);
      });
    } catch (error) {
      reject(error);
    }
  });
}

main();