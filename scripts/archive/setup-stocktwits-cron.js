#!/usr/bin/env node
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

// Get the absolute path to the stocktwits-timestream-scraper.js file
const currentDir = process.cwd();
const scraperPath = path.join(currentDir, 'stocktwits-timestream-scraper.js');

// Ensure the file exists
if (!fs.existsSync(scraperPath)) {
  console.error(`Error: Scraper file not found at ${scraperPath}`);
  process.exit(1);
}

// Modify the stocktwits-timestream-scraper.js file to run in production mode
console.log('Updating scraper to run in production mode...');
const scraperContent = fs.readFileSync(scraperPath, 'utf8');
const updatedContent = scraperContent.replace(
  'const TEST_MODE = true;',
  'const TEST_MODE = false;'
);
fs.writeFileSync(scraperPath, updatedContent);
console.log('Scraper updated to run in production mode.');

// Create a shell script that will be called by cron
const shellScriptPath = path.join(currentDir, 'run-stocktwits-scraper.sh');
const shellScriptContent = `#!/bin/bash
cd ${currentDir}
/usr/bin/env node ${scraperPath} >> ${currentDir}/stocktwits-scraper.log 2>&1
`;

fs.writeFileSync(shellScriptPath, shellScriptContent);
fs.chmodSync(shellScriptPath, '755'); // Make it executable
console.log(`Created shell script at ${shellScriptPath}`);

// Create the crontab entry (runs every 4 hours)
const cronEntry = `0 */4 * * * ${shellScriptPath}`;

// Try to add to existing crontab
try {
  // First, get existing crontab
  const existingCrontab = execSync('crontab -l').toString().trim();
  
  // Check if our entry is already there
  if (existingCrontab.includes(shellScriptPath)) {
    console.log('Cron job already exists, no changes made.');
  } else {
    // Add our entry
    const newCrontab = existingCrontab + (existingCrontab ? '\n' : '') + cronEntry;
    fs.writeFileSync('/tmp/stocktwits-crontab', newCrontab);
    execSync('crontab /tmp/stocktwits-crontab');
    fs.unlinkSync('/tmp/stocktwits-crontab');
    console.log('Cron job added successfully!');
  }
} catch (error) {
  // If crontab -l fails (e.g., no crontab for user), create a new one
  if (error.message.includes('no crontab')) {
    fs.writeFileSync('/tmp/stocktwits-crontab', cronEntry);
    execSync('crontab /tmp/stocktwits-crontab');
    fs.unlinkSync('/tmp/stocktwits-crontab');
    console.log('Cron job added successfully!');
  } else {
    console.error('Error setting up cron job:', error.message);
    console.log('\nTo manually set up the cron job, run:');
    console.log('crontab -e');
    console.log('And add the following line:');
    console.log(cronEntry);
  }
}

console.log('\nSummary:');
console.log('- Updated stocktwits-timestream-scraper.js to run in production mode');
console.log('- Created run-stocktwits-scraper.sh script');
console.log('- Set up cron job to run every 4 hours');
console.log('\nThe scraper will now run every 4 hours and update the Timestream database.');
console.log('Logs will be saved to stocktwits-scraper.log');

// Provide instructions for testing
console.log('\nTo test the scraper immediately, run:');
console.log(`${shellScriptPath}`);
console.log('\nTo view logs, run:');
console.log(`tail -f ${currentDir}/stocktwits-scraper.log`); 