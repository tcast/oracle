// backend/src/middleware/auth.js
const jwt = require('jsonwebtoken');

// Public routes that don't require authentication
const publicRoutes = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/verify-token'
];

const authMiddleware = (req, res, next) => {
  // Check if the route is public
  if (publicRoutes.some(route => req.path.startsWith(route))) {
    return next();
  }

  // Get token from header (support both formats) or ?token= for SSE/EventSource
  const tokenFromXAuth = req.header('x-auth-token');
  const authHeader = req.header('Authorization');
  let token = tokenFromXAuth;
  
  // Extract token from Authorization header if present
  if (!token && authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }
  if (!token && req.query && (req.query.token || req.query.access_token)) {
    token = String(req.query.token || req.query.access_token);
  }

  // Check if no token
  if (!token) {
    console.log('No token provided for:', req.method, req.path);
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Add user from payload (token has userId/email/role at top level)
    req.user = decoded.user || { id: decoded.userId, email: decoded.email, role: decoded.role };
    next();
  } catch (err) {
    console.log('Invalid token error:', err.message);
    res.status(401).json({ error: 'Token is not valid' });
  }
};

// Optional middleware for role-based access
const requireRole = (role) => {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
};

module.exports = { authMiddleware, requireRole };