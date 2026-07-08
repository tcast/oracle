let AWS;
try {
  AWS = require('aws-sdk');
} catch (error) {
  console.warn('❌ aws-sdk package not found. Lambda services will be disabled.');
  console.warn('   To enable Lambda services, install the aws-sdk package:');
  console.warn('   npm install aws-sdk@2.1361.0 --save');
  // Create a dummy AWS object to prevent further errors
  AWS = {
    config: {
      update: () => {}
    },
    Lambda: class DummyLambda {
      constructor() {}
    },
    CloudWatch: class DummyCloudWatch {
      constructor() {}
    }
  };
}

const pool = require('./db');

class LambdaService {
  constructor() {
    this.isAwsConfigured = false;
    this.isAwsSdkInstalled = !!AWS.Lambda?.prototype?.getFunction;
    
    try {
      // First, check if AWS SDK is properly installed
      if (!this.isAwsSdkInstalled) {
        console.log('⚠️ AWS SDK not installed. Lambda service will be disabled.');
        return;
      }
      
      // Then check if AWS credentials are available
      if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
        // Configure AWS SDK
        AWS.config.update({
          region: process.env.AWS_REGION || 'us-east-1',
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        });
        
        this.lambda = new AWS.Lambda();
        this.isAwsConfigured = true;
        console.log('✅ AWS SDK configured for Lambda service');
      } else {
        console.log('⚠️ AWS credentials not found. Lambda service will operate in limited mode.');
      }
    } catch (error) {
      console.error('❌ Error configuring AWS SDK:', error.message);
    }
  }

  /**
   * Check if a Lambda function exists and when it was last invoked
   * @param {string} functionName - The name of the Lambda function
   * @returns {Promise<Object>} - Status information about the Lambda function
   */
  async checkLambdaStatus(functionName) {
    if (!this.isAwsSdkInstalled) {
      return {
        exists: false,
        name: functionName,
        error: 'AWS SDK not installed',
        configurationRequired: true,
        installRequired: true
      };
    }
    
    if (!this.isAwsConfigured) {
      return {
        exists: false,
        name: functionName,
        error: 'AWS credentials not configured',
        configurationRequired: true
      };
    }
    
    try {
      // Get function info to check if it exists
      const functionInfo = await this.lambda.getFunction({
        FunctionName: functionName
      }).promise();

      // Get metrics to check when the function was last invoked
      const startTime = new Date();
      startTime.setHours(startTime.getHours() - 24); // Last 24 hours

      const cloudwatch = new AWS.CloudWatch();
      const metrics = await cloudwatch.getMetricStatistics({
        Namespace: 'AWS/Lambda',
        MetricName: 'Invocations',
        Dimensions: [
          {
            Name: 'FunctionName',
            Value: functionName
          }
        ],
        StartTime: startTime,
        EndTime: new Date(),
        Period: 3600, // 1 hour periods
        Statistics: ['Sum']
      }).promise();

      const lastInvoked = metrics.Datapoints.length > 0 
        ? new Date(Math.max(...metrics.Datapoints.map(d => d.Timestamp)))
        : null;

      return {
        exists: true,
        name: functionName,
        runtime: functionInfo.Configuration.Runtime,
        lastModified: functionInfo.Configuration.LastModified,
        lastInvoked: lastInvoked ? lastInvoked.toISOString() : 'Never or not in the last 24 hours',
        active: lastInvoked ? true : false
      };
    } catch (error) {
      console.error(`Error checking Lambda function ${functionName}:`, error);
      if (error.code === 'ResourceNotFoundException') {
        return {
          exists: false,
          name: functionName,
          error: 'Function does not exist'
        };
      }
      return {
        exists: false,
        name: functionName,
        error: error.message
      };
    }
  }

  /**
   * Check the RDS database for recent scraped entries
   * @param {number} hours - Number of hours to look back
   * @returns {Promise<Object>} - Status information about scraped data
   */
  async checkScrapedDataStatus(hours = 24) {
    try {
      const query = `
        SELECT 
          platform, 
          COUNT(*) as count, 
          MAX(scraped_at) as latest_scrape 
        FROM 
          scraped_mentions 
        WHERE 
          scraped_at > NOW() - INTERVAL '${hours} hours'
        GROUP BY 
          platform
      `;

      const result = await pool.query(query);

      if (result.rows.length === 0) {
        return {
          active: false,
          message: `No data scraped in the last ${hours} hours`,
          platforms: []
        };
      }

      return {
        active: true,
        message: `Data has been scraped in the last ${hours} hours`,
        platforms: result.rows.map(row => ({
          name: row.platform,
          count: parseInt(row.count),
          latest_scrape: row.latest_scrape
        }))
      };
    } catch (error) {
      console.error('Error checking scraped data status:', error);
      return {
        active: false,
        error: error.message
      };
    }
  }

  /**
   * Get historical scraping statistics - works without AWS SDK
   * @param {number} days - Number of days to analyze
   * @returns {Promise<Object>} - Scraping statistics
   */
  async getScrapingStats(days = 7) {
    try {
      const query = `
        SELECT 
          DATE_TRUNC('day', scraped_at) as day,
          platform,
          COUNT(*) as count
        FROM 
          scraped_mentions 
        WHERE 
          scraped_at > NOW() - INTERVAL '${days} days'
        GROUP BY 
          DATE_TRUNC('day', scraped_at), platform
        ORDER BY 
          day DESC, count DESC
      `;

      const result = await pool.query(query);
      
      // Format the data for the frontend
      const dayMap = {};
      
      result.rows.forEach(row => {
        const day = new Date(row.day).toISOString().split('T')[0];
        if (!dayMap[day]) {
          dayMap[day] = {};
        }
        dayMap[day][row.platform] = parseInt(row.count);
      });
      
      // Convert to array format
      const stats = Object.entries(dayMap).map(([day, platforms]) => ({
        day,
        ...platforms,
        total: Object.values(platforms).reduce((sum, count) => sum + count, 0)
      }));
      
      return stats;
    } catch (error) {
      console.error('Error getting scraping stats:', error);
      return [];
    }
  }

  /**
   * Check all Oracle Lambda scraper functions
   * @returns {Promise<Object>} - Status information for all Lambda functions
   */
  async checkAllScraperFunctions() {
    try {
      const functionNames = [
        'oracle-coordinator',
        'oracle-reddit-scraper',
        'oracle-stocktwits-scraper'
      ];

      if (!this.isAwsSdkInstalled) {
        // Get scraping statistics from the database even without AWS SDK
        const scrapedDataStatus = await this.checkScrapedDataStatus(24);
        const scrapingStats = await this.getScrapingStats(7);
        
        // Estimate Lambda status based on recent scraping activity
        const lambdaFunctions = functionNames.map(name => {
          // Extract platform from function name
          const platform = name.includes('reddit') ? 'reddit' : 
                           name.includes('stocktwits') ? 'stocktwits' : 
                           'coordinator';
                           
          // Check if we have data for this platform
          const hasRecentData = scrapedDataStatus.platforms.some(p => 
            p.name.toLowerCase().includes(platform) && 
            new Date(p.latest_scrape) > new Date(Date.now() - 24 * 60 * 60 * 1000)
          );
          
          return {
            exists: true, // Assume it exists
            name,
            error: 'AWS SDK not installed',
            estimatedActive: hasRecentData,
            estimatedLastInvoked: hasRecentData ? 'Within last 24 hours (estimated)' : 'Unknown',
            configurationRequired: true,
            installRequired: true
          };
        });
        
        return {
          lambdaFunctions,
          scrapedData: scrapedDataStatus,
          scrapingStats,
          status: scrapedDataStatus.active ? 'data_available' : 'inactive',
          message: 'Lambda status estimated from database activity',
          timestamp: new Date().toISOString(),
          usingFallback: true
        };
      }

      if (!this.isAwsConfigured) {
        // Return a friendly message when AWS is not configured
        return {
          lambdaFunctions: functionNames.map(name => ({
            exists: false,
            name,
            error: 'AWS credentials not configured',
            configurationRequired: true
          })),
          scrapedData: await this.checkScrapedDataStatus(24),
          status: 'configuration_required',
          message: 'AWS credentials need to be configured to check Lambda functions',
          timestamp: new Date().toISOString()
        };
      }

      const lambdaStatuses = await Promise.all(
        functionNames.map(name => this.checkLambdaStatus(name))
      );

      const scrapedDataStatus = await this.checkScrapedDataStatus(24);
      const scrapingStats = await this.getScrapingStats(7);

      return {
        lambdaFunctions: lambdaStatuses,
        scrapedData: scrapedDataStatus,
        scrapingStats,
        status: scrapedDataStatus.active ? 'healthy' : 'inactive',
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error checking Lambda scraper status:', error);
      return {
        error: error.message,
        status: 'error',
        timestamp: new Date().toISOString()
      };
    }
  }
}

module.exports = new LambdaService();