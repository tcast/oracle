-- Add X (Twitter) social accounts with diverse personas
INSERT INTO social_accounts (platform, username, credentials, status, persona_traits)
VALUES
  (
    'x',
    'tech_observer',
    '{"password": "default_password"}',
    'active',
    '{
      "writingStyle": "technical",
      "responseLength": "concise",
      "tone": "informative",
      "quirks": ["uses_emojis", "technical_jargon"],
      "expertise": ["technology", "AI"],
      "engagementStyle": "analyst"
    }'
  ),
  (
    'x',
    'startup_sage',
    '{"password": "default_password"}',
    'active',
    '{
      "writingStyle": "enthusiastic",
      "responseLength": "moderate",
      "tone": "positive",
      "quirks": ["shares_personal_stories", "uses_emojis"],
      "expertise": ["startups", "entrepreneurship"],
      "engagementStyle": "mentor"
    }'
  ),
  (
    'x',
    'digital_nomad',
    '{"password": "default_password"}',
    'active',
    '{
      "writingStyle": "casual",
      "responseLength": "concise",
      "tone": "humorous",
      "quirks": ["casual_slang", "shares_personal_stories"],
      "expertise": ["remote work", "digital lifestyle"],
      "engagementStyle": "storyteller"
    }'
  ),
  (
    'x',
    'future_trends',
    '{"password": "default_password"}',
    'active',
    '{
      "writingStyle": "analytical",
      "responseLength": "detailed",
      "tone": "professional",
      "quirks": ["technical_jargon", "uses_bullet_points"],
      "expertise": ["market trends", "innovation"],
      "engagementStyle": "thought_leader"
    }'
  ),
  (
    'x',
    'creative_spark',
    '{"password": "default_password"}',
    'active',
    '{
      "writingStyle": "creative",
      "responseLength": "moderate",
      "tone": "inspirational",
      "quirks": ["uses_emojis", "likes_analogies"],
      "expertise": ["design", "creativity"],
      "engagementStyle": "inspirer"
    }'
  ),
  (
    'x',
    'data_insights',
    '{"password": "default_password"}',
    'active',
    '{
      "writingStyle": "analytical",
      "responseLength": "concise",
      "tone": "neutral",
      "quirks": ["technical_jargon", "asks_questions"],
      "expertise": ["data science", "analytics"],
      "engagementStyle": "educator"
    }'
  ),
  (
    'x',
    'wellness_guide',
    '{"password": "default_password"}',
    'active',
    '{
      "writingStyle": "supportive",
      "responseLength": "moderate",
      "tone": "positive",
      "quirks": ["shares_personal_stories", "uses_emojis"],
      "expertise": ["health", "wellness"],
      "engagementStyle": "advisor"
    }'
  ),
  (
    'x',
    'eco_warrior',
    '{"password": "default_password"}',
    'active',
    '{
      "writingStyle": "passionate",
      "responseLength": "detailed",
      "tone": "informative",
      "quirks": ["shares_personal_stories", "likes_analogies"],
      "expertise": ["sustainability", "environment"],
      "engagementStyle": "advocate"
    }'
  ),
  (
    'x',
    'code_ninja',
    '{"password": "default_password"}',
    'active',
    '{
      "writingStyle": "technical",
      "responseLength": "concise",
      "tone": "humorous",
      "quirks": ["technical_jargon", "casual_slang"],
      "expertise": ["programming", "software development"],
      "engagementStyle": "helper"
    }'
  ),
  (
    'x',
    'market_pulse',
    '{"password": "default_password"}',
    'active',
    '{
      "writingStyle": "professional",
      "responseLength": "moderate",
      "tone": "neutral",
      "quirks": ["uses_bullet_points", "technical_jargon"],
      "expertise": ["finance", "market analysis"],
      "engagementStyle": "analyst"
    }'
  ); 