/**
 * Format a date string to a more readable format
 * @param {string} dateString - Date string in ISO format (YYYY-MM-DD)
 * @returns {string} - Formatted date string
 */
export const formatDate = (dateString) => {
  if (!dateString) return '';
  
  const options = { 
    year: 'numeric', 
    month: 'short', 
    day: 'numeric',
    weekday: 'short'
  };
  
  try {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', options);
  } catch (error) {
    console.error('Error formatting date:', error);
    return dateString;
  }
};

/**
 * Format a number as currency
 * @param {number} value - Number to format
 * @param {string} currency - Currency code (default: USD)
 * @param {number} decimals - Number of decimal places (default: 2)
 * @returns {string} - Formatted currency string
 */
export const formatCurrency = (value, currency = 'USD', decimals = 2) => {
  if (value === null || value === undefined) return '';
  
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    }).format(value);
  } catch (error) {
    console.error('Error formatting currency:', error);
    return `${currency} ${value}`;
  }
};

/**
 * Format a number with thousands separators
 * @param {number} value - Number to format
 * @param {number} decimals - Number of decimal places (default: 0)
 * @returns {string} - Formatted number string
 */
export const formatNumber = (value, decimals = 0) => {
  if (value === null || value === undefined) return '';
  
  try {
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    }).format(value);
  } catch (error) {
    console.error('Error formatting number:', error);
    return `${value}`;
  }
};

/**
 * Format a percentage
 * @param {number} value - Number to format as percentage (0.1 = 10%)
 * @param {number} decimals - Number of decimal places (default: 2)
 * @returns {string} - Formatted percentage string
 */
export const formatPercentage = (value, decimals = 2) => {
  if (value === null || value === undefined) return '';
  
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'percent',
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    }).format(value);
  } catch (error) {
    console.error('Error formatting percentage:', error);
    return `${value * 100}%`;
  }
};

/**
 * Format a large number with abbreviations (K, M, B, T)
 * @param {number} value - Number to format
 * @param {number} decimals - Number of decimal places (default: 1)
 * @returns {string} - Formatted abbreviated number
 */
export const formatCompactNumber = (value, decimals = 1) => {
  if (value === null || value === undefined) return '';
  
  try {
    return new Intl.NumberFormat('en-US', {
      notation: 'compact',
      compactDisplay: 'short',
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    }).format(value);
  } catch (error) {
    console.error('Error formatting compact number:', error);
    return `${value}`;
  }
}; 