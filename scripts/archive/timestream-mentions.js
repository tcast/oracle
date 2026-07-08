/**
 * Module for interacting with the Timestream database for scraped mentions
 * This handles writing and querying scraped social media mentions
 */

const { TimestreamWriteClient, WriteRecordsCommand } = require('@aws-sdk/client-timestream-write');
const { TimestreamQueryClient, QueryCommand } = require('@aws-sdk/client-timestream-query');

// Configure AWS SDK
const region = process.env.AWS_REGION || 'us-east-1';
const timestreamWrite = new TimestreamWriteClient({ region });
const timestreamQuery = new TimestreamQueryClient({ region });

// Constants
const DATABASE_NAME = 'oracle';
const TABLE_NAME = 'scraped_mentions';
const BATCH_SIZE = 100; // Timestream API limit is 100 records per request

/**
 * Convert a scraped mention to a Timestream record
 * 
 * @param {Object} mention - The scraped mention object
 * @returns {Object} - Timestream record format
 */
function convertMentionToTimestreamRecord(mention) {
  // Create a timestamp - use post_date if available, otherwise current time
  const timestamp = mention.post_date 
    ? new Date(mention.post_date).getTime() 
    : Date.now();
  
  // Build dimensions - these are attributes we can filter/group by
  const dimensions = [
    { Name: 'symbol', Value: mention.symbol },
    { Name: 'platform', Value: mention.platform },
    { Name: 'asset_type', Value: mention.asset_type || 'stock' }
  ];
  
  // Add optional sub-platform (e.g., subreddit) if available
  if (mention.subreddit) {
    dimensions.push({ Name: 'subreddit', Value: mention.subreddit });
  }
  
  // Add user followers as dimension if available (for filtering by influence level)
  if (mention.user_followers) {
    dimensions.push({ Name: 'user_followers', Value: mention.user_followers.toString() });
  }
  
  // Add post_id as dimension for uniqueness
  if (mention.post_id) {
    dimensions.push({ Name: 'post_id', Value: mention.post_id });
  }
  
  // Build measure values - these are the metrics
  const measureValues = [
    { Name: 'sentiment_score', Value: (mention.sentiment_score || 0).toString(), Type: 'DOUBLE' }
  ];
  
  // Add optional measures if available
  if (mention.sentiment_label) {
    measureValues.push({ Name: 'sentiment_label', Value: mention.sentiment_label, Type: 'VARCHAR' });
  }
  
  // Text content is stored as a measure
  if (mention.post_text || mention.content) {
    measureValues.push({ 
      Name: 'content', 
      Value: (mention.post_text || mention.content || '').substring(0, 2048), // Limit length 
      Type: 'VARCHAR' 
    });
  }
  
  // URL is stored as a measure
  if (mention.post_url || mention.url) {
    measureValues.push({ 
      Name: 'url', 
      Value: (mention.post_url || mention.url || ''), 
      Type: 'VARCHAR' 
    });
  }
  
  return {
    Dimensions: dimensions,
    MeasureName: 'social_mention',
    MeasureValues: measureValues,
    Time: timestamp.toString(),
    TimeUnit: 'MILLISECONDS'
  };
}

/**
 * Write mentions to Timestream
 * 
 * @param {Array} mentions - Array of mention objects
 * @returns {Promise<Object>} - Results of the batch writes
 */
async function writeMentionsToTimestream(mentions) {
  if (!mentions || mentions.length === 0) {
    console.log('No mentions to write to Timestream');
    return { success: true, processedCount: 0 };
  }
  
  console.log(`Writing ${mentions.length} mentions to Timestream`);
  
  // Convert mentions to Timestream records
  const records = mentions.map(convertMentionToTimestreamRecord);
  
  // Write in batches (Timestream limits to 100 records per write)
  const results = {
    success: true,
    processedCount: 0,
    errors: []
  };
  
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    
    try {
      const params = {
        DatabaseName: DATABASE_NAME,
        TableName: TABLE_NAME,
        Records: batch
      };
      
      const command = new WriteRecordsCommand(params);
      await timestreamWrite.send(command);
      
      results.processedCount += batch.length;
      console.log(`Successfully wrote batch of ${batch.length} mentions to Timestream`);
    } catch (error) {
      console.error(`Error writing batch to Timestream:`, error);
      results.success = false;
      results.errors.push(error.message);
    }
  }
  
  return results;
}

/**
 * Query recent mentions for a given symbol
 * 
 * @param {string} symbol - Stock or crypto symbol
 * @param {number} hours - Hours of history to retrieve
 * @returns {Promise<Array>} - Array of mention objects
 */
async function queryRecentMentions(symbol, hours = 24) {
  const query = `
    SELECT time, 
           symbol,
           platform,
           measure_name,
           CASE 
             WHEN measure_name = 'social_mention' THEN 
               (SELECT measure_value::double FROM UNNEST(multi_measure_values) 
                WHERE measure_name = 'sentiment_score')
           END AS sentiment_score,
           CASE 
             WHEN measure_name = 'social_mention' THEN 
               (SELECT measure_value::varchar FROM UNNEST(multi_measure_values) 
                WHERE measure_name = 'sentiment_label')
           END AS sentiment_label,
           CASE 
             WHEN measure_name = 'social_mention' THEN 
               (SELECT measure_value::varchar FROM UNNEST(multi_measure_values) 
                WHERE measure_name = 'content')
           END AS content,
           CASE 
             WHEN measure_name = 'social_mention' THEN 
               (SELECT measure_value::varchar FROM UNNEST(multi_measure_values) 
                WHERE measure_name = 'url')
           END AS url
    FROM "${DATABASE_NAME}"."${TABLE_NAME}"
    WHERE symbol = '${symbol}'
      AND time >= ago(${hours}h)
    ORDER BY time DESC
  `;
  
  console.log(`Executing query for recent mentions of ${symbol}`);
  
  try {
    const command = new QueryCommand({ QueryString: query });
    const response = await timestreamQuery.send(command);
    
    // Process and format the results
    const results = [];
    for (const row of response.Rows) {
      const mention = {};
      
      response.ColumnInfo.forEach((column, i) => {
        const columnName = column.Name;
        const value = row.Data[i].ScalarValue;
        
        if (columnName === 'time') {
          mention.timestamp = value;
          mention.post_date = new Date(value).toISOString();
        } else if (columnName === 'sentiment_score') {
          mention.sentiment_score = value ? parseFloat(value) : 0;
        } else {
          mention[columnName] = value;
        }
      });
      
      results.push(mention);
    }
    
    console.log(`Retrieved ${results.length} mentions for ${symbol}`);
    return results;
  } catch (error) {
    console.error(`Error querying mentions from Timestream:`, error);
    throw error;
  }
}

module.exports = {
  writeMentionsToTimestream,
  queryRecentMentions
}; 