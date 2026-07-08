/**
 * Script to list directories in Polygon's S3 bucket
 */
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

// Polygon Flat File S3 configuration
const s3Client = new S3Client({
  region: 'us-east-1', // Default region
  endpoint: 'https://files.polygon.io',
  credentials: {
    accessKeyId: '18972b38-e2dd-40cf-bb10-f3eede60c8c4',
    secretAccessKey: 'GamH9ewSNWT6BeUM19cdtlCzyNCfVHWx'
  },
  forcePathStyle: true // Required for some S3-compatible services
});

const BUCKET_NAME = 'flatfiles';

async function listBucketContents(prefix = '') {
  try {
    console.log(`Listing contents of bucket '${BUCKET_NAME}' with prefix: '${prefix || 'root'}'`);
    
    const command = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: prefix,
      Delimiter: '/'
    });
    
    const response = await s3Client.send(command);
    
    // Output common prefixes (directories)
    if (response.CommonPrefixes && response.CommonPrefixes.length > 0) {
      console.log('Directories:');
      response.CommonPrefixes.forEach(prefix => {
        console.log(`- ${prefix.Prefix}`);
      });
    } else {
      console.log('No directories found');
    }
    
    // Output files at this level
    if (response.Contents && response.Contents.length > 0) {
      console.log('Files:');
      response.Contents.forEach(item => {
        // Don't show directory markers
        if (!item.Key.endsWith('/')) {
          console.log(`- ${item.Key} (${item.Size} bytes, Last Modified: ${item.LastModified})`);
        }
      });
    } else {
      console.log('No files found at this level');
    }
    
    return response;
  } catch (error) {
    console.error('Error listing bucket contents:', error);
  }
}

// If an argument is provided, use it as the prefix
const prefix = process.argv[2] || '';
listBucketContents(prefix);