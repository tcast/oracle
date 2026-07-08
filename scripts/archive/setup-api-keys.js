#!/usr/bin/env node

/**
 * API Key Setup Script
 * 
 * This script guides users through setting up API keys for the Oracle platform.
 * It checks for existing API keys, prompts for missing ones, and updates the .env file.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const dotenv = require('dotenv');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Define the API keys required for the application
const requiredApiKeys = [
  {
    name: 'FINNHUB_API_KEY',
    description: 'Finnhub API Key',
    required: false,
    registerUrl: 'https://finnhub.io/',
  },
  {
    name: 'ALPHA_VANTAGE_API_KEY',
    description: 'Alpha Vantage API Key',
    required: false,
    registerUrl: 'https://www.alphavantage.co/',
  },
  {
    name: 'POLYGON_API_KEY',
    description: 'Polygon API Key',
    required: false,
    registerUrl: 'https://polygon.io/',
  },
  {
    name: 'NEWS_API_KEY',
    description: 'News API Key',
    required: false,
    registerUrl: 'https://newsapi.org/',
  },
  {
    name: 'OPENAI_API_KEY',
    description: 'OpenAI API Key',
    required: false,
    registerUrl: 'https://platform.openai.com/',
  }
];

// Define the path to the .env file
const envPath = path.join(__dirname, 'backend', '.env');
const envExamplePath = path.join(__dirname, 'backend', '.env.example');

/**
 * Load the current environment variables
 */
function loadEnvVars() {
  try {
    if (fs.existsSync(envPath)) {
      return dotenv.parse(fs.readFileSync(envPath));
    } else if (fs.existsSync(envExamplePath)) {
      console.log('No .env file found. Creating one from .env.example');
      fs.copyFileSync(envExamplePath, envPath);
      return dotenv.parse(fs.readFileSync(envPath));
    } else {
      console.log('No .env or .env.example file found. Creating a new .env file.');
      return {};
    }
  } catch (error) {
    console.error('Error loading environment variables:', error);
    return {};
  }
}

/**
 * Save environment variables to the .env file
 */
function saveEnvVars(envVars) {
  try {
    const envContent = Object.entries(envVars)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    fs.writeFileSync(envPath, envContent);
    console.log('\n.env file updated successfully!');
  } catch (error) {
    console.error('Error saving environment variables:', error);
  }
}

/**
 * Prompt the user for API keys
 */
async function promptForApiKeys(envVars) {
  console.log('\n=== Oracle API Key Setup ===');
  console.log('\nThis script will help you set up the required API keys for the Oracle platform.');
  console.log('At least one market data API key (Finnhub, Alpha Vantage, or Polygon) is required.');
  console.log('\nPress Enter to keep existing values or leave blank for new entries.\n');

  // Check if at least one market data API key is set
  const hasMarketDataKey = 
    envVars['FINNHUB_API_KEY'] || 
    envVars['ALPHA_VANTAGE_API_KEY'] || 
    envVars['POLYGON_API_KEY'];

  if (!hasMarketDataKey) {
    console.log('\n⚠️  WARNING: No market data API keys are currently set!');
    console.log('The application requires at least one market data API key to function properly.');
  }

  for (const key of requiredApiKeys) {
    const currentValue = envVars[key.name] || '';
    
    // Only show the first few characters of the existing key for security
    const displayValue = currentValue ? 
      `${currentValue.substring(0, 4)}${'*'.repeat(Math.max(0, currentValue.length - 4))}` : 
      'not set';

    const question = `${key.description} (${key.registerUrl})\nCurrent value: ${displayValue}\nNew value: `;
    
    const answer = await new Promise(resolve => rl.question(question, resolve));
    
    // If the user provided a new value, update the environment variables
    if (answer.trim()) {
      envVars[key.name] = answer.trim();
      console.log(`✓ ${key.description} updated.`);
    }
    
    console.log(''); // Add a blank line for readability
  }

  return envVars;
}

/**
 * Check if at least one required API key is set
 */
function validateApiKeys(envVars) {
  const hasMarketDataKey = 
    envVars['FINNHUB_API_KEY'] || 
    envVars['ALPHA_VANTAGE_API_KEY'] || 
    envVars['POLYGON_API_KEY'];

  if (!hasMarketDataKey) {
    console.log('\n⚠️  WARNING: No market data API keys are set!');
    console.log('The application requires at least one market data API key to function properly.');
    console.log('Please register for at least one of the following services:');
    console.log(' - Finnhub: https://finnhub.io/');
    console.log(' - Alpha Vantage: https://www.alphavantage.co/');
    console.log(' - Polygon: https://polygon.io/');
  } else {
    console.log('\n✓ Market data API keys validated successfully!');
    console.log('The application has at least one market data API key configured.');
  }
}

/**
 * Run the setup script
 */
async function run() {
  try {
    // Load the current environment variables
    let envVars = loadEnvVars();
    
    // Prompt the user for API keys
    envVars = await promptForApiKeys(envVars);
    
    // Save the updated environment variables
    saveEnvVars(envVars);
    
    // Validate the API keys
    validateApiKeys(envVars);
    
    console.log('\nSetup complete! You can now start the application.');
    console.log('If you need to update your API keys in the future, run this script again.');
  } catch (error) {
    console.error('Error running setup script:', error);
  } finally {
    rl.close();
  }
}

// Run the script
run(); 