const crypto = require('crypto');

function generatePassword(length = 16) {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;:,.<>?';
  let password = '';
  
  // Ensure at least one of each required character type
  password += getRandomChar('ABCDEFGHIJKLMNOPQRSTUVWXYZ'); // uppercase
  password += getRandomChar('abcdefghijklmnopqrstuvwxyz'); // lowercase
  password += getRandomChar('0123456789'); // number
  password += getRandomChar('!@#$%^&*()_+-=[]{}|;:,.<>?'); // special char
  
  // Fill the rest with random characters
  while (password.length < length) {
    password += getRandomChar(charset);
  }
  
  // Shuffle the password
  return shuffleString(password);
}

function getRandomChar(charset) {
  const randomBytes = crypto.randomBytes(1);
  return charset[randomBytes[0] % charset.length];
}

function shuffleString(str) {
  const array = str.split('');
  for (let i = array.length - 1; i > 0; i--) {
    const j = crypto.randomBytes(1)[0] % (i + 1);
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array.join('');
}

module.exports = {
  generatePassword
}; 