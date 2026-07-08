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

// Main function
async function main() {
  const logGroupName = '/aws/lambda/updateDailyOHLC';
  
  console.log(`Checking logs for ${logGroupName}...`);
  
  // Get the most recent log stream
  const logStream = await getMostRecentLogStream(logGroupName);
  
  if (!logStream) {
    console.log('No log streams found');
    return;
  }
  
  console.log(`Most recent log stream: ${logStream.logStreamName}`);
  console.log(`Last event time: ${new Date(logStream.lastEventTimestamp).toISOString()}`);
  
  // Get log events
  const events = await getLogEvents(logGroupName, logStream.logStreamName);
  
  if (events.length === 0) {
    console.log('No log events found');
    return;
  }
  
  console.log(`Found ${events.length} log events`);
  
  // Print log events
  console.log('\nLog events:');
  events.forEach(event => {
    console.log(`[${new Date(event.timestamp).toISOString()}] ${event.message.trim()}`);
  });
}

// Run the main function
main().catch(error => {
  console.error('Error:', error);
});