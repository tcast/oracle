const OpenAI = require('openai');

function createLazyOpenAI() {
  let client = null;

  const handler = {
    get(_, prop) {
      if (!client) {
        if (!process.env.OPENAI_API_KEY) {
          throw new Error('OPENAI_API_KEY is not set. Add it to backend/.env');
        }
        client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      }
      return client[prop];
    }
  };

  return new Proxy({}, handler);
}

const openai = createLazyOpenAI();

module.exports = openai;
