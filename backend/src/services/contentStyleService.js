const pool = require('./db');

class ContentStyleService {
  async getNetworkStyle(networkType, contentType) {
    try {
      const result = await pool.query(
        `SELECT ncs.* 
         FROM network_content_styles ncs
         JOIN social_networks sn ON ncs.network_id = sn.id
         WHERE sn.network_type = $1 AND ncs.content_type = $2`,
        [networkType, contentType]
      );
      
      return result.rows[0];
    } catch (error) {
      console.error('Error fetching network style:', error);
      throw error;
    }
  }

  generateBasePrompt(networkStyle, contentType, context) {
    const { tone_guidelines, structure_guidelines, purpose_guidelines } = networkStyle;

    if (contentType === 'post') {
      return this.generatePostPrompt(networkStyle, context);
    } else {
      return this.generateCommentPrompt(networkStyle, context);
    }
  }

  generatePostPrompt(networkStyle, context) {
    const { tone_guidelines = {}, structure_guidelines = {}, purpose_guidelines = {}, format_rules } = networkStyle || {};
    
    let prompt = `Write a ${tone_guidelines.style || 'natural'} post about this campaign overview:
${context.campaign_overview}

Campaign goal: ${context.campaign_goal}
Post goal: ${context.post_goal}

Tone:
${Object.entries(tone_guidelines).map(([key, value]) => `- ${key}: ${value}`).join('\n')}

Purpose:
${Object.entries(purpose_guidelines).map(([key, value]) => `- ${key}: ${value}`).join('\n')}

Format Rules:
${Array.isArray(format_rules) && format_rules.length > 0 
  ? format_rules.join('\n') 
  : '- Keep it natural and authentic'}`;

    // Add platform-specific structure guidelines
    if (context.platform === 'reddit') {
      const title = structure_guidelines.title || {};
      const body = structure_guidelines.body || {};
      const subreddit = context.subreddit || {};
      const contentRules = Array.isArray(subreddit.content_rules) ? subreddit.content_rules : [];
      
      prompt += `
- Title: Create a ${title.style || 'clear'} title${title.formats ? ` in one of these formats: ${title.formats.join(', ')}` : ''}
- Body: 
  * Include at least one personal perspective (using I, my, we, our)
  * Organize content into clear paragraphs
  * ${body.elements ? `Include all these elements: ${body.elements.join(', ')}` : 'Structure your thoughts logically'}

Subreddit-specific guidelines:
${contentRules.length > 0 
  ? contentRules.map(rule => `- ${rule}`).join('\n')
  : '- Follow general Reddit etiquette and be respectful of the community'}`;
    } else if (context.platform === 'linkedin') {
      const opening = structure_guidelines.opening || {};
      const body = structure_guidelines.body || {};
      const closing = structure_guidelines.closing || {};
      
      prompt += `
- Opening: Start with a ${opening.style || 'professional'} ${opening.elements ? opening.elements.join(' or ') : 'introduction'}
- Body:
  * Use clear paragraphs
  * Include specific examples or experiences
  * ${body.format ? `Format using ${body.format.join(' or ')}` : 'Use professional formatting'}
  * ${body.elements ? `Include all these elements: ${body.elements.join(', ')}` : 'Structure content professionally'}
- Closing: ${closing.type ? `End with a ${closing.type} using ${closing.elements ? closing.elements.join(' or ') : 'call to action'}` : 'End with a clear conclusion or call to action'}`;
    } else if (context.platform === 'x') {
      const tweet = structure_guidelines.tweet || {};
      
      prompt += `
- Tweet Structure:
  * Start with a ${tweet.opening || 'strong hook'}
  * Keep it under 280 characters
  * ${tweet.elements ? `Include these elements: ${tweet.elements.join(', ')}` : 'Make every character count'}
  * Use hashtags naturally: ${context.hashtags?.join(' ') || '#relevant #topics'}
  * ${tweet.media ? `Include media: ${tweet.media}` : 'Add media when relevant'}
  * End with a ${tweet.closing || 'clear call to action or thought-provoking point'}`;
    }

    prompt += `

Format Requirements:
${format_rules?.formatting_options ? format_rules.formatting_options.map(format => {
  switch(format) {
    case 'bullet_points': return '- If using bullet points, each must be on a new line starting with •';
    case 'paragraphs': return '- Separate distinct ideas into paragraphs with blank lines between them';
    case 'links': return '- Format any links using markdown: [text](url)';
    default: return '';
  }
}).filter(Boolean).join('\n') : '- Use clear, readable formatting'}

Important: Your response MUST follow all these requirements exactly. Do not skip any requirements.`;

    return prompt;
  }

  generateCommentPrompt(networkStyle, context) {
    const { tone_guidelines = {}, structure_guidelines = {}, purpose_guidelines = {}, format_rules } = networkStyle || {};
    
    let prompt = `Create a ${tone_guidelines.style || 'natural'} comment in the context of this campaign:
${context.campaign_overview}

Campaign goal: ${context.campaign_goal}
Comment goal: ${context.comment_goal}

Content Requirements:
${structure_guidelines.length ? `- Keep the comment ${structure_guidelines.length} in length` : 
 structure_guidelines.length_range ? `- Keep the comment ${structure_guidelines.length_range.join(' to ')} in length` : 
 '- Use a natural length'}

Tone Requirements:
${tone_guidelines.style === 'professional' ? 
  '- Use professional language and industry terminology\n- Maintain formal tone' :
 tone_guidelines.style === 'casual' ? 
  '- Use conversational language\n- Feel free to use common expressions' :
  '- Use a natural, engaging tone'}
- Include ${tone_guidelines.personal_elements ? tone_guidelines.personal_elements.join(' and ') : 'authentic perspective'}

Structure Requirements:
${structure_guidelines.elements ? `- Include all these elements: ${structure_guidelines.elements.join(', ')}` : ''}
${structure_guidelines.structure ? `- Follow this structure: ${structure_guidelines.structure.join(' → ')}` : ''}
- Start with a direct response or acknowledgment
- Include personal experience or expertise
- End with engagement (question or discussion point)

Format Requirements:
- Use clear paragraph breaks between ideas
- If quoting the post, use proper quote formatting
- If using bullet points, format them properly

Purpose:
${purpose_guidelines.primary_purposes ? `Primary goals: ${purpose_guidelines.primary_purposes.join(', ')}` : 'Engage meaningfully'}
${purpose_guidelines.interaction_types ? `\nInteraction types: ${purpose_guidelines.interaction_types.join(', ')}` : ''}
${purpose_guidelines.engagement_types ? `\nEngagement approach: ${purpose_guidelines.engagement_types.join(', ')}` : ''}

Important: Your response MUST follow all these requirements exactly. Do not skip any requirements.`;

    return prompt;
  }

  combineWithPersona(basePrompt, persona) {
    return `${basePrompt}

Now, adapt this base style with your unique persona traits:
${persona}

The final content should blend the platform's base style requirements with your unique personality traits.`;
  }

  validateContentStyle(content, networkStyle) {
    const { tone_guidelines, structure_guidelines, format_rules } = networkStyle;
    const validationResults = [];

    // Length validation
    const wordCount = content.split(/\s+/).length;
    if (structure_guidelines.length === 'short' && wordCount > 100) {
      validationResults.push('Content is too long for short format');
    } else if (structure_guidelines.length === 'medium' && (wordCount < 50 || wordCount > 300)) {
      validationResults.push('Content length should be between 50-300 words for medium format');
    } else if (structure_guidelines.length === 'long' && wordCount < 200) {
      validationResults.push('Content is too short for long format');
    }

    // Structure validation
    if (structure_guidelines.elements) {
      for (const element of structure_guidelines.elements) {
        switch (element) {
          case 'personal_anecdotes':
            if (!content.match(/I|my|me|we|our/i)) {
              validationResults.push('Missing personal perspective');
            }
            break;
          case 'direct_responses':
            if (!content.match(/^(You|Your|I agree|Good point|Thanks|Interesting)/i)) {
              validationResults.push('Should start with a direct response');
            }
            break;
          case 'quotes':
            if (content.includes('>') && !content.match(/>.+\n/)) {
              validationResults.push('Quotes should be properly formatted');
            }
            break;
        }
      }
    }

    // Tone validation
    if (tone_guidelines.style) {
      const tonalWords = {
        professional: ['expertise', 'experience', 'industry', 'professional', 'career'],
        casual: ['hey', 'cool', 'awesome', 'yeah', 'tbh'],
        conversational: ['think', 'feel', 'seems', 'maybe', 'probably']
      };

      const style = tone_guidelines.style.toLowerCase();
      if (tonalWords[style]) {
        const hasMatchingTone = tonalWords[style].some(word => 
          content.toLowerCase().includes(word)
        );
        if (!hasMatchingTone) {
          validationResults.push(`Content tone doesn't match ${style} style`);
        }
      }
    }

    // Format validation
    if (format_rules?.formatting_options) {
      for (const format of format_rules.formatting_options) {
        switch (format) {
          case 'bullet_points':
            if (content.includes('•') && !content.match(/•.+\n/)) {
              validationResults.push('Bullet points should be properly formatted');
            }
            break;
          case 'paragraphs':
            if (!content.includes('\n\n')) {
              validationResults.push('Content should be organized in paragraphs');
            }
            break;
          case 'links':
            if (content.includes('http') && !content.match(/\[.+\]\(.+\)/)) {
              validationResults.push('Links should use markdown format');
            }
            break;
        }
      }
    }

    // Grammar and clarity validation
    if (format_rules?.style_rules) {
      const { grammar, clarity } = format_rules.style_rules;
      
      if (grammar === 'professional') {
        const unprofessionalPatterns = /gonna|wanna|dunno|idk|tbh/i;
        if (unprofessionalPatterns.test(content)) {
          validationResults.push('Grammar should maintain professional standards');
        }
      }

      if (clarity === 'required') {
        const unclearPatterns = /(?:^|\s)(?:it|this|that|they)\s(?![\w\s]*(?:is|are|was|were))/i;
        if (unclearPatterns.test(content)) {
          validationResults.push('Content should use clear, specific references');
        }
      }
    }

    // Log validation results for debugging
    if (validationResults.length > 0) {
      console.log('Content validation failed:', validationResults);
      return false;
    }

    return true;
  }
}

module.exports = new ContentStyleService(); 