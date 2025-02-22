// Core service imports
const express = require('express');
const { Pool } = require('pg');
const { Configuration, OpenAIApi } = require('openai');
const cors = require('cors');
const dotenv = require('dotenv');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const postsRouter = require('./routes/posts');
const subredditsRouter = require('./routes/subreddits');

// Service imports
const postingService = require('./services/postingService');
const taskQueue = require('./services/taskQueue');
const commentingService = require('./services/commentingService');
const seleniumService = require('./services/seleniumService');
const subredditService = require('./services/subredditService');
const authService = require('./services/authService');

// Configuration
dotenv.config();
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Database configuration
const dbConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: { 
        require: true, 
        rejectUnauthorized: false 
      }
    }
  : {
      user: process.env.DB_USER,
      host: process.env.DB_HOST,
      database: process.env.DB_NAME,
      password: process.env.DB_PASSWORD,
      port: process.env.DB_PORT,
    };

const pool = new Pool(dbConfig);

// Test database connection
if (process.env.NODE_ENV === 'production') {
  pool.query('SELECT NOW()', (err, res) => {
    if (err) {
      console.error('Production database connection error:', err);
      process.exit(1); // Exit if we can't connect in production
    } else {
      console.log('Production database connected successfully');
    }
  });
} else {
  pool.query('SELECT NOW()', (err, res) => {
    if (err) {
      console.error('Local database connection error:', err);
    } else {
      console.log('Local database connected successfully');
    }
  });
}

// OpenAI configuration
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

// Campaign Routes
app.get('/api/campaigns', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM campaigns ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaigns', async (req, res) => {
  const { name, campaign_goal, post_goal, comment_goal, target_sentiment, is_live, networks, target_url, media_assets } = req.body;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const campaignResult = await client.query(
      'INSERT INTO campaigns (name, campaign_goal, post_goal, comment_goal, target_sentiment, is_live) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [name, campaign_goal, post_goal, comment_goal, target_sentiment, is_live]
    );
    
    if (networks && networks.length > 0) {
      for (const network of networks) {
        await client.query(
          'INSERT INTO campaign_networks (campaign_id, network_type, settings) VALUES ($1, $2, $3)',
          [campaignResult.rows[0].id, network, {}]
        );
      }
    }
    
    if (is_live && networks.includes('reddit')) {
      const accounts = await seleniumService.verifyAccounts('reddit');
      if (!accounts.length) {
        throw new Error('No valid Reddit accounts available for live mode');
      }
    }
    
    await client.query('COMMIT');
    res.json(campaignResult.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete('/api/campaigns/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const campaignId = req.params.id;

    // Stop any running tasks
    await taskQueue.stopCampaign(campaignId);

    await client.query(
      `DELETE FROM comments c
       USING posts p
       WHERE c.post_id = p.id
       AND p.campaign_id = $1`,
      [campaignId]
    );

    await client.query(
      'DELETE FROM posts WHERE campaign_id = $1',
      [campaignId]
    );

    await client.query(
      `DELETE FROM campaign_subreddits cs
       USING campaign_networks cn
       WHERE cs.campaign_network_id = cn.id
       AND cn.campaign_id = $1`,
      [campaignId]
    );

    await client.query(
      'DELETE FROM campaign_networks WHERE campaign_id = $1',
      [campaignId]
    );

    await client.query(
      'DELETE FROM campaigns WHERE id = $1',
      [campaignId]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: 'Campaign and all related data deleted successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error deleting campaign:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});
app.get('/api/campaigns/:id/simulation/status', async (req, res) => {
  try {
    const status = await taskQueue.getCampaignStatus(req.params.id);
    res.json(status);
  } catch (err) {
    console.error('Error getting simulation status:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/simulation/start', async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id);
    const status = await taskQueue.getCampaignStatus(campaignId);
    
    if (status.isRunning) {
      return res.status(400).json({ error: 'Campaign is already running' });
    }
    
    await taskQueue.startCampaign(campaignId);
    res.json({ success: true, message: 'Simulation started' });
  } catch (err) {
    console.error('Error starting simulation:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/simulation/stop', async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id);
    const status = await taskQueue.getCampaignStatus(campaignId);
    
    if (!status.isRunning) {
      return res.status(400).json({ error: 'Campaign is not running' });
    }
    
    await taskQueue.stopCampaign(campaignId);
    res.json({ success: true, message: 'Simulation stopped' });
  } catch (err) {
    console.error('Error stopping simulation:', err);
    res.status(500).json({ error: err.message });
  }
});


// Posts and Comments Routes
app.get('/api/campaigns/:id/posts', async (req, res) => {
  try {
    const campaignId = req.params.id;
    
    // Get all posts with their authors
    const postsResult = await pool.query(
      `SELECT 
        p.*,
        sa.username as posted_by
       FROM posts p
       LEFT JOIN social_accounts sa ON p.social_account_id = sa.id
       WHERE p.campaign_id = $1
       ORDER BY p.posted_at DESC`,
      [campaignId]
    );

    // Get all comments with their authors
    const commentsResult = await pool.query(
      `SELECT 
        c.*,
        sa.username as commented_by
       FROM comments c
       JOIN posts p ON c.post_id = p.id
       LEFT JOIN social_accounts sa ON c.social_account_id = sa.id
       WHERE p.campaign_id = $1
       ORDER BY c.posted_at ASC`,
      [campaignId]
    );

    // Organize comments into threads
    const commentsByPost = {};
    commentsResult.rows.forEach(comment => {
      if (!commentsByPost[comment.post_id]) {
        commentsByPost[comment.post_id] = [];
      }
      commentsByPost[comment.post_id].push(comment);
    });

    // Build comment trees
    const buildCommentTree = (comments, parentId = null) => {
      const result = [];
      comments
        .filter(c => c.parent_comment_id === parentId)
        .forEach(comment => {
          result.push({
            ...comment,
            replies: buildCommentTree(comments, comment.id)
          });
        });
      return result;
    };

    // Organize posts by platform and subreddit
    const organizedPosts = {
      reddit: {},
      linkedin: []
    };

    postsResult.rows.forEach(post => {
      post.comments = buildCommentTree(commentsByPost[post.id] || []);
      
      if (post.platform === 'linkedin') {
        organizedPosts.linkedin.push(post);
      } else {
        // Reddit posts are organized by subreddit
        if (!organizedPosts.reddit[post.subreddit]) {
          organizedPosts.reddit[post.subreddit] = [];
        }
        organizedPosts.reddit[post.subreddit].push(post);
      }
    });

    res.json(organizedPosts);
  } catch (err) {
    console.error('Error fetching posts:', err);
    res.status(500).json({ error: err.message });
  }
});

// Analytics and Stats Routes
app.get('/api/campaigns/:id/simulation/stats', async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id);
    console.log('Fetching simulation stats for campaign:', campaignId);
    
    const result = await pool.query(`
      WITH post_metrics AS (
        SELECT 
          COUNT(*) as total_posts,
          COALESCE(SUM((engagement_metrics->>'upvotes')::int), 0) as total_engagement
        FROM posts 
        WHERE campaign_id = $1 
        AND status = 'simulated'
      ),
      comment_metrics AS (
        SELECT COUNT(*) as total_comments
        FROM comments c
        JOIN posts p ON c.post_id = p.id
        WHERE p.campaign_id = $1 
        AND c.status = 'simulated'
      )
      SELECT 
        COALESCE(pm.total_posts, 0) as posts,
        COALESCE(cm.total_comments, 0) as comments,
        COALESCE(pm.total_engagement, 0) as engagement
      FROM post_metrics pm
      CROSS JOIN comment_metrics cm`,
      [campaignId]
    );

    console.log('Stats result:', result.rows[0] || { posts: 0, comments: 0, engagement: 0 });
    
    res.json(result.rows[0] || {
      posts: 0,
      comments: 0,
      engagement: 0
    });
  } catch (err) {
    console.error('Error fetching simulation stats:', err);
    res.status(500).json({ error: err.message });
  }
});

// Add this with the other analytics routes
app.get('/api/campaigns/:id/analytics', async (req, res) => {
  try {
    const campaignId = req.params.id;
    
    const result = await pool.query(
      `WITH post_data AS (
        SELECT 
          DATE_TRUNC('day', posted_at) as date,
          COUNT(*) as post_count,
          SUM((engagement_metrics->>'upvotes')::int) as engagement
        FROM posts
        WHERE campaign_id = $1 AND status = 'simulated'
        GROUP BY DATE_TRUNC('day', posted_at)
      ),
      comment_data AS (
        SELECT 
          DATE_TRUNC('day', c.posted_at) as date,
          COUNT(*) as comment_count
        FROM comments c
        JOIN posts p ON c.post_id = p.id
        WHERE p.campaign_id = $1 AND c.status = 'simulated'
        GROUP BY DATE_TRUNC('day', c.posted_at)
      )
      SELECT 
        COALESCE(pd.date, cd.date) as date,
        COALESCE(pd.post_count, 0) as posts,
        COALESCE(cd.comment_count, 0) as comments,
        COALESCE(pd.engagement, 0) as engagement
      FROM post_data pd
      FULL OUTER JOIN comment_data cd ON pd.date = cd.date
      ORDER BY date ASC`,
      [campaignId]
    );

    // Transform dates to timestamps for the chart
    const analytics = result.rows.map(row => ({
      ...row,
      date: row.date.getTime() // Convert to timestamp for the chart
    }));

    res.json(analytics);
  } catch (err) {
    console.error('Error fetching analytics:', err);
    res.status(500).json({ error: err.message });
  }
});

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = 'uploads';
    try {
      await fs.mkdir(uploadDir, { recursive: true });
      cb(null, uploadDir);
    } catch (error) {
      cb(error, null);
    }
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only images are allowed'));
    }
    cb(null, true);
  }
});

// File Upload Routes
app.post('/api/upload', upload.single('media'), async (req, res) => {
  try {
    if (!req.file) {
      throw new Error('No file uploaded');
    }

    const url = `/uploads/${req.file.filename}`;
    res.json({
      url,
      type: req.file.mimetype
    });
  } catch (err) {
    console.error('Error uploading file:', err);
    res.status(500).json({ error: err.message });
  }
});

// Auth routes (unprotected)
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, firstName, lastName } = req.body;
    const user = await authService.registerUser(email, password, firstName, lastName);
    res.json(user);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await authService.loginUser(email, password);
    res.json(result);
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

app.post('/api/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    const tokens = await authService.refreshToken(refreshToken);
    res.json(tokens);
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    await authService.logout(refreshToken);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});


// Serve uploaded files
app.use('/uploads', express.static('uploads'));
app.use('/api', postsRouter);
app.use('/api', subredditsRouter);

if (process.env.NODE_ENV === 'production') {
  // Serve static files from the frontend build directory
  app.use(express.static(path.join(__dirname, '../../frontend/dist')));
  
  // Handle React routing, return all requests to React app
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../../frontend/dist/index.html'));
  });
}

// Add cleanup handling for graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received: closing HTTP server');
  
  // Stop all active campaigns
  for (const campaignId of taskQueue.activeCampaigns) {
    await taskQueue.stopCampaign(campaignId);
  }
  
  // Clean up selenium sessions
  await seleniumService.cleanup();
  
  // Close database pool
  await pool.end();
  
  process.exit(0);
});


if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../../frontend/dist')));
  
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../../frontend/dist/index.html'));
  });
}

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

module.exports = app;