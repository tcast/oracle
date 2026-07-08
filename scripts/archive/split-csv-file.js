const fs = require('fs');
const readline = require('readline');
const path = require('path');

// Configuration
const CSV_FILE_PATH = '/Users/tcast/Downloads/polygon/combined_stock_data.csv';
const OUTPUT_DIR = '/Users/tcast/Downloads/polygon/split_csv';
const LINES_PER_FILE = 1000000; // 1 million lines per file

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log(`Created output directory: ${OUTPUT_DIR}`);
}

async function splitCSVFile() {
  const startTime = Date.now();
  console.log(`Splitting CSV file: ${CSV_FILE_PATH}`);
  console.log(`Output directory: ${OUTPUT_DIR}`);
  console.log(`Splitting into chunks of ${LINES_PER_FILE.toLocaleString()} lines`);
  
  // Create readline interface
  const fileStream = fs.createReadStream(CSV_FILE_PATH);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });
  
  let header = '';
  let lineCount = 0;
  let fileCount = 0;
  let currentFileWriter = null;
  
  // Process line by line
  for await (const line of rl) {
    lineCount++;
    
    // Save header line
    if (lineCount === 1) {
      header = line;
      console.log(`CSV Header: ${header}`);
      
      // Create first output file
      fileCount++;
      const outputFilePath = path.join(OUTPUT_DIR, `chunk_${String(fileCount).padStart(3, '0')}.csv`);
      currentFileWriter = fs.createWriteStream(outputFilePath);
      currentFileWriter.write(header + '\n');
      
      continue;
    }
    
    // Check if we need to create a new file
    if ((lineCount - 1) % LINES_PER_FILE === 0 && lineCount > 1) {
      // Close current file
      if (currentFileWriter) {
        currentFileWriter.end();
      }
      
      // Create new file
      fileCount++;
      const outputFilePath = path.join(OUTPUT_DIR, `chunk_${String(fileCount).padStart(3, '0')}.csv`);
      currentFileWriter = fs.createWriteStream(outputFilePath);
      currentFileWriter.write(header + '\n'); // Write header to new file
      
      const progress = ((lineCount - 1) / LINES_PER_FILE).toFixed(0);
      const elapsedSeconds = (Date.now() - startTime) / 1000;
      const linesPerSecond = Math.round(lineCount / elapsedSeconds);
      
      console.log(`Created file ${fileCount}: ${outputFilePath}`);
      console.log(`Processed ${lineCount.toLocaleString()} lines (${progress} chunks)`);
      console.log(`Processing speed: ${linesPerSecond.toLocaleString()} lines/second`);
    }
    
    // Write line to current file
    currentFileWriter.write(line + '\n');
    
    // Log progress every 1 million lines
    if (lineCount % 1000000 === 0) {
      const elapsedSeconds = (Date.now() - startTime) / 1000;
      const linesPerSecond = Math.round(lineCount / elapsedSeconds);
      console.log(`Processed ${lineCount.toLocaleString()} lines`);
      console.log(`Processing speed: ${linesPerSecond.toLocaleString()} lines/second`);
    }
  }
  
  // Close the last file
  if (currentFileWriter) {
    currentFileWriter.end();
  }
  
  const elapsedSeconds = (Date.now() - startTime) / 1000;
  const linesPerSecond = Math.round(lineCount / elapsedSeconds);
  
  console.log('\nCSV split complete!');
  console.log(`Total lines processed: ${lineCount.toLocaleString()}`);
  console.log(`Created ${fileCount} output files`);
  console.log(`Total time: ${Math.round(elapsedSeconds)} seconds`);
  console.log(`Average speed: ${linesPerSecond.toLocaleString()} lines per second`);
}

// Run the splitting function
splitCSVFile()
  .then(() => {
    console.log('Split operation completed successfully');
    process.exit(0);
  })
  .catch(error => {
    console.error('Split operation failed:', error);
    process.exit(1);
  }); 