/**
 * Simple test for Polygon.io access
 */
const https = require('https');

// Your Polygon.io API key
const POLYGON_API_KEY = 'S61uA7CzojtsFXNqJAK6t4OW2EA0d5A0';

// Test an API endpoint that doesn't require S3 credentials
const endpoint = `https://api.polygon.io/v2/aggs/ticker/AAPL/range/1/day/2023-01-01/2023-01-10?apiKey=${POLYGON_API_KEY}`;

console.log(`Testing connection to Polygon.io API...`);
console.log(`Endpoint: ${endpoint}`);

https.get(endpoint, (res) => {
    const { statusCode } = res;
    console.log(`Status Code: ${statusCode}`);
    
    let data = '';
    
    res.on('data', (chunk) => {
        data += chunk;
    });
    
    res.on('end', () => {
        try {
            const parsedData = JSON.parse(data);
            console.log('Response status:', parsedData.status);
            console.log('Results count:', parsedData.results ? parsedData.results.length : 'none');
            if (parsedData.results && parsedData.results.length > 0) {
                console.log('First result:', JSON.stringify(parsedData.results[0], null, 2));
            }
        } catch (e) {
            console.error('Error parsing response:', e.message);
            console.log('Raw response:', data);
        }
    });
}).on('error', (e) => {
    console.error(`Error: ${e.message}`);
});