/**
 * Script to run the Polygon historical data loader with all environment variables explicitly set
 */

// Import required modules
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

// Read environment variables from .env file
const envFile = path.join(__dirname, 'backend', '.env');
const envVars = {};

try {
  const envContent = fs.readFileSync(envFile, 'utf8');
  envContent.split('\n').forEach(line => {
    const parts = line.split('=');
    if (parts.length === 2) {
      const key = parts[0].trim();
      const value = parts[1].trim();
      envVars[key] = value;
    }
  });
  
  console.log('Successfully loaded environment variables from backend/.env');
} catch (error) {
  console.error('Error reading .env file:', error);
  process.exit(1);
}

// Required environment variables
const requiredVars = [
  'POLYGON_API_KEY',
  'DB_USER',
  'DB_PASSWORD',
  'DB_HOST',
  'DB_NAME',
  'DB_PORT',
  'DB_REQUIRE_SSL'
];

// Check for missing required variables
const missingVars = requiredVars.filter(varName => !envVars[varName]);
if (missingVars.length > 0) {
  console.error('Missing required environment variables:', missingVars.join(', '));
  process.exit(1);
}

console.log('Starting Polygon historical data loader with explicit environment variables...');

// Spawn the loader process with environment variables
const env = { ...process.env, ...envVars };
const loader = spawn('node', ['polygon-historical-loader.js'], {
  env,
  stdio: 'inherit'
});

loader.on('close', (code) => {
  console.log(`Polygon loader process exited with code ${code}`);
});