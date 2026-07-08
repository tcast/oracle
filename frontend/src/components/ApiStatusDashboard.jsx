import React, { useState, useEffect } from 'react';
import { 
  Box, Typography, Paper, Grid, CircularProgress, 
  Chip, Button, Divider, Alert, Card, CardContent,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow
} from '@mui/material';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import RefreshIcon from '@mui/icons-material/Refresh';
import StorageIcon from '@mui/icons-material/Storage';
import MemoryIcon from '@mui/icons-material/Memory';
import PublicIcon from '@mui/icons-material/Public';
import api from '../utils/api';

const ApiStatusDashboard = () => {
  const [apiStatuses, setApiStatuses] = useState({});
  const [systemHealth, setSystemHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastChecked, setLastChecked] = useState(null);
  const [availableRoutes, setAvailableRoutes] = useState([]);
  const [lambdaStatus, setLambdaStatus] = useState(null);
  const [lambdaLoading, setLambdaLoading] = useState(true);

  // Define API endpoints organized by service
  const apiEndpoints = {
    'System Health': [
      { name: 'API Health', endpoint: '/api/health/status', method: 'GET' },
      { name: 'Available Routes', endpoint: '/api/health/routes', method: 'GET' },
      { name: 'Lambda Functions', endpoint: '/api/health/lambda', method: 'GET' },
    ],
    'Campaigns': [
      { name: 'All Campaigns', endpoint: '/api/campaigns', method: 'GET' },
      { name: 'Campaign by ID (sample)', endpoint: '/api/campaigns/1', method: 'GET' },
    ],
    'Subreddits': [
      { name: 'Campaign Subreddits (sample)', endpoint: '/api/subreddits/1', method: 'GET' },
    ],
    'Social Accounts': [
      { name: 'All Accounts', endpoint: '/api/social-accounts', method: 'GET' },
      { name: 'Account Filters', endpoint: '/api/social-accounts/filters', method: 'GET' },
    ],
    'External APIs': [
      { name: 'Reddit API', endpoint: '/api/health/external/reddit', method: 'GET' },
      { name: 'Twitter API', endpoint: '/api/health/external/twitter', method: 'GET' },
      { name: 'ScrapeBee API', endpoint: '/api/health/external/scrapebee', method: 'GET' },
    ]
  };

  // Check the status of all API endpoints
  const checkAllApiStatuses = async () => {
    setLoading(true);
    setError(null);
    const statuses = {};

    try {
      // Check Lambda functions status
      setLambdaLoading(true);
      try {
        const lambdaResponse = await api.get('/api/health/lambda');
        setLambdaStatus(lambdaResponse.data);
      } catch (lambdaError) {
        console.error('Error fetching Lambda status:', lambdaError);
        setLambdaStatus({ error: lambdaError.message });
      } finally {
        setLambdaLoading(false);
      }
      
      for (const category in apiEndpoints) {
        statuses[category] = {};
        
        for (const { name, endpoint, method } of apiEndpoints[category]) {
          try {
            statuses[category][name] = { status: 'checking' };
            
            // Set a timeout to avoid waiting too long for any one request
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            
            const startTime = Date.now();
            
            // Make sure we always call the actual API endpoints
            const response = await api({
              method,
              url: endpoint,
              signal: controller.signal
            });
            clearTimeout(timeoutId);
            
            const endTime = Date.now();
            const responseTime = endTime - startTime;
            
            // Store response data for certain endpoints
            if (endpoint === '/api/health/status') {
              setSystemHealth(response.data);
            }
            
            if (endpoint === '/api/health/routes') {
              setAvailableRoutes(response.data.routes || []);
            }
            
            statuses[category][name] = { 
              status: 'online',
              responseTime,
              lastChecked: new Date().toISOString(),
              data: response.data
            };
          } catch (err) {
            statuses[category][name] = { 
              status: 'offline',
              error: err.message,
              lastChecked: new Date().toISOString()
            };
          }
        }
      }

      setApiStatuses(statuses);
      setLastChecked(new Date().toISOString());
      setLoading(false);
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  };

  // Check API statuses when component mounts
  useEffect(() => {
    checkAllApiStatuses();
  }, []);

  // Render status chip
  const renderStatusChip = (status) => {
    if (status === 'online' || status === 'healthy') {
      return <Chip 
        icon={<CheckCircleOutlineIcon />} 
        label="Online" 
        color="success" 
        size="small"
      />;
    } else if (status === 'offline' || status === 'unhealthy') {
      return <Chip 
        icon={<ErrorOutlineIcon />} 
        label="Offline" 
        color="error" 
        size="small"
      />;
    } else if (status === 'degraded') {
      return <Chip 
        icon={<ErrorOutlineIcon />} 
        label="Degraded" 
        color="warning" 
        size="small"
      />;
    } else if (status === 'unavailable') {
      return <Chip 
        icon={<ErrorOutlineIcon />} 
        label="Configuration Required" 
        color="secondary" 
        size="small"
      />;
    } else {
      return <Chip 
        icon={<HourglassEmptyIcon />} 
        label="Checking" 
        color="warning" 
        size="small"
      />;
    }
  };

  // Helper function to get overall external API status
  const getExternalApiStatus = () => {
    if (!apiStatuses['External APIs']) return 'checking';
    
    const externalApis = apiStatuses['External APIs'];
    const statuses = Object.values(externalApis).map(api => api.status);
    
    if (statuses.some(status => status === 'online')) {
      return 'online';
    } else if (statuses.every(status => status === 'unavailable')) {
      return 'unavailable';
    } else if (statuses.some(status => status === 'degraded')) {
      return 'degraded'; 
    } else {
      return 'offline';
    }
  };

  // Function to count external APIs with specific status
  const countExternalApisByStatus = (status) => {
    if (!apiStatuses['External APIs']) return 0;
    return Object.values(apiStatuses['External APIs'])
      .filter(api => api.status === status)
      .length;
  };

  // Render system health summary
  const renderSystemHealth = () => {
    if (!systemHealth) return null;
    
    return (
      <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
        <Typography variant="h6" component="h2" gutterBottom>
          System Health Summary
        </Typography>
        <Divider sx={{ mb: 2 }} />
        
        <Grid container spacing={3}>
          <Grid item xs={12} md={4}>
            <Card sx={{ height: '100%' }}>
              <CardContent>
                <Typography variant="h6" component="div" gutterBottom>
                  API Server
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                  <MemoryIcon sx={{ mr: 1 }} color="primary" />
                  <Typography variant="body1">
                    Status: {renderStatusChip(systemHealth.services?.api || 'checking')}
                  </Typography>
                </Box>
                <Typography variant="body2" color="text.secondary">
                  Version: {systemHealth.version || 'Unknown'}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Uptime: {systemHealth.uptime || 'Unknown'}
                </Typography>
              </CardContent>
            </Card>
          </Grid>
          
          <Grid item xs={12} md={4}>
            <Card sx={{ height: '100%' }}>
              <CardContent>
                <Typography variant="h6" component="div" gutterBottom>
                  Database
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                  <StorageIcon sx={{ mr: 1 }} color="primary" />
                  <Typography variant="body1">
                    Status: {renderStatusChip(systemHealth.services?.database || 'checking')}
                  </Typography>
                </Box>
                <Typography variant="body2" color="text.secondary">
                  Last checked: {new Date(systemHealth.timestamp).toLocaleString()}
                </Typography>
              </CardContent>
            </Card>
          </Grid>
          
          <Grid item xs={12} md={4}>
            <Card sx={{ height: '100%' }}>
              <CardContent>
                <Typography variant="h6" component="div" gutterBottom>
                  External Connections
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                  <PublicIcon sx={{ mr: 1 }} color="primary" />
                  <Typography variant="body1">
                    Status: {renderStatusChip(getExternalApiStatus())}
                  </Typography>
                </Box>
                <Typography variant="body2" color="text.secondary">
                  {countExternalApisByStatus('online') > 0 
                    ? `${countExternalApisByStatus('online')} APIs online` 
                    : 'No APIs connected'}
                </Typography>
                {countExternalApisByStatus('unavailable') > 0 && (
                  <Typography variant="body2" color="error">
                    {countExternalApisByStatus('unavailable')} APIs need configuration
                  </Typography>
                )}
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      </Paper>
    );
  };

  const checkApiStatus = async () => {
    setLoading(true);
    setError(null);
    setLastChecked(new Date().toLocaleString());
    
    try {
      // Check system health first
      const healthResponse = await api.get('/api/health/status');
      setSystemHealth(healthResponse.data);
      
      // Get available routes
      const routesResponse = await api.get('/api/health/routes');
      setAvailableRoutes(routesResponse.data);

      // ... existing api status checking code ...

      // ... existing code ...

      // ... existing code ...

    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Add this new component for Lambda Status
  const LambdaStatusCard = ({ lambdaStatus, loading }) => {
    if (loading) {
      return (
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Lambda Functions Status
            </Typography>
            <Box display="flex" justifyContent="center" my={3}>
              <CircularProgress />
            </Box>
          </CardContent>
        </Card>
      );
    }

    if (!lambdaStatus || lambdaStatus.error) {
      return (
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Lambda Functions Status
            </Typography>
            <Alert severity="error">
              {lambdaStatus?.error || 'Unable to fetch Lambda status'}
            </Alert>
          </CardContent>
        </Card>
      );
    }

    // Check if AWS configuration is required
    if (lambdaStatus.status === 'configuration_required') {
      return (
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Lambda Functions Status
            </Typography>
            <Alert severity="warning">
              {lambdaStatus.message || 'AWS credentials need to be configured'}
            </Alert>
            <Box mt={2}>
              <Typography variant="body2">
                To enable Lambda function status monitoring, please set the following environment variables:
              </Typography>
              <ul>
                <li>AWS_ACCESS_KEY_ID</li>
                <li>AWS_SECRET_ACCESS_KEY</li>
                <li>AWS_REGION (optional, defaults to us-east-1)</li>
              </ul>
            </Box>
          </CardContent>
        </Card>
      );
    }
    
    // Check if AWS SDK is missing
    if (lambdaStatus.status === 'sdk_missing' || lambdaStatus.usingFallback) {
      return (
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Lambda Functions Status (Estimated)
            </Typography>
            <Alert severity="info">
              {lambdaStatus.message || 'Using database activity to estimate Lambda function status'}
            </Alert>
            
            <Box mt={3}>
              <Typography variant="subtitle1" gutterBottom>
                Lambda Functions (Estimated):
              </Typography>
              <TableContainer component={Paper} variant="outlined">
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Function</TableCell>
                      <TableCell>Status</TableCell>
                      <TableCell>Last Invoked (Est.)</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {lambdaStatus.lambdaFunctions?.map((func, index) => (
                      <TableRow key={index}>
                        <TableCell>{func.name}</TableCell>
                        <TableCell>
                          {func.estimatedActive ? (
                            <Chip 
                              size="small"
                              label="Likely Active" 
                              color="success" 
                            />
                          ) : (
                            <Chip size="small" label="Likely Inactive" color="warning" />
                          )}
                        </TableCell>
                        <TableCell>{func.estimatedLastInvoked || 'Unknown'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Box>
            
            {lambdaStatus.scrapedData?.active ? (
              <Box mt={3}>
                <Typography variant="subtitle1" gutterBottom>
                  Scraped Data (Last 24 hours):
                </Typography>
                <TableContainer component={Paper} variant="outlined">
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Platform</TableCell>
                        <TableCell>Count</TableCell>
                        <TableCell>Latest Scrape</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {lambdaStatus.scrapedData.platforms.map((platform, index) => (
                        <TableRow key={index}>
                          <TableCell>{platform.name}</TableCell>
                          <TableCell>{platform.count}</TableCell>
                          <TableCell>
                            {new Date(platform.latest_scrape).toLocaleString()}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              </Box>
            ) : (
              <Alert severity="warning" sx={{ mt: 3 }}>
                {lambdaStatus.scrapedData?.message || 'No recent scraped data available'}
              </Alert>
            )}
            
            <Box mt={2}>
              <Typography variant="body2">
                To enable full Lambda function monitoring, please install the AWS SDK package:
              </Typography>
              <Box sx={{ backgroundColor: '#f5f5f5', p: 1, mt: 1, borderRadius: 1 }}>
                <code>npm install aws-sdk@2.1361.0 --save</code>
              </Box>
            </Box>
          </CardContent>
        </Card>
      );
    }

    return (
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Lambda Functions Status
          </Typography>
          
          <Box mt={2}>
            <Typography variant="subtitle1" gutterBottom>
              Overall Status: 
              <Chip
                label={lambdaStatus.status}
                color={lambdaStatus.status === 'healthy' ? 'success' : 'warning'}
                size="small"
                sx={{ ml: 1 }}
              />
            </Typography>
          </Box>
          
          <Box mt={3}>
            <Typography variant="subtitle1" gutterBottom>
              Lambda Functions:
            </Typography>
            <TableContainer component={Paper} variant="outlined">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Function</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Last Invoked</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {lambdaStatus.lambdaFunctions?.map((func, index) => (
                    <TableRow key={index}>
                      <TableCell>{func.name}</TableCell>
                      <TableCell>
                        {func.exists ? (
                          <Chip 
                            size="small"
                            label={func.active ? "Active" : "Inactive"} 
                            color={func.active ? "success" : "warning"} 
                          />
                        ) : (
                          <Chip size="small" label="Not Found" color="error" />
                        )}
                      </TableCell>
                      <TableCell>{func.lastInvoked || 'Never'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
          
          <Box mt={3}>
            <Typography variant="subtitle1" gutterBottom>
              Scraped Data (Last 24 hours):
            </Typography>
            {lambdaStatus.scrapedData?.active ? (
              <TableContainer component={Paper} variant="outlined">
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Platform</TableCell>
                      <TableCell>Count</TableCell>
                      <TableCell>Latest Scrape</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {lambdaStatus.scrapedData.platforms.map((platform, index) => (
                      <TableRow key={index}>
                        <TableCell>{platform.name}</TableCell>
                        <TableCell>{platform.count}</TableCell>
                        <TableCell>
                          {new Date(platform.latest_scrape).toLocaleString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            ) : (
              <Alert severity="warning">
                {lambdaStatus.scrapedData?.message || 'No recent scraped data available'}
              </Alert>
            )}
          </Box>
        </CardContent>
      </Card>
    );
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          API Status Dashboard
        </Typography>
        <Box>
          <Button
            variant="contained"
            startIcon={<RefreshIcon />}
            onClick={checkAllApiStatuses}
            disabled={loading}
          >
            {loading ? 'Checking...' : 'Check All'}
          </Button>
        </Box>
      </Box>
      
      {error && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {error}
        </Alert>
      )}
      
      {lastChecked && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Last checked: {new Date(lastChecked).toLocaleString()}
        </Typography>
      )}
      
      {loading && !Object.keys(apiStatuses).length ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', my: 4 }}>
          <CircularProgress />
        </Box>
      ) : (
        <Box>
          {systemHealth && renderSystemHealth()}
          
          {/* Add the Lambda Status Card here */}
          <LambdaStatusCard lambdaStatus={lambdaStatus} loading={lambdaLoading} />
          
          {Object.entries(apiStatuses).map(([category, endpoints]) => (
            <Paper sx={{ p: 3, mb: 3 }} key={category} elevation={2}>
              <Typography variant="h6" component="h2" gutterBottom>
                {category}
              </Typography>
              <Divider sx={{ mb: 2 }} />
              <Grid container spacing={3}>
                {Object.entries(endpoints).map(([name, data]) => (
                  <Grid item xs={12} md={4} key={name}>
                    <Card variant="outlined">
                      <CardContent>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                          <Typography variant="subtitle1">{name}</Typography>
                          {renderStatusChip(data.status)}
                        </Box>
                        
                        {data.status === 'online' && (
                          <Typography variant="body2" color="text.secondary">
                            Response time: {data.responseTime}ms
                          </Typography>
                        )}
                        
                        {data.status === 'offline' && (
                          <Typography variant="body2" color="error">
                            Error: {data.error?.substring(0, 100)}
                            {data.error?.length > 100 ? '...' : ''}
                          </Typography>
                        )}
                        
                        {data.status === 'unavailable' && data.data?.configRequired && (
                          <>
                            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                              API key required: <strong>{data.data.missingKey}</strong>
                            </Typography>
                            {data.data.registerUrl && (
                              <Button 
                                variant="outlined" 
                                size="small" 
                                color="primary" 
                                sx={{ mt: 1 }}
                                href={data.data.registerUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                Register for API key
                              </Button>
                            )}
                          </>
                        )}
                      </CardContent>
                    </Card>
                  </Grid>
                ))}
              </Grid>
            </Paper>
          ))}
          
          {availableRoutes.length > 0 && (
            <Paper sx={{ p: 3, mb: 3 }} elevation={2}>
              <Typography variant="h6" component="h2" gutterBottom>
                Available API Routes
              </Typography>
              <Divider sx={{ mb: 2 }} />
              
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell><strong>Path</strong></TableCell>
                      <TableCell><strong>Methods</strong></TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {availableRoutes.map((route, index) => (
                      <TableRow key={index}>
                        <TableCell>{route.path}</TableCell>
                        <TableCell>
                          {route.methods.map(method => (
                            <Chip 
                              key={method} 
                              label={method} 
                              size="small"
                              color={
                                method === 'GET' ? 'primary' : 
                                method === 'POST' ? 'success' :
                                method === 'PUT' ? 'warning' :
                                method === 'DELETE' ? 'error' : 'default'
                              }
                              sx={{ mr: 0.5, mb: 0.5 }}
                            />
                          ))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Paper>
          )}
        </Box>
      )}
    </Box>
  );
};

export default ApiStatusDashboard;