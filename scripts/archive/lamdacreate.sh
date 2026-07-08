#!/bin/bash
set -e

# =====================================================================
# AWS Lambda Scraper Service Setup Script for Oracle Investment Screener
# =====================================================================

# Color codes for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Print a formatted header
echo -e "${BLUE}==================================================${NC}"
echo -e "${BLUE}     Oracle Investment Screener - AWS Setup       ${NC}"
echo -e "${BLUE}==================================================${NC}\n"

# ---------------------------------------------------------------------
# PART 1: AWS Authentication and Configuration
# ---------------------------------------------------------------------
echo -e "${YELLOW}STEP 1: AWS Authentication${NC}"

# Check for AWS CLI installation
if ! command -v aws &> /dev/null; then
    echo -e "${RED}AWS CLI is not installed. Please install it first:${NC}"
    echo "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
    exit 1
fi

# Check AWS credentials
if ! aws sts get-caller-identity &> /dev/null; then
    echo -e "${RED}AWS credentials not configured or invalid.${NC}"
    echo "Please run 'aws configure' first to set up your credentials."
    exit 1
fi

# Get AWS account details
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
AWS_REGION=$(aws configure get region)
if [ -z "$AWS_REGION" ]; then
    echo -e "${YELLOW}AWS region not set. Using us-east-1 as default.${NC}"
    AWS_REGION="us-east-1"
fi

echo -e "${GREEN}✓ Authenticated with AWS Account: ${AWS_ACCOUNT_ID} in region: ${AWS_REGION}${NC}\n"

# ---------------------------------------------------------------------
# PART 2: Configuration Variables
# ---------------------------------------------------------------------
echo -e "${YELLOW}STEP 2: Setting up configuration variables${NC}"

# Get database connection details
read -p "Enter your RDS database endpoint (e.g., mydb.xyz.region.rds.amazonaws.com): " DB_ENDPOINT
read -p "Enter your RDS database name (default: oracle): " DB_NAME
DB_NAME=${DB_NAME:-oracle}
read -p "Enter your RDS database username: " DB_USERNAME
read -sp "Enter your RDS database password: " DB_PASSWORD
echo ""

# Get ScrapeBee API key from user's .env file
BACKEND_ENV_PATH="/Users/tcast/Documents/Sites/oracle/backend/.env"
if [ -f "$BACKEND_ENV_PATH" ]; then
    SCRAPEBEE_API_KEY=$(grep SCRAPEBEE_API_KEY "$BACKEND_ENV_PATH" | cut -d '=' -f2)
    echo -e "${GREEN}✓ Found ScrapeBee API key in .env file${NC}"
else
    read -p "Enter your ScrapeBee API key: " SCRAPEBEE_API_KEY
fi

# Confirm VPC settings
echo -e "\n${YELLOW}Setting up VPC configuration:${NC}"
read -p "Do you want to create a new VPC? (y/n, default: n): " CREATE_VPC
CREATE_VPC=${CREATE_VPC:-n}

if [[ $CREATE_VPC == "y" || $CREATE_VPC == "Y" ]]; then
    echo "Creating new VPC for Lambda functions..."
    
    # Create VPC
    VPC_ID=$(aws ec2 create-vpc --cidr-block 10.0.0.0/16 \
        --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=oracle-lambda-vpc}]' \
        --query 'Vpc.VpcId' --output text)
    
    # Create internet gateway and attach to VPC
    IGW_ID=$(aws ec2 create-internet-gateway \
        --tag-specifications 'ResourceType=internet-gateway,Tags=[{Key=Name,Value=oracle-lambda-igw}]' \
        --query 'InternetGateway.InternetGatewayId' --output text)
    aws ec2 attach-internet-gateway --vpc-id $VPC_ID --internet-gateway-id $IGW_ID
    
    # Get availability zones in the region
    AZ1="${AWS_REGION}a"
    AZ2="${AWS_REGION}b"
    
    # Create subnets
    SUBNET_ID1=$(aws ec2 create-subnet --vpc-id $VPC_ID --cidr-block 10.0.1.0/24 \
        --availability-zone $AZ1 \
        --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=oracle-lambda-subnet-1}]' \
        --query 'Subnet.SubnetId' --output text)
    
    SUBNET_ID2=$(aws ec2 create-subnet --vpc-id $VPC_ID --cidr-block 10.0.2.0/24 \
        --availability-zone $AZ2 \
        --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=oracle-lambda-subnet-2}]' \
        --query 'Subnet.SubnetId' --output text)
    
    # Create route table
    ROUTE_TABLE_ID=$(aws ec2 create-route-table --vpc-id $VPC_ID \
        --tag-specifications 'ResourceType=route-table,Tags=[{Key=Name,Value=oracle-lambda-rt}]' \
        --query 'RouteTable.RouteTableId' --output text)
    
    # Create route to internet gateway
    aws ec2 create-route --route-table-id $ROUTE_TABLE_ID --destination-cidr-block 0.0.0.0/0 \
        --gateway-id $IGW_ID > /dev/null
    
    # Associate route table with subnets
    aws ec2 associate-route-table --subnet-id $SUBNET_ID1 --route-table-id $ROUTE_TABLE_ID > /dev/null
    aws ec2 associate-route-table --subnet-id $SUBNET_ID2 --route-table-id $ROUTE_TABLE_ID > /dev/null
    
    # Create security group
    SECURITY_GROUP_ID=$(aws ec2 create-security-group --group-name oracle-lambda-sg \
        --description "Security group for Oracle Lambda functions" --vpc-id $VPC_ID \
        --query 'GroupId' --output text)
    
    # Add security group rules
    aws ec2 authorize-security-group-egress --group-id $SECURITY_GROUP_ID \
        --protocol all --cidr 0.0.0.0/0 > /dev/null
    
    # Create NAT gateway for private subnets
    EIP_ALLOCATION_ID=$(aws ec2 allocate-address --domain vpc --query 'AllocationId' --output text)
    NAT_GW_ID=$(aws ec2 create-nat-gateway --subnet-id $SUBNET_ID1 \
        --allocation-id $EIP_ALLOCATION_ID \
        --tag-specifications 'ResourceType=natgateway,Tags=[{Key=Name,Value=oracle-lambda-nat}]' \
        --query 'NatGateway.NatGatewayId' --output text)
    
    echo -e "${GREEN}✓ VPC created: $VPC_ID${NC}"
    echo -e "${GREEN}✓ Subnets created: $SUBNET_ID1, $SUBNET_ID2${NC}"
    echo -e "${GREEN}✓ Security Group created: $SECURITY_GROUP_ID${NC}"
    
    # Wait for NAT Gateway to become available
    echo "Waiting for NAT Gateway to become available..."
    aws ec2 wait nat-gateway-available --nat-gateway-ids $NAT_GW_ID
    
else
    # List available VPCs and have user select one
    echo "Listing available VPCs..."
    aws ec2 describe-vpcs --query 'Vpcs[*].[VpcId,Tags[?Key==`Name`].Value|[0]]' --output table
    
    read -p "Enter the VPC ID to use: " VPC_ID
    
    # List available subnets in the selected VPC
    echo "Listing subnets in VPC $VPC_ID..."
    aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" \
        --query 'Subnets[*].[SubnetId,AvailabilityZone,CidrBlock,Tags[?Key==`Name`].Value|[0]]' --output table
    
    read -p "Enter the first subnet ID: " SUBNET_ID1
    read -p "Enter the second subnet ID: " SUBNET_ID2
    
    # List security groups
    echo "Listing security groups in VPC $VPC_ID..."
    aws ec2 describe-security-groups --filters "Name=vpc-id,Values=$VPC_ID" \
        --query 'SecurityGroups[*].[GroupId,GroupName]' --output table
    
    read -p "Enter the security group ID: " SECURITY_GROUP_ID
fi

echo -e "${GREEN}✓ VPC configuration complete${NC}\n"

# ---------------------------------------------------------------------
# PART 3: Create IAM Roles and Policies
# ---------------------------------------------------------------------
echo -e "${YELLOW}STEP 3: Creating IAM roles and policies${NC}"

# Create IAM policy for Lambda execution
LAMBDA_POLICY_ARN=$(aws iam create-policy --policy-name OracleLambdaScraperPolicy --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents"
            ],
            "Resource": "arn:aws:logs:*:*:*"
        },
        {
            "Effect": "Allow",
            "Action": [
                "ec2:CreateNetworkInterface",
                "ec2:DescribeNetworkInterfaces",
                "ec2:DeleteNetworkInterface"
            ],
            "Resource": "*"
        },
        {
            "Effect": "Allow",
            "Action": [
                "sns:Publish"
            ],
            "Resource": "arn:aws:sns:*:*:oracle-scraper-alerts"
        },
        {
            "Effect": "Allow",
            "Action": [
                "lambda:InvokeFunction"
            ],
            "Resource": [
                "arn:aws:lambda:*:*:function:scraper-coordinator",
                "arn:aws:lambda:*:*:function:scraper-reddit",
                "arn:aws:lambda:*:*:function:scraper-stocktwits",
                "arn:aws:lambda:*:*:function:sentiment-analyzer"
            ]
        }
    ]
}' --query 'Policy.Arn' --output text)

echo -e "${GREEN}✓ Created IAM policy: $LAMBDA_POLICY_ARN${NC}"

# Create IAM role for Lambda
LAMBDA_ROLE_ARN=$(aws iam create-role --role-name OracleLambdaScraperRole \
    --assume-role-policy-document '{
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
    }' --query 'Role.Arn' --output text)

# Attach the policy to the role
aws iam attach-role-policy --role-name OracleLambdaScraperRole \
    --policy-arn $LAMBDA_POLICY_ARN

# Attach AWS managed policies for Lambda
aws iam attach-role-policy --role-name OracleLambdaScraperRole \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole

echo -e "${GREEN}✓ Created IAM role: $LAMBDA_ROLE_ARN${NC}\n"

# Allow time for IAM role to propagate
echo "Waiting for IAM role to propagate..."
sleep 10

# ---------------------------------------------------------------------
# PART 4: Create Secret for Database Credentials
# ---------------------------------------------------------------------
echo -e "${YELLOW}STEP 4: Creating database credentials secret${NC}"

# Create a secret for the RDS database credentials
DB_SECRET_ARN=$(aws secretsmanager create-secret \
    --name "oracle-db-credentials" \
    --description "RDS database credentials for Oracle Investment Screener" \
    --secret-string "{\"username\":\"$DB_USERNAME\",\"password\":\"$DB_PASSWORD\",\"engine\":\"postgres\",\"host\":\"$DB_ENDPOINT\",\"port\":5432,\"dbname\":\"$DB_NAME\"}" \
    --query 'ARN' --output text)

echo -e "${GREEN}✓ Created database secret: $DB_SECRET_ARN${NC}\n"

# ---------------------------------------------------------------------
# PART 5: Create SNS Topic for Notifications
# ---------------------------------------------------------------------
echo -e "${YELLOW}STEP 5: Creating SNS topic for notifications${NC}"

# Create SNS topic
SNS_TOPIC_ARN=$(aws sns create-topic --name oracle-scraper-alerts --query 'TopicArn' --output text)

read -p "Enter your email for scraper notifications: " NOTIFICATION_EMAIL

# Subscribe email to the topic
SUBSCRIPTION_ARN=$(aws sns subscribe \
    --topic-arn $SNS_TOPIC_ARN \
    --protocol email \
    --notification-endpoint $NOTIFICATION_EMAIL \
    --query 'SubscriptionArn' --output text)

echo -e "${GREEN}✓ Created SNS topic: $SNS_TOPIC_ARN${NC}"
echo -e "${GREEN}✓ Subscribed email $NOTIFICATION_EMAIL to notifications${NC}"
echo -e "${YELLOW}Please check your email and confirm the subscription${NC}\n"

# ---------------------------------------------------------------------
# PART 6: Create Lambda Functions Code
# ---------------------------------------------------------------------
echo -e "${YELLOW}STEP 6: Creating Lambda function code${NC}"

# Create a temporary directory for Lambda code
TEMP_DIR=$(mktemp -d)
echo "Using temporary directory: $TEMP_DIR"

# Create coordinator function
mkdir -p "$TEMP_DIR/scraper-coordinator"
cat > "$TEMP_DIR/scraper-coordinator/index.js" << 'EOL'
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const pg = require('pg');

// Initialize clients
const lambda = new LambdaClient();
const sns = new SNSClient();
const secretsManager = new SecretsManagerClient();

// Environment variables
const secretName = process.env.DB_SECRET_NAME;
const snsTopic = process.env.SNS_TOPIC_ARN;

async function getDBCredentials() {
  try {
    const response = await secretsManager.send(
      new GetSecretValueCommand({
        SecretId: secretName,
      })
    );
    return JSON.parse(response.SecretString);
  } catch (error) {
    console.error('Error retrieving database credentials:', error);
    throw error;
  }
}

async function getStockSymbols() {
  const credentials = await getDBCredentials();
  
  const client = new pg.Client({
    host: credentials.host,
    port: credentials.port,
    database: credentials.dbname,
    user: credentials.username,
    password: credentials.password,
  });
  
  try {
    await client.connect();
    
    // Get active stock symbols to scrape
    const result = await client.query(
      "SELECT symbol FROM symbols WHERE active = true LIMIT 100"
    );
    
    return result.rows.map(row => row.symbol);
  } catch (error) {
    console.error('Error fetching stock symbols:', error);
    throw error;
  } finally {
    await client.end();
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
    
    console.log(`Successfully invoked ${functionName}`);
    return response;
  } catch (error) {
    console.error(`Error invoking ${functionName}:`, error);
    
    // Send notification about failure
    await sns.send(
      new PublishCommand({
        TopicArn: snsTopic,
        Subject: `Oracle Scraper Error: ${functionName}`,
        Message: `Failed to invoke ${functionName}: ${error.message}`,
      })
    );
    
    throw error;
  }
}

exports.handler = async (event) => {
  try {
    console.log('Starting scraper coordination run');
    
    // Get symbols to scrape
    const symbols = await getStockSymbols();
    console.log(`Found ${symbols.length} symbols to scrape`);
    
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
    const scraperFunctions = ['scraper-reddit', 'scraper-stocktwits'];
    
    for (const scraperFunction of scraperFunctions) {
      for (const [index, symbolBatch] of symbolBatches.entries()) {
        console.log(`Invoking ${scraperFunction} for batch ${index + 1} with ${symbolBatch.length} symbols`);
        
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
      body: `Successfully initiated scraping for ${symbols.length} symbols`
    };
  } catch (error) {
    console.error('Error in coordinator:', error);
    
    // Send notification about critical failure
    await sns.send(
      new PublishCommand({
        TopicArn: snsTopic,
        Subject: 'Oracle Scraper Critical Error',
        Message: `Critical error in scraper coordinator: ${error.message}`,
      })
    );
    
    return {
      statusCode: 500,
      body: 'Error coordinating scrapers: ' + error.message
    };
  }
};
EOL

# Create package.json for coordinator
cat > "$TEMP_DIR/scraper-coordinator/package.json" << 'EOL'
{
  "name": "scraper-coordinator",
  "version": "1.0.0",
  "description": "Coordinator for Oracle Investment Screener scrapers",
  "main": "index.js",
  "dependencies": {
    "@aws-sdk/client-lambda": "^3.350.0",
    "@aws-sdk/client-secrets-manager": "^3.350.0",
    "@aws-sdk/client-sns": "^3.350.0",
    "pg": "^8.10.0"
  }
}
EOL

# Create Reddit scraper function
mkdir -p "$TEMP_DIR/scraper-reddit"
cat > "$TEMP_DIR/scraper-reddit/index.js" << 'EOL'
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const axios = require('axios');
const pg = require('pg');

// Initialize clients
const sns = new SNSClient();
const secretsManager = new SecretsManagerClient();

// Environment variables
const secretName = process.env.DB_SECRET_NAME;
const snsTopic = process.env.SNS_TOPIC_ARN;
const scrapeBeeApiKey = process.env.SCRAPEBEE_API_KEY;

async function getDBCredentials() {
  try {
    const response = await secretsManager.send(
      new GetSecretValueCommand({
        SecretId: secretName,
      })
    );
    return JSON.parse(response.SecretString);
  } catch (error) {
    console.error('Error retrieving database credentials:', error);
    throw error;
  }
}

async function scrapeRedditForSymbol(symbol) {
  console.log(`Scraping Reddit for symbol: $${symbol}`);
  
  try {
    // Use ScrapeBee to scrape Reddit content
    const url = `https://www.reddit.com/search/?q=%24${symbol}&sort=new&t=week`;
    
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
      console.log(`No Reddit posts found for $${symbol}`);
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
    console.error(`Error scraping Reddit for $${symbol}:`, error.message);
    
    // Send notification about scraping error
    await sns.send(
      new PublishCommand({
        TopicArn: snsTopic,
        Subject: `Reddit Scraper Error for $${symbol}`,
        Message: `Failed to scrape Reddit for $${symbol}: ${error.message}`,
      })
    );
    
    return [];
  }
}

async function saveMentionsToDatabase(mentions) {
  if (mentions.length === 0) {
    return;
  }
  
  const credentials = await getDBCredentials();
  
  const client = new pg.Client({
    host: credentials.host,
    port: credentials.port,
    database: credentials.dbname,
    user: credentials.username,
    password: credentials.password,
  });
  
  try {
    await client.connect();
    
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
    
    console.log(`Saved ${mentions.length} mentions to database`);
  } catch (error) {
    console.error('Error saving mentions to database:', error);
    throw error;
  } finally {
    await client.end();
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
      console.log(`Waiting ${delaySeconds} seconds before processing...`);
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
      body: `Successfully scraped Reddit for ${symbols.length} symbols, found ${totalMentions} mentions`
    };
  } catch (error) {
    console.error('Error in Reddit scraper:', error);
    
    // Send notification about critical failure
    await sns.send(
      new PublishCommand({
        TopicArn: snsTopic,
        Subject: 'Reddit Scraper Critical Error',
        Message: `Critical error in Reddit scraper: ${error.message}`,
      })
    );
    
    return {
      statusCode: 500,
      body: 'Error in Reddit scraper: ' + error.message
    };
  }
};
EOL

# Create package.json for Reddit scraper
cat > "$TEMP_DIR/scraper-reddit/package.json" << 'EOL'
{
  "name": "scraper-reddit",
  "version": "1.0.0",
  "description": "Reddit scraper for Oracle Investment Screener",
  "main": "index.js",
  "dependencies": {
    "@aws-sdk/client-secrets-manager": "^3.350.0",
    "@aws-sdk/client-sns": "^3.350.0",
    "axios": "^1.4.0",
    "pg": "^8.10.0"
  }
}
EOL

# Create StockTwits scraper function
mkdir -p "$TEMP_DIR/scraper-stocktwits"
cat > "$TEMP_DIR/scraper-stocktwits/index.js" << 'EOL'
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const axios = require('axios');
const pg = require('pg');

// Initialize clients
const sns = new SNSClient();
const secretsManager = new SecretsManagerClient();

// Environment variables
const secretName = process.env.DB_SECRET_NAME;
const snsTopic = process.env.SNS_TOPIC_ARN;
const scrapeBeeApiKey = process.env.SCRAPEBEE_API_KEY;

async function getDBCredentials() {
  try {
    const response = await secretsManager.send(
      new GetSecretValueCommand({
        SecretId: secretName,
      })
    );
    return JSON.parse(response.SecretString);
  } catch (error) {
    console.error('Error retrieving database credentials:', error);
    throw error;
  }
}

async function scrapeStockTwitsForSymbol(symbol) {
  console.log(`Scraping StockTwits for symbol: $${symbol}`);
  
  try {
    // Use ScrapeBee to scrape StockTwits content
    const url = `https://stocktwits.com/symbol/${symbol}`;
    
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
      console.log(`No StockTwits posts found for $${symbol}`);
      return [];
    }
    
    return postsData.posts.map((post, index) => ({
      symbol,
      type: 'stock',
      platform: 'stocktwits',
      url: `https://stocktwits.com/symbol/${symbol}`,
      title: `StockTwits post about $${symbol}`,
      content: post.content || '',
      author: post.author || 'unknown',
      follower_count: null,
      upvotes: parseInt(post.likes) || 0,
      source_created_at: new Date(), // TODO: Parse from post.time
      source_id: `${symbol}_${Date.now()}_${index}`,
      scraped_at: new Date()
    }));
  } catch (error) {
    console.error(`Error scraping StockTwits for $${symbol}:`, error.message);
    
    // Send notification about scraping error
    await sns.send(
      new PublishCommand({
        TopicArn: snsTopic,
        Subject: `StockTwits Scraper Error for $${symbol}`,
        Message: `Failed to scrape StockTwits for $${symbol}: ${error.message}`,
      })
    );
    
    return [];
  }
}

async function saveMentionsToDatabase(mentions) {
  if (mentions.length === 0) {
    return;
  }
  
  const credentials = await getDBCredentials();
  
  const client = new pg.Client({
    host: credentials.host,
    port: credentials.port,
    database: credentials.dbname,
    user: credentials.username,
    password: credentials.password,
  });
  
  try {
    await client.connect();
    
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
    
    console.log(`Saved ${mentions.length} mentions to database`);
  } catch (error) {
    console.error('Error saving mentions to database:', error);
    throw error;
  } finally {
    await client.end();
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
      console.log(`Waiting ${delaySeconds} seconds before processing...`);
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
      body: `Successfully scraped StockTwits for ${symbols.length} symbols, found ${totalMentions} mentions`
    };
  } catch (error) {
    console.error('Error in StockTwits scraper:', error);
    
    // Send notification about critical failure
    await sns.send(
      new PublishCommand({
        TopicArn: snsTopic,
        Subject: 'StockTwits Scraper Critical Error',
        Message: `Critical error in StockTwits scraper: ${error.message}`,
      })
    );
    
    return {
      statusCode: 500,
      body: 'Error in StockTwits scraper: ' + error.message
    };
  }
};
EOL

# Create package.json for StockTwits scraper
cat > "$TEMP_DIR/scraper-stocktwits/package.json" << 'EOL'
{
  "name": "scraper-stocktwits",
  "version": "1.0.0",
  "description": "StockTwits scraper for Oracle Investment Screener",
  "main": "index.js",
  "dependencies": {
    "@aws-sdk/client-secrets-manager": "^3.350.0",
    "@aws-sdk/client-sns": "^3.350.0",
    "axios": "^1.4.0",
    "pg": "^8.10.0"
  }
}
EOL

# Create sentiment analyzer function
mkdir -p "$TEMP_DIR/sentiment-analyzer"
cat > "$TEMP_DIR/sentiment-analyzer/index.js" << 'EOL'
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const pg = require('pg');
const natural = require('natural');
const { SentimentAnalyzer, PorterStemmer } = natural;

// Initialize clients
const sns = new SNSClient();
const secretsManager = new SecretsManagerClient();

// Initialize sentiment analyzer
const analyzer = new SentimentAnalyzer('English', PorterStemmer, 'afinn');

// Environment variables
const secretName = process.env.DB_SECRET_NAME;
const snsTopic = process.env.SNS_TOPIC_ARN;

async function getDBCredentials() {
  try {
    const response = await secretsManager.send(
      new GetSecretValueCommand({
        SecretId: secretName,
      })
    );
    return JSON.parse(response.SecretString);
  } catch (error) {
    console.error('Error retrieving database credentials:', error);
    throw error;
  }
}

function analyzeSentiment(text) {
  if (!text || text.length < 5) return 0;
  
  // Tokenize and analyze
  const tokens = text.split(' ').map(token => 
    token.toLowerCase().replace(/[^a-z0-9]/g, '')
  ).filter(token => token.length > 2);
  
  if (tokens.length === 0) return 0;
  
  const sentiment = analyzer.getSentiment(tokens);
  
  // Scale to range -10 to 10
  return Math.max(-10, Math.min(10, sentiment * 5));
}