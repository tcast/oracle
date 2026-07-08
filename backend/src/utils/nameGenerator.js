/**
 * Generate realistic-looking usernames and email addresses
 * Creates natural combinations to avoid spam filters
 */

const FIRST_NAMES = [
  'alex', 'sarah', 'mike', 'emily', 'chris', 'jessica', 'david', 'ashley',
  'james', 'emma', 'john', 'sophia', 'robert', 'olivia', 'michael', 'ava',
  'william', 'isabella', 'daniel', 'mia', 'matthew', 'charlotte', 'joseph', 'amelia',
  'ryan', 'harper', 'andrew', 'evelyn', 'joshua', 'abigail', 'nathan', 'ella',
  'kevin', 'madison', 'brian', 'grace', 'thomas', 'lily', 'brandon', 'chloe',
  'jason', 'sofia', 'justin', 'victoria', 'jacob', 'hannah', 'tyler', 'zoe',
  'sam', 'natalie', 'ben', 'lucy', 'nick', 'stella', 'eric', 'maya',
  'adam', 'ruby', 'mark', 'violet', 'luke', 'aurora', 'henry', 'nova',
  'jack', 'willow', 'leo', 'hazel', 'owen', 'ivy', 'finn', 'rose'
];

const LAST_NAMES = [
  'smith', 'johnson', 'williams', 'brown', 'jones', 'garcia', 'miller', 'davis',
  'rodriguez', 'martinez', 'hernandez', 'lopez', 'gonzalez', 'wilson', 'anderson', 'thomas',
  'taylor', 'moore', 'jackson', 'martin', 'lee', 'thompson', 'white', 'harris',
  'clark', 'lewis', 'robinson', 'walker', 'young', 'hall', 'allen', 'king',
  'wright', 'scott', 'green', 'baker', 'adams', 'nelson', 'carter', 'mitchell',
  'parker', 'evans', 'edwards', 'collins', 'stewart', 'morris', 'murphy', 'cook',
  'morgan', 'bell', 'cooper', 'bailey', 'reed', 'kelly', 'howard', 'ward',
  'cox', 'peterson', 'gray', 'james', 'watson', 'brooks', 'sanders', 'price'
];

const SUFFIXES = [
  '', '', '', '', '', // Most don't have suffix (weighted)
  'tech', 'dev', 'pro', 'official', 'real', 'actual',
  '92', '93', '94', '95', '96', '97', '98', '99', '00', '01',
  '21', '22', '23', '24', '25',
  'online', 'mail', 'inbox'
];

const SEPARATORS = ['.', '_', ''];

/**
 * Generate a realistic-looking username
 * @param {string} style - 'professional', 'casual', 'tech', or 'random'
 * @returns {string} Generated username
 */
function generateRealisticUsername(style = 'random') {
  const firstName = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
  const lastName = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];

  // Always add a number suffix to ensure uniqueness
  const randomNum = Math.floor(Math.random() * 9000) + 1000; // 1000-9999
  const suffix = SUFFIXES[Math.floor(Math.random() * SUFFIXES.length)] || randomNum.toString();
  const separator = SEPARATORS[Math.floor(Math.random() * SEPARATORS.length)];

  let username;

  switch (style) {
    case 'professional':
      // firstname.lastname or firstname_lastname
      username = `${firstName}${separator}${lastName}`;
      break;

    case 'casual':
      // firstname + number or firstname_suffix
      const casualSep = Math.random() > 0.5 ? '.' : '_';
      username = suffix ?
        `${firstName}${casualSep}${suffix}` :
        `${firstName}${Math.floor(Math.random() * 9999)}`;
      break;

    case 'tech':
      // firstname.lastname.tech or similar
      username = `${firstName}${separator}${lastName}${separator}${suffix || 'dev'}`;
      break;

    case 'random':
    default:
      // Mix of all styles
      const rand = Math.random();
      if (rand < 0.4) {
        // firstname.lastname
        username = `${firstName}${separator}${lastName}`;
      } else if (rand < 0.7) {
        // firstname + suffix
        username = suffix ?
          `${firstName}${separator}${suffix}` :
          `${firstName}${Math.floor(Math.random() * 999)}`;
      } else {
        // firstname.lastname.suffix
        username = `${firstName}${separator}${lastName}${suffix ? separator + suffix : ''}`;
      }
      break;
  }

  // Clean up double separators
  username = username.replace(/\.{2,}/g, '.').replace(/_{2,}/g, '_');

  // Remove trailing/leading separators
  username = username.replace(/^[._]|[._]$/g, '');

  return username;
}

/**
 * Generate multiple unique usernames
 * @param {number} count - Number of usernames to generate
 * @param {string} style - Username style
 * @returns {Array<string>} Array of unique usernames
 */
function generateUniqueUsernames(count, style = 'random') {
  const usernames = new Set();

  while (usernames.size < count) {
    const username = generateRealisticUsername(style);
    usernames.add(username);
  }

  return Array.from(usernames);
}

/**
 * Generate realistic email address
 * @param {string} provider - Email provider ('yandex' or 'gmx')
 * @param {string} style - Username style
 * @returns {Object} { username, email, provider }
 */
function generateRealisticEmail(provider = 'yandex', style = 'random') {
  const username = generateRealisticUsername(style);

  const domain = provider === 'yandex' ? 'yandex.com' :
                 provider === 'gmx' ? 'gmx.com' :
                 provider === 'mail.com' ? 'mail.com' :
                 'yandex.com';

  return {
    username,
    email: `${username}@${domain}`,
    provider
  };
}

module.exports = {
  generateRealisticUsername,
  generateUniqueUsernames,
  generateRealisticEmail
};
