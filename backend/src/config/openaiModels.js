/** Default model for campaign generation (posts, comments, personas, learnings). */
const GENERATION_MODEL = 'gpt-5.3-chat-latest';

/**
 * GPT-5.x chat completions often reject non-default sampling knobs.
 * Strip them so callers can still pass legacy options safely.
 */
function generationCompletionOptions(extra = {}) {
  const { temperature, presence_penalty, frequency_penalty, top_p, ...rest } = extra;
  return {
    model: GENERATION_MODEL,
    ...rest,
  };
}

module.exports = { GENERATION_MODEL, generationCompletionOptions };
