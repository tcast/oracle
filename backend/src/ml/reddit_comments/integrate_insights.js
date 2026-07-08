/**
 * Script to integrate Reddit comment analysis insights into the comment generation system.
 */

const fs = require('fs');
const path = require('path');

// Paths
const RESULTS_DIR = path.join(__dirname, 'results');
const INSIGHTS_FILE = path.join(RESULTS_DIR, 'comment_generation_insights.json');
const TEMPLATES_FILE = path.join(RESULTS_DIR, 'comment_templates.json');
const COMMENT_SERVICE_PATH = path.join(__dirname, '..', '..', 'services', 'commentingService.js');

/**
 * Read the insights from the analysis results
 */
function readInsights() {
  try {
    if (!fs.existsSync(INSIGHTS_FILE)) {
      console.error(`Insights file not found: ${INSIGHTS_FILE}`);
      console.error('Please run the analyze_comments.py script first.');
      process.exit(1);
    }

    const insightsData = fs.readFileSync(INSIGHTS_FILE, 'utf8');
    return JSON.parse(insightsData);
  } catch (error) {
    console.error('Error reading insights file:', error);
    process.exit(1);
  }
}

/**
 * Read the comment templates from the analysis results
 */
function readTemplates() {
  try {
    if (!fs.existsSync(TEMPLATES_FILE)) {
      console.error(`Templates file not found: ${TEMPLATES_FILE}`);
      console.error('Please run the analyze_comments.py script first.');
      process.exit(1);
    }

    const templatesData = fs.readFileSync(TEMPLATES_FILE, 'utf8');
    return JSON.parse(templatesData);
  } catch (error) {
    console.error('Error reading templates file:', error);
    process.exit(1);
  }
}

/**
 * Read the commenting service file
 */
function readCommentingService() {
  try {
    if (!fs.existsSync(COMMENT_SERVICE_PATH)) {
      console.error(`Commenting service file not found: ${COMMENT_SERVICE_PATH}`);
      process.exit(1);
    }

    return fs.readFileSync(COMMENT_SERVICE_PATH, 'utf8');
  } catch (error) {
    console.error('Error reading commenting service file:', error);
    process.exit(1);
  }
}

/**
 * Update the platform handlers with insights from the analysis
 */
function updatePlatformHandlers(serviceCode, insights, templates) {
  console.log('Updating platform handlers with insights...');

  // Extract key insights
  const {
    optimal_comment_length,
    engagement_elements
  } = insights.recommendations;

  // Get top templates (limit to 10)
  const topTemplates = Object.keys(templates).slice(0, 10);

  // Create updated writing style rules based on insights
  const updatedWritingStyleRules = `
1. Keep your writing style simple and concise
2. Use clear and straightforward language
3. Write short, impactful sentences
4. Add frequent line breaks to separate ideas
5. Use active voice and avoid passive construction
6. ${engagement_elements.use_questions ? 'Include thoughtful questions to engage the reader' : 'Focus on making statements rather than asking questions'}
7. Address the reader directly with "you" and "your"
8. Stay clear of introductory phrases like "in conclusion" and "in summary"
9. Do not include unnecessary extras
10. Get straight to the point - no introductory statements
11. Aim for about ${optimal_comment_length.words} words and ${optimal_comment_length.sentences} sentences
12. DO NOT use hashtags in your comment`;

  // Create updated quick guidelines based on insights
  const updatedQuickGuidelines = `
1. Get straight to your point - no greetings or introductions
2. Keep it around ${optimal_comment_length.words} words
3. React to one specific point from the post
4. ${engagement_elements.use_emojis ? 'Use emojis sparingly if it fits your persona' : 'Avoid using emojis unless it\'s essential to your persona'}
5. ${engagement_elements.use_exclamations ? 'Use exclamation marks to show enthusiasm when appropriate' : 'Limit exclamation marks to avoid appearing overly excited'}`;

  // Update Reddit handler
  let updatedCode = serviceCode.replace(
    /(buildPrompt: \(post, campaign, account\) => \{\s*const traits = account\.persona_traits \|\| \{\};\s*return `Read this Reddit post and write a brief, \${traits\.tone \|\| 'natural'} comment:[^`]*Writing Style Rules:[^`]*?)(\d+\. .*?)(\s*Quick guidelines:[^`]*?)(\d+\. .*?)(\s*Write like you're in the middle of a conversation)/s,
    `$1${updatedWritingStyleRules}$3${updatedQuickGuidelines}$5`
  );

  // Update LinkedIn handler
  updatedCode = updatedCode.replace(
    /(buildPrompt: \(post, campaign, account\) => \{\s*const traits = account\.persona_traits \|\| \{\};\s*return `Read this LinkedIn post and write a brief, \${traits\.tone \|\| 'professional'} comment:[^`]*Writing Style Rules:[^`]*?)(\d+\. .*?)(\s*Quick guidelines:[^`]*?)(\d+\. .*?)(\s*Write like you're continuing an ongoing professional discussion)/s,
    `$1${updatedWritingStyleRules}$3${updatedQuickGuidelines}$5`
  );

  // Update X (Twitter) handler
  updatedCode = updatedCode.replace(
    /(buildPrompt: \(post, campaign, account\) => \{\s*const traits = account\.persona_traits \|\| \{\};\s*return `Read this X \(Twitter\) post and write a brief, \${traits\.tone \|\| 'engaging'} reply:[^`]*Writing Style Rules:[^`]*?)(\d+\. .*?)(\s*Quick guidelines:[^`]*?)(\d+\. .*?)(\s*Write like you're in the middle of a Twitter thread)/s,
    `$1${updatedWritingStyleRules}$3${updatedQuickGuidelines}$5`
  );

  // Update TikTok handler
  updatedCode = updatedCode.replace(
    /(buildPrompt: \(post, campaign, account\) => \{\s*const traits = account\.persona_traits \|\| \{\};\s*return `Read this TikTok post and write a brief, \${traits\.tone \|\| 'engaging'} comment:[^`]*Writing Style Rules:[^`]*?)(\d+\. .*?)(\s*Quick guidelines:[^`]*?)(\d+\. .*?)(\s*Write like you're commenting on a TikTok)/s,
    `$1${updatedWritingStyleRules}$3${updatedQuickGuidelines}$5`
  );

  // Add template suggestions to the generateComment method
  const templateSuggestions = `
// Add template suggestions based on Reddit analysis
const templateSuggestions = \`
EFFECTIVE COMMENT STRUCTURES:
Consider using one of these proven comment structures:
${topTemplates.map((template, i) => `${i + 1}. ${template}`).join('\n')}

Remember to adapt these structures to your unique persona and the specific content.
\`;`;

  // Update the generateComment method to include template suggestions
  updatedCode = updatedCode.replace(
    /(async generateComment\(post, campaign, account\) \{\s*try \{[^]*?const finalPrompt = contentStyleService\.combineWithPersona\(basePrompt, persona\);)/,
    `$1\n${templateSuggestions}`
  );

  // Add the template suggestions to the diversity instructions
  updatedCode = updatedCode.replace(
    /(const diversityInstructions = `[^]*?Your writing style and tone)/,
    `$1\n\n${templateSuggestions}`
  );

  return updatedCode;
}

/**
 * Update the OpenAI parameters based on insights
 */
function updateOpenAIParameters(serviceCode, insights) {
  console.log('Updating OpenAI parameters based on insights...');

  // Extract key insights for parameter tuning
  const { high_score_stats } = insights;
  
  // Adjust temperature based on diversity needs
  // Higher temperature for more creative/diverse outputs
  const temperature = 1.2;
  
  // Adjust presence_penalty based on repetition patterns
  // Higher values prevent repetition
  const presencePenalty = 1.5;
  
  // Adjust frequency_penalty based on vocabulary diversity
  // Higher values encourage more diverse vocabulary
  const frequencyPenalty = 1.5;
  
  // Update the OpenAI parameters in the generateComment method
  const updatedCode = serviceCode.replace(
    /(const completion = await openai\.createChatCompletion\(\{\s*model: "gpt-4o",\s*messages: \[[^\]]*\],\s*temperature: )(\d+\.\d+)(,\s*presence_penalty: )(\d+\.\d+)(,\s*frequency_penalty: )(\d+\.\d+)(,\s*top_p: )(\d+\.\d+)/,
    `$1${temperature}$3${presencePenalty}$5${frequencyPenalty}$7${0.95}`
  );

  return updatedCode;
}

/**
 * Save the updated commenting service file
 */
function saveUpdatedService(updatedCode) {
  try {
    // Create a backup of the original file
    const backupPath = `${COMMENT_SERVICE_PATH}.bak`;
    fs.copyFileSync(COMMENT_SERVICE_PATH, backupPath);
    console.log(`Original file backed up to: ${backupPath}`);

    // Write the updated code
    fs.writeFileSync(COMMENT_SERVICE_PATH, updatedCode);
    console.log(`Updated commenting service saved to: ${COMMENT_SERVICE_PATH}`);
  } catch (error) {
    console.error('Error saving updated service:', error);
    process.exit(1);
  }
}

/**
 * Main function to integrate insights
 */
function main() {
  console.log('Integrating Reddit comment analysis insights...');

  // Read insights and templates
  const insights = readInsights();
  const templates = readTemplates();

  // Read the commenting service code
  const serviceCode = readCommentingService();

  // Update platform handlers with insights
  let updatedCode = updatePlatformHandlers(serviceCode, insights, templates);

  // Update OpenAI parameters
  updatedCode = updateOpenAIParameters(updatedCode, insights);

  // Save the updated service
  saveUpdatedService(updatedCode);

  console.log('\nIntegration complete!');
  console.log('The commenting service has been updated with insights from Reddit comment analysis.');
  console.log('Key changes:');
  console.log(`- Optimal comment length: ${insights.recommendations.optimal_comment_length.words} words, ${insights.recommendations.optimal_comment_length.sentences} sentences`);
  console.log(`- Use questions: ${insights.recommendations.engagement_elements.use_questions ? 'Yes' : 'No'}`);
  console.log(`- Use exclamations: ${insights.recommendations.engagement_elements.use_exclamations ? 'Yes' : 'No'}`);
  console.log(`- Use emojis: ${insights.recommendations.engagement_elements.use_emojis ? 'Yes' : 'No'}`);
  console.log(`- Avoid hashtags: ${insights.recommendations.engagement_elements.avoid_hashtags ? 'Yes' : 'No'}`);
  console.log('- Added top 10 effective comment templates');
  console.log('- Optimized OpenAI parameters for better diversity');
}

// Run the main function
main();