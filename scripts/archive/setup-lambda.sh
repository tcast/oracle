#!/bin/bash
set -e

# Color codes for terminal output
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}==================================================${NC}"
echo -e "${BLUE}   Oracle Investment Screener - Lambda Setup       ${NC}"
echo -e "${BLUE}==================================================${NC}\n"

# ---------------------------------------------------------------------
# PART 1: Configuration
# ---------------------------------------------------------------------
echo -e "${YELLOW}STEP 1: Setting up configuration${NC}"

# Get RDS endpoint
RDS_ENDPOINT="oracle-db.cyruxuioaadm.us-east-1.rds.amazonaws.com"
DB_USERNAME="postgres"
read -sp "Enter your RDS database password: " DB_PASSWORD
echo ""
DB_NAME="oracle"
AWS_REGION="us-east-1"

# Get ScrapeBee API key from your .env file
ENV_FILE="/Users/tcast/Documents/Sites/oracle/backend/.env"
SCRAPEBEE_API_KEY=$(grep SCRAPEBEE_API_KEY "$ENV_FILE" | cut -d '=' -f2)

echo -e "${GREEN}✓ Configuration loaded${NC}\n"

# ---------------------------------------------------------------------
# PART 2: Create IAM Role
# ---------------------------------------------------------------------
echo -e "${YELLOW}STEP 2: Creating IAM role for Lambda${NC}"

# Check if role already exists
ROLE_EXISTS=$(aws iam list-roles --query "Roles[?RoleName=='OracleLambdaScraperRole'].RoleName" --output text)

if [ -z "$ROLE_EXISTS" ]; then
    # Create IAM role
    TRUST_POLICY='{
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Principal": {
                    "Service": "lambda.amazonaws.com"
                },
                "Action": "sts:AssumeRole"
            }
        ]
    }'

    # Save policy to file
    echo "$TRUST_POLICY" > /tmp/trust-policy.json

    # Create the role
    aws iam create-role \
        --role-name OracleLambdaScraperRole \
        --assume-role-policy-document file:///tmp/trust-policy.json

    # Attach necessary policies
    aws iam attach-role-policy \
        --role-name OracleLambdaScraperRole \
        --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

    aws iam attach-role-policy \
        --role-name OracleLambdaScraperRole \
        --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole

    echo -e "${GREEN}✓ Created IAM role: OracleLambdaScraperRole${NC}"
else
    echo -e "${GREEN}✓ IAM role OracleLambdaScraperRole already exists${NC}"
fi

# Get role ARN
LAMBDA_ROLE_ARN=$(aws iam get-role --role-name OracleLambdaScraperRole --query "Role.Arn" --output text)

echo -e "${GREEN}✓ Using IAM role: $LAMBDA_ROLE_ARN${NC}\n"

# ---------------------------------------------------------------------
# PART 3: Create Lambda Function Code
# ---------------------------------------------------------------------
echo -e "${YELLOW}STEP 3: Creating Lambda function code${NC}"

# Create a temporary directory for Lambda code
TEMP_DIR=$(mktemp -d)
echo "Using temporary directory: $TEMP_DIR"

# Create directories for each Lambda function
mkdir -p "$TEMP_DIR/coordinator" "$TEMP_DIR/reddit-scraper" "$TEMP_DIR/stocktwits-scraper" "$TEMP_DIR/sentiment-analyzer"

# Create package.json for each function
for DIR in "$TEMP_DIR/coordinator" "$TEMP_DIR/reddit-scraper" "$TEMP_DIR/stocktwits-scraper" "$TEMP_DIR/sentiment-analyzer"; do
    cat > "$DIR/package.json" << EOL
{
  "name": "oracle-scraper",
  "version": "1.0.0",
  "description": "Oracle Investment Screener - Social Media Scraper",
  "main": "index.js",
  "dependencies": {
    "@aws-sdk/client-lambda": "^3.350.0",
    "@aws-sdk/client-secrets-manager": "^3.350.0",
    "@aws-sdk/client-sns": "^3.350.0",
    "axios": "^1.4.0",
    "pg": "^8.10.0",
    "natural": "^6.5.0"
  }
}
EOL
done

# Create coordinator function
cat > "$TEMP_DIR/coordinator/index.js" << EOL
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { Pool } = require('pg');

// Initialize clients
const lambda = new LambdaClient();

// Database configuration
const pool = new Pool({
  host: '$RDS_ENDPOINT',
  port: 5432,
  database: '$DB_NAME',
  user: '$DB_USERNAME',
  password: '$DB_PASSWORD',
  ssl: false
});

async function getStockSymbols() {
  const client = await pool.connect();
  try {
    // Get active stock symbols to scrape
    const result = await client.query(
      "SELECT symbol FROM symbols WHERE active = true LIMIT 100"
    );
    
    return result.rows.map(row => row.symbol);
  } catch (error) {
    console.error('Error fetching stock symbols:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function invokeScraperFunction(functionName, payload) {
  try {
    const response = await lambda.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'Event',
        Payload: JSON.stringify(payload),
      })
    );
    
    console.log(\`Successfully invoked \${functionName}\`);
    return response;
  } catch (error) {
    console.error(\`Error invoking \${functionName}:\`, error);
    throw error;
  }
}

exports.handler = async (event) => {
  try {
    console.log('Starting scraper coordination run');
    
    // Get symbols to scrape
    const symbols = await getStockSymbols();
    console.log(\`Found \${symbols.length} symbols to scrape\`);
    
    if (symbols.length === 0) {
      console.log('No symbols to scrape, exiting');
      return { statusCode: 200, body: 'No symbols to scrape' };
    }
    
    // Split symbols into batches of 10
    const symbolBatches = [];
    for (let i = 0; i < symbols.length; i += 10) {
      symbolBatches.push(symbols.slice(i, i + 10));
    }
    
    // Invoke scrapers for each platform
    const scraperFunctions = ['oracle-reddit-scraper', 'oracle-stocktwits-scraper'];
    
    for (const scraperFunction of scraperFunctions) {
      for (const [index, symbolBatch] of symbolBatches.entries()) {
        console.log(\`Invoking \${scraperFunction} for batch \${index + 1} with \${symbolBatch.length} symbols\`);
        
        // Add delay between batches to avoid rate limiting
        const delaySeconds = index * 5;
        
        await invokeScraperFunction(scraperFunction, {
          symbols: symbolBatch,
          delaySeconds,
        });
      }
    }
    
    return {
      statusCode: 200,
      body: \`Successfully initiated scraping for \${symbols.length} symbols\`
    };
  } catch (error) {
    console.error('Error in coordinator:', error);
    
    return {
      statusCode: 500,
      body: 'Error coordinating scrapers: ' + error.message
    };
  }
};
EOL

# Create Reddit scraper function
cat > "$TEMP_DIR/reddit-scraper/index.js" << EOL
const axios = require('axios');
const { Pool } = require('pg');

// Database configuration
const pool = new Pool({
  host: '$RDS_ENDPOINT',
  port: 5432,
  database: '$DB_NAME',
  user: '$DB_USERNAME',
  password: '$DB_PASSWORD',
  ssl: false
});

// ScrapeBee API Key
const scrapeBeeApiKey = '$SCRAPEBEE_API_KEY';

async function scrapeRedditForSymbol(symbol) {
  console.log(\`Scraping Reddit for symbol: \$\${symbol}\`);
  
  try {
    // Use ScrapeBee to scrape Reddit content
    const url = \`https://www.reddit.com/search/?q=%24\${symbol}&sort=new&t=week\`;
    
    const response = await axios({
      method: 'GET',
      url: 'https://app.scrapingbee.com/api/v1/',
      params: {
        api_key: scrapeBeeApiKey,
        url: url,
        premium_proxy: true,
        country_code: 'us',
        wait: 5000,
        render_js: true,
        wait_for: '.Post',
        extract_rules: JSON.stringify({
          posts: {
            selector: '.Post',
            type: 'list',
            output: {
              title: { selector: 'h3', type: 'text' },
              url: { selector: 'a[data-click-id="body"]', type: 'attribute', attribute: 'href' },
              content: { selector: '[data-click-id="text"]', type: 'text' },
              author: { selector: 'a:contains("u/")', type: 'text' },
              subreddit: { selector: 'a:contains("r/")', type: 'text' },
              upvotes: { selector: '[id^="vote-arrows-"] div', type: 'text' },
              time: { selector: 'a[data-click-id="timestamp"] > span', type: 'text' }
            }
          }
        })
      }
    });
    
    const postsData = response.data;
    
    if (!postsData || !postsData.posts || postsData.posts.length === 0) {
      console.log(\`No Reddit posts found for \$\${symbol}\`);
      return [];
    }
    
    return postsData.posts.map(post => ({
      symbol,
      type: 'stock',
      platform: 'reddit',
      url: post.url,
      title: post.title,
      content: post.content || post.title,
      author: post.author?.replace('u/', '') || 'unknown',
      follower_count: null,
      upvotes: parseInt(post.upvotes) || 0,
      source_created_at: new Date(), // TODO: Parse from post.time
      source_id: post.url?.split('/').pop() || null,
      scraped_at: new Date()
    }));
  } catch (error) {
    console.error(\`Error scraping Reddit for \$\${<think>I need to find the last complete line from my previous response and continue from there. The last complete line was:

"  } catch (error) {
    console.error(\`Error scraping Reddit for \$\${" 

I'll continue from there with the Reddit scraper function code.</think>

  } catch (error) {
    console.error(\`Error scraping Reddit for \$\${symbol}:\`, error.message);
    return [];
  }
}

async function saveMentionsToDatabase(mentions) {
  if (mentions.length === 0) {
    return;
  }
  
  const client = await pool.connect();
  
  try {
    for (const mention of mentions) {
      await client.query(
        `INSERT INTO scraped_mentions 
         (symbol, type, platform, url, title, content, author, follower_count, upvotes, source_created_at, source_id, scraped_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (platform, source_id) DO NOTHING`,
        [
          mention.symbol,
          mention.type,
          mention.platform,
          mention.url,
          mention.title,
          mention.content,
          mention.author,
          mention.follower_count,
          mention.upvotes,
          mention.source_created_at,
          mention.source_id,
          mention.scraped_at
        ]
      );
    }
    
    console.log(\`Saved \${mentions.length} mentions to database\`);
  } catch (error) {
    console.error('Error saving mentions to database:', error);
    throw error;
  } finally {
    client.release();
  }
}

exports.handler = async (event) => {
  try {
    console.log('Starting Reddit scraper run');
    
    // Extract symbols and delay if provided
    const symbols = event.symbols || [];
    const delaySeconds = event.delaySeconds || 0;
    
    if (symbols.length === 0) {
      console.log('No symbols provided, exiting');
      return { statusCode: 200, body: 'No symbols provided' };
    }
    
    // If delay is specified, wait
    if (delaySeconds > 0) {
      console.log(\`Waiting \${delaySeconds} seconds before processing...\`);
      await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
    }
    
    // Process each symbol
    let totalMentions = 0;
    
    for (const symbol of symbols) {
      // Add random delay between symbols to avoid rate limiting (1-3 seconds)
      const randomDelay = 1000 + Math.random() * 2000;
      await new Promise(resolve => setTimeout(resolve, randomDelay));
      
      const mentions = await scrapeRedditForSymbol(symbol);
      
      if (mentions.length > 0) {
        await saveMentionsToDatabase(mentions);
        totalMentions += mentions.length;
      }
    }
    
    return {
      statusCode: 200,
      body: \`Successfully scraped Reddit for \${symbols.length} symbols, found \${totalMentions} mentions\`
    };
  } catch (error) {
    console.error('Error in Reddit scraper:', error);
    
    return {
      statusCode: 500,
      body: 'Error in Reddit scraper: ' + error.message
    };
  }
};
EOL

# Create StockTwits scraper function
cat > "$TEMP_DIR/stocktwits-scraper/index.js" << EOL
const axios = require('axios');
const { Pool } = require('pg');

// Database configuration
const pool = new Pool({
  host: '$RDS_ENDPOINT',
  port: 5432,
  database: '$DB_NAME',
  user: '$DB_USERNAME',
  password: '$DB_PASSWORD',
  ssl: false
});

// ScrapeBee API Key
const scrapeBeeApiKey = '$SCRAPEBEE_API_KEY';

async function scrapeStockTwitsForSymbol(symbol) {
  console.log(\`Scraping StockTwits for symbol: \$\${symbol}\`);
  
  try {
    // Use ScrapeBee to scrape StockTwits content
    const url = \`https://stocktwits.com/symbol/\${symbol}\`;
    
    const response = await axios({
      method: 'GET',
      url: 'https://app.scrapingbee.com/api/v1/',
      params: {
        api_key: scrapeBeeApiKey,
        url: url,
        premium_proxy: true,
        country_code: 'us',
        wait: 5000,
        render_js: true,
        wait_for: '.st_3K8jdS2i',
        extract_rules: JSON.stringify({
          posts: {
            selector: '.st_3K8jdS2i',
            type: 'list',
            output: {
              author: { selector: '.st_2qnelBu7', type: 'text' },
              content: { selector: '.st_3iPCMQG0', type: 'text' },
              time: { selector: '.st_3hDWs38D', type: 'text' },
              likes: { selector: '.st_3QemNTAn', type: 'text' }
            }
          }
        })
      }
    });
    
    const postsData = response.data;
    
    if (!postsData || !postsData.posts || postsData.posts.length === 0) {
      console.log(\`No StockTwits posts found for \$\${symbol}\`);
      return [];
    }
    
    return postsData.posts.map((post, index) => ({
      symbol,
      type: 'stock',
      platform: 'stocktwits',
      url: \`https://stocktwits.com/symbol/\${symbol}\`,
      title: \`StockTwits post about \$\${symbol}\`,
      content: post.content || '',
      author: post.author || 'unknown',
      follower_count: null,
      upvotes: parseInt(post.likes) || 0,
      source_created_at: new Date(), // TODO: Parse from post.time
      source_id: \`\${symbol}_\${Date.now()}_\${index}\`,
      scraped_at: new Date()
    }));
  } catch (error) {
    console.error(\`Error scraping StockTwits for \$\${symbol}:\`, error.message);
    return [];
  }
}

async function saveMentionsToDatabase(mentions) {
  if (mentions.length === 0) {
    return;
  }
  
  const client = await pool.connect();
  
  try {
    for (const mention of mentions) {
      await client.query(
        \`INSERT INTO scraped_mentions 
         (symbol, type, platform, url, title, content, author, follower_count, upvotes, source_created_at, source_id, scraped_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (platform, source_id) DO NOTHING\`,
        [
          mention.symbol,
          mention.type,
          mention.platform,
          mention.url,
          mention.title,
          mention.content,
          mention.author,
          mention.follower_count,
          mention.upvotes,
          mention.source_created_at,
          mention.source_id,
          mention.scraped_at
        ]
      );
    }
    
    console.log(\`Saved \${mentions.length} mentions to database\`);
  } catch (error) {
    console.error('Error saving mentions to database:', error);
    throw error;
  } finally {
    client.release();
  }
}

exports.handler = async (event) => {
  try {
    console.log('Starting StockTwits scraper run');
    
    // Extract symbols and delay if provided
    const symbols = event.symbols || [];
    const delaySeconds = event.delaySeconds || 0;
    
    if (symbols.length === 0) {
      console.log('No symbols provided, exiting');
      return { statusCode: 200, body: 'No symbols provided' };
    }
    
    // If delay is specified, wait
    if (delaySeconds > 0) {
      console.log(\`Waiting \${delaySeconds} seconds before processing...\`);
      await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
    }
    
    // Process each symbol
    let totalMentions = 0;
    
    for (const symbol of symbols) {
      // Add random delay between symbols to avoid rate limiting (1-3 seconds)
      const randomDelay = 1000 + Math.random() * 2000;
      await new Promise(resolve => setTimeout(resolve, randomDelay));
      
      const mentions = await scrapeStockTwitsForSymbol(symbol);
      
      if (mentions.length > 0) {
        await saveMentionsToDatabase(mentions);
        totalMentions += mentions.length;
      }
    }
    
    return {
      statusCode: 200,
      body: \`Successfully scraped StockTwits for \${symbols.length} symbols, found \${totalMentions} mentions\`
    };
  } catch (error) {
    console.error('Error in StockTwits scraper:', error);
    
    return {
      statusCode: 500,
      body: 'Error in StockTwits scraper: ' + error.message
    };
  }
};
EOL

# ---------------------------------------------------------------------
# PART 4: Install Dependencies and Create ZIP Files
# ---------------------------------------------------------------------
echo -e "${YELLOW}STEP 4: Installing dependencies and creating ZIP files${NC}"

# Create a directory for ZIP files
ZIP_DIR="$HOME/lambda_zips"
mkdir -p "$ZIP_DIR"

# Install dependencies and create ZIP files for each function
for FUNC_DIR in "coordinator" "reddit-scraper" "stocktwits-scraper"; do
  echo "Processing $FUNC_DIR..."
  
  # Navigate to function directory
  cd "$TEMP_DIR/$FUNC_DIR"
  
  # Install dependencies
  npm install --production
  
  # Create ZIP file
  zip -r "$ZIP_DIR/$FUNC_DIR.zip" .
  
  echo -e "${GREEN}✓ Created $FUNC_DIR.zip${NC}"
done

# ---------------------------------------------------------------------
# PART 5: Create Lambda Functions
# ---------------------------------------------------------------------
echo -e "${YELLOW}STEP 5: Creating Lambda functions${NC}"

# Create coordinator function
aws lambda create-function \
  --function-name oracle-coordinator \
  --runtime nodejs18.x \
  --role "$LAMBDA_ROLE_ARN" \
  --handler index.handler \
  --timeout 300 \
  --memory-size 256 \
  --zip-file fileb://"$ZIP_DIR/coordinator.zip"

echo -e "${GREEN}✓ Created oracle-coordinator Lambda function${NC}"

# Create Reddit scraper function
aws lambda create-function \
  --function-name oracle-reddit-scraper \
  --runtime nodejs18.x \
  --role "$LAMBDA_ROLE_ARN" \
  --handler index.handler \
  --timeout 300 \
  --memory-size 512 \
  --zip-file fileb://"$ZIP_DIR/reddit-scraper.zip"

echo -e "${GREEN}✓ Created oracle-reddit-scraper Lambda function${NC}"

# Create StockTwits scraper function
aws lambda create-function \
  --function-name oracle-stocktwits-scraper \
  --runtime nodejs18.x \
  --role "$LAMBDA_ROLE_ARN" \
  --handler index.handler \
  --timeout 300 \
  --memory-size 512 \
  --zip-file fileb://"$ZIP_DIR/stocktwits-scraper.zip"

echo -e "${GREEN}✓ Created oracle-stocktwits-scraper Lambda function${NC}"

# ---------------------------------------------------------------------
# PART 6: Create EventBridge Rule for Scheduling
# ---------------------------------------------------------------------
echo -e "${YELLOW}STEP 6: Creating EventBridge rule for scheduling${NC}"

# Create EventBridge rule to run coordinator every 4 hours
aws events put-rule \
  --name oracle-scraper-schedule \
  --schedule-expression "rate(4 hours)" \
  --state ENABLED

# Add permission for EventBridge to invoke Lambda
aws lambda add-permission \
  --function-name oracle-coordinator \
  --statement-id oracle-eventbridge-permission \
  --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn $(aws events describe-rule --name oracle-scraper-schedule --query 'Arn' --output text)

# Create target for the rule
aws events put-targets \
  --rule oracle-scraper-schedule \
  --targets '[{"Id": "1", "Arn": "'"$(aws lambda get-function --function-name oracle-coordinator --query 'Configuration.FunctionArn' --output text)"'"}]'

echo -e "${GREEN}✓ Created EventBridge rule to run scraper every 4 hours${NC}\n"

# ---------------------------------------------------------------------
# PART 7: Summary
# ---------------------------------------------------------------------
echo -e "\n${BLUE}==================================================${NC}"
echo -e "${BLUE}             Lambda Setup Complete!                ${NC}"
echo -e "${BLUE}==================================================${NC}\n"

echo -e "${GREEN}Lambda Functions:${NC}"
echo " - oracle-coordinator: Coordinates scraping tasks"
echo " - oracle-reddit-scraper: Scrapes Reddit for stock mentions"
echo " - oracle-stocktwits-scraper: Scrapes StockTwits for stock mentions"

echo -e "\n${YELLOW}Next Steps:${NC}"
echo " 1. Test the Lambda functions by manually invoking the coordinator"
echo " 2. Check the RDS database for scraped data"
echo " 3. Monitor CloudWatch logs for any errors"

echo -e "\n${GREEN}Setup completed successfully!${NC}"