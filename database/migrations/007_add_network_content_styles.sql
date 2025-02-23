
-- Insert X (Twitter) Post Style
INSERT INTO network_content_styles (network_id, content_type, tone_guidelines, structure_guidelines, purpose_guidelines, format_rules)
VALUES (
    3, -- X (Twitter)
    'post',
    '{
        "style": "concise",
        "formality": "casual",
        "language_elements": [
            "hashtags",
            "mentions",
            "trending_topics",
            "viral_language"
        ],
        "tone_range": [
            "engaging",
            "witty",
            "informative",
            "provocative"
        ]
    }',
    '{
        "length": {
            "max_chars": 280,
            "optimal_range": "150-220"
        },
        "elements": [
            "hook",
            "main_point",
            "call_to_action"
        ],
        "formats": [
            "text_only",
            "with_media",
            "thread_starter"
        ]
    }',
    '{
        "primary_purposes": [
            "engagement",
            "virality",
            "discussion",
            "awareness"
        ],
        "engagement_types": [
            "retweets",
            "quotes",
            "replies",
            "likes"
        ]
    }',
    '{
        "allowed_elements": [
            "text",
            "images",
            "videos",
            "links",
            "polls"
        ],
        "formatting_options": [
            "hashtags",
            "mentions",
            "emojis",
            "line_breaks"
        ],
        "character_limit": 280
    }'
);

-- Add trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_network_content_styles_updated_at
    BEFORE UPDATE ON network_content_styles
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column(); 