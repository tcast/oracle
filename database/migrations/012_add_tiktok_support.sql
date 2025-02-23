-- Add TikTok to the platform enum if it doesn't exist
DO $$ 
BEGIN 
    ALTER TYPE platform_type ADD VALUE IF NOT EXISTS 'tiktok';
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Add TikTok-specific fields to posts table
ALTER TABLE posts 
ADD COLUMN video_url TEXT,
ADD COLUMN video_duration INTEGER,
ADD COLUMN caption TEXT;

-- Add TikTok content style
INSERT INTO network_content_styles (network_id, content_type, tone_guidelines, structure_guidelines, purpose_guidelines, format_rules)
VALUES (
    (SELECT id FROM social_networks WHERE network_type = 'tiktok'),
    'post',
    '{
        "style": "casual",
        "formality": "informal",
        "language_elements": [
            "hashtags",
            "emojis",
            "trending_phrases",
            "viral_language"
        ],
        "tone_range": [
            "playful",
            "energetic",
            "trendy",
            "authentic"
        ]
    }',
    '{
        "length": {
            "max_chars": 150,
            "optimal_range": "50-100"
        },
        "elements": [
            "hook",
            "context",
            "call_to_action"
        ],
        "formats": [
            "with_video",
            "caption_only"
        ]
    }',
    '{
        "primary_purposes": [
            "entertainment",
            "virality",
            "engagement",
            "trend_participation"
        ],
        "engagement_types": [
            "likes",
            "comments",
            "shares",
            "duets",
            "stitches"
        ]
    }',
    '{
        "allowed_elements": [
            "text",
            "hashtags",
            "mentions",
            "emojis"
        ],
        "video_requirements": {
            "max_duration": 180,
            "preferred_duration": 60,
            "formats": ["mp4", "mov"]
        },
        "character_limit": 150
    }'
); 