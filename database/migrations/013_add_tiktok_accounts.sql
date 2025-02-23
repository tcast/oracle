-- Add TikTok social accounts with diverse personas
INSERT INTO social_accounts (platform, username, credentials, status, persona_traits)
VALUES
  (
    'tiktok',
    'tech_trends',
    '{"password": "default_password"}',
    'active',
    '{
      "writingStyle": "trendy",
      "responseLength": "short",
      "tone": "energetic",
      "quirks": ["uses_emojis", "tech_slang"],
      "expertise": ["technology", "gadgets"],
      "engagementStyle": "entertainer"
    }'
  ),
  (
    'tiktok',
    'startup_vibes',
    '{"password": "default_password"}',
    'active',
    '{
      "writingStyle": "casual",
      "responseLength": "short",
      "tone": "motivational",
      "quirks": ["business_humor", "trending_sounds"],
      "expertise": ["startups", "business"],
      "engagementStyle": "educator"
    }'
  ),
  (
    'tiktok',
    'future_now',
    '{"password": "default_password"}',
    'active',
    '{
      "writingStyle": "dynamic",
      "responseLength": "short",
      "tone": "exciting",
      "quirks": ["visual_effects", "transitions"],
      "expertise": ["future tech", "innovation"],
      "engagementStyle": "trendsetter"
    }'
  ),
  (
    'tiktok',
    'code_life',
    '{"password": "default_password"}',
    'active',
    '{
      "writingStyle": "humorous",
      "responseLength": "short",
      "tone": "relatable",
      "quirks": ["dev_jokes", "code_memes"],
      "expertise": ["programming", "tech culture"],
      "engagementStyle": "entertainer"
    }'
  ),
  (
    'tiktok',
    'digital_creative',
    '{"password": "default_password"}',
    'active',
    '{
      "writingStyle": "artistic",
      "responseLength": "short",
      "tone": "inspiring",
      "quirks": ["creative_transitions", "visual_storytelling"],
      "expertise": ["digital art", "design"],
      "engagementStyle": "creator"
    }'
  ); 