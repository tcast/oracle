const { CloudWatchLogsClient, DescribeLogStreamsCommand, GetLogEventsCommand } = require('@aws-sdk/client-cloudwatch-logs');

// Initialize CloudWatch Logs client
const logsClient = new CloudWatchLogsClient();

// Function to get the most recent log stream for a log group
async function getMostRecentLogStream(logGroupName) {
  try {
    const command = new DescribeLogStreamsCommand({
      logGroupName,
      orderBy: 'LastEventTime',
      descending: true,
      limit: 1
    });
    
    const response = await logsClient.send(command);
    
    if (response.logStreams && response.logStreams.length > 0) {
      return response.logStreams[0];
    } else {
      console.log(`No log streams found for ${logGroupName}`);
      return null;
    }
  } catch (error) {
    console.error(`Error getting log streams for ${logGroupName}:`, error);
    return null;
  }
}

// Function to get log events from a log stream
async function getLogEvents(logGroupName, logStreamName) {
  try {
    const command = new GetLogEventsCommand({
      logGroupName,
      logStreamName,
      limit: 100 // Adjust as needed
    });
    
    const response = await logsClient.send(command);
    
    return response.events || [];
  } catch (error) {
    console.error(`Error getting log events for ${logGroupName}/${logStreamName}:`, error);
    return [];
  }
}

// Function to check if logs contain ScrapingBee API calls
function checkForScrapingBeeCalls(events) {
  const scrapingBeeEvents = events.filter(event => {
    const message = event.message || '';
    return message.includes('ScrapeBee') || 
           message.includes('Scraping') || 
           message.includes('scrapingbee.com');
  });
  
  return scrapingBeeEvents;
}

// Main function
async function main() {
  const logGroups = [
    '/aws/lambda/oracle-coordinator',
    '/aws/lambda/oracle-reddit-scraper',
    '/aws/lambda/oracle-stocktwits-scraper'
  ];
  
  for (const logGroupName of logGroups) {
    console.log(`\nChecking logs for ${logGroupName}...`);
    
    // Get the most recent log stream
    const logStream = await getMostRecentLogStream(logGroupName);
    
    if (!logStream) {
      continue;
    }
    
    console.log(`Most recent log stream: ${logStream.logStreamName}`);
    console.log(`Last event time: ${new Date(logStream.lastEventTimestamp).toISOString()}`);
    
    // Get log events
    const events = await getLogEvents(logGroupName, logStream.logStreamName);
    
    if (events.length === 0) {
      console.log('No log events found');
      continue;
    }
    
    console.log(`Found ${events.length} log events`);
    
    // Check for ScrapingBee API calls
    const scrapingBeeEvents = checkForScrapingBeeCalls(events);
    
    if (scrapingBeeEvents.length > 0) {
      console.log(`Found ${scrapingBeeEvents.length} events related to ScrapingBee:`);
      
      for (const event of scrapingBeeEvents) {
        console.log(`[${new Date(event.timestamp).toISOString()}] ${event.message.trim()}`);
      }
    } else {
      console.log('No ScrapingBee-related events found');
    }
    
    // Print a few sample log events
    console.log('\nSample log events:');
    for (let i = 0; i < Math.min(5, events.length); i++) {
      const event = events[i];
      console.log(`[${new Date(event.timestamp).toISOString()}] ${event.message.trim()}`);
    }
  }
}

// Run the main function
main().catch(error => {
  console.error('Error:', error);
});