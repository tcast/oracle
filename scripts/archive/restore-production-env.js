// Script to restore production database credentials for all Lambda functions
const { exec } = require('child_process');
const fs = require('fs');
require('dotenv').config();

// List of Lambda functions to update
const lambdaFunctions = [
  'oracle-coordinator',
  'oracle-reddit-scraper',
  'oracle-stocktwits-scraper',
  'updateDailyOHLC', // Added this Lambda function
];

// Production database credentials from previous environment
const productionEnv = {
  DB_HOST: 'oracle-db.cyruxuioaadm.us-east-1.rds.amazonaws.com',
  DB_NAME: 'oracle',
  DB_USER: 'postgres',
  DB_PASSWORD: 'QnEv5TgRxC3LbH7Wd9Kp',
  DB_PORT: '5432',
  DB_SSL: 'true',
  SCRAPEBEE_API_KEY: 'U0UFJRTTMQNLTP8BY99Q01PI1L5OXJ9KFK351VJ26D8ZXR7UUJKKUTEEZIQ0I96TVHNGDLZBJZ7D247'
};

async function main() {
  console.log('=== Restore Production Environment Variables ===');
  
  // For each Lambda function
  for (const functionName of lambdaFunctions) {
    console.log(`\n============================================`);
    console.log(`Processing Lambda function: ${functionName}`);
    console.log(`============================================`);
    
    // Get current environment variables
    console.log(`Getting current environment for ${functionName}...`);
    const getEnvResult = await execCommand(`aws lambda get-function-configuration --function-name ${functionName}`);
    
    if (getEnvResult.error) {
      console.error(`Error retrieving configuration for ${functionName}:`, getEnvResult.stderr);
      console.log(`Skipping ${functionName}, moving to next function...`);
      continue;
    }
    
    let currentEnv = {};
    try {
      const config = JSON.parse(getEnvResult.stdout);
      if (config.Environment && config.Environment.Variables) {
        currentEnv = config.Environment.Variables;
      }
      console.log(`Current environment variables for ${functionName}:`);
      const maskedEnv = maskSensitiveValues(currentEnv);
      console.log(JSON.stringify(maskedEnv, null, 2));
    } catch (error) {
      console.error(`Error parsing configuration for ${functionName}:`, error.message);
      console.log(`Skipping ${functionName}, moving to next function...`);
      continue;
    }
    
    // Create new environment variables by merging current with production values
    const newEnv = {
      ...currentEnv,
      
      // Database configuration
      DB_HOST: productionEnv.DB_HOST,
      DB_NAME: productionEnv.DB_NAME,
      DB_USER: productionEnv.DB_USER,
      DB_PASSWORD: productionEnv.DB_PASSWORD,
      DB_PORT: productionEnv.DB_PORT,
      DB_SSL: productionEnv.DB_SSL,
      
      // ScrapingBee API key (for scraping functions)
      SCRAPEBEE_API_KEY: productionEnv.SCRAPEBEE_API_KEY,
      
      // Keep table name as stock_symbols
      TABLE_NAME: 'stock_symbols', 
    };
    
    // Log the updated environment variables (masked)
    console.log(`\nNew environment variables for ${functionName}:`);
    const maskedNewEnv = maskSensitiveValues(newEnv);
    console.log(JSON.stringify(maskedNewEnv, null, 2));
    
    // Create JSON file with environment variables
    const envFileName = `./${functionName}-environment.json`;
    
    // Create the JSON structure for the update-function-configuration command
    const envConfig = {
      Variables: newEnv
    };
    
    fs.writeFileSync(envFileName, JSON.stringify(envConfig, null, 2));
    console.log(`Environment config saved to ${envFileName}`);
    
    // Update the Lambda function environment variables
    console.log(`Updating environment variables for ${functionName}...`);
    const updateResult = await execCommand(`
      aws lambda update-function-configuration \
        --function-name ${functionName} \
        --environment file://${envFileName}
    `);
    
    if (updateResult.error) {
      console.error(`Error updating environment variables for ${functionName}:`, updateResult.stderr);
      console.log(`Update failed for ${functionName}, moving to next function...`);
    } else {
      console.log(`Successfully updated environment variables for ${functionName}!`);
    }
    
    // Clean up the environment file
    try {
      fs.unlinkSync(envFileName);
      console.log(`Removed temporary file: ${envFileName}`);
    } catch (error) {
      console.error(`Warning: Could not remove ${envFileName}:`, error.message);
    }
  }
  
  console.log('\n=== Summary ===');
  console.log(`Updated ${lambdaFunctions.length} Lambda functions with production credentials`);
  console.log('Next steps:');
  console.log('1. Test each function with a test event');
  console.log('2. Monitor CloudWatch logs for any errors');
}

// Helper function to mask sensitive values
function maskSensitiveValues(env) {
  const result = { ...env };
  const sensitiveKeys = ['PASSWORD', 'KEY', 'SECRET', 'TOKEN'];
  
  for (const key in result) {
    if (sensitiveKeys.some(sensitive => key.toUpperCase().includes(sensitive))) {
      if (result[key] && result[key].length > 0) {
        result[key] = '****' + result[key].substring(result[key].length - 4);
      }
    }
  }
  
  return result;
}

// Helper function to execute commands
function execCommand(command) {
  return new Promise((resolve) => {
    exec(command, (error, stdout, stderr) => {
      if (stdout) console.log(stdout);
      if (stderr && !error) console.log(stderr);
      resolve({ error, stdout, stderr });
    });
  });
}

// Run the main function
main().catch(error => {
  console.error('Unexpected error:', error);
  process.exit(1);
}); 