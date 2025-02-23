-- Add TikTok to social_networks table
INSERT INTO social_networks (network_type, name, description, required_fields)
VALUES (
    'tiktok',
    'TikTok',
    'Short-form video social network',
    '{
        "video_url": "string",
        "caption": "string",
        "video_duration": "integer"
    }'::jsonb
) ON CONFLICT (network_type) DO NOTHING;