-- Social Accounts Table
CREATE TABLE social_accounts (
    id SERIAL PRIMARY KEY,
    platform VARCHAR(50) NOT NULL,
    username VARCHAR(100) NOT NULL,
    credentials JSONB NOT NULL,
    status VARCHAR(20) DEFAULT 'active',
    last_used_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(platform, username)
);

-- Campaigns Table
CREATE TABLE campaigns (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    goal TEXT NOT NULL,
    target_sentiment VARCHAR(20) NOT NULL,
    status VARCHAR(20) DEFAULT 'active',
    min_post_interval_hours INTEGER DEFAULT 6,
    max_post_interval_hours INTEGER DEFAULT 48,
    min_reply_interval_minutes INTEGER DEFAULT 30,
    max_reply_interval_minutes INTEGER DEFAULT 180,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Posts Table
CREATE TABLE posts (
    id SERIAL PRIMARY KEY,
    campaign_id INTEGER REFERENCES campaigns(id),
    social_account_id INTEGER REFERENCES social_accounts(id),
    platform_post_id VARCHAR(100),
    content TEXT NOT NULL,
    sentiment_score DECIMAL,
    engagement_metrics JSONB,
    status VARCHAR(20) DEFAULT 'pending',
    scheduled_for TIMESTAMP,
    posted_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Comments Table
CREATE TABLE comments (
    id SERIAL PRIMARY KEY,
    post_id INTEGER REFERENCES posts(id),
    social_account_id INTEGER REFERENCES social_accounts(id),
    parent_comment_id INTEGER REFERENCES comments(id),
    platform_comment_id VARCHAR(100),
    content TEXT NOT NULL,
    sentiment_score DECIMAL,
    engagement_metrics JSONB,
    status VARCHAR(20) DEFAULT 'pending',
    scheduled_for TIMESTAMP,
    posted_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);