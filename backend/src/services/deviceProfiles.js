/**
 * Sticky device fingerprints — mix Android mobile + desktop so the fleet
 * does not share one Chromium desktop fingerprint.
 *
 * Important: profile is sticky per account (stored on social_accounts.device_profile).
 * Flipping Android ↔ desktop between sessions is worse than a stable spoof.
 *
 * Caveat: desktop Chromium with a mobile UA is imperfect vs a real Android
 * browser; Camoufox remains the escalation path if Reddit keeps blocking.
 */

const ANDROID_PROFILES = [
  {
    label: 'pixel-7-chrome',
    platform: 'android',
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2.625,
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.113 Mobile Safari/537.36',
    viewport: { width: 412, height: 915 },
    screen: { width: 412, height: 915, availWidth: 412, availHeight: 915, colorDepth: 24, pixelDepth: 24 },
    maxTouchPoints: 5,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    webglVendor: 'Qualcomm',
    webglRenderer: 'Adreno (TM) 730',
  },
  {
    label: 'pixel-8-chrome',
    platform: 'android',
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2.625,
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.179 Mobile Safari/537.36',
    viewport: { width: 412, height: 915 },
    screen: { width: 412, height: 915, availWidth: 412, availHeight: 915, colorDepth: 24, pixelDepth: 24 },
    maxTouchPoints: 5,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    webglVendor: 'Qualcomm',
    webglRenderer: 'Adreno (TM) 740',
  },
  {
    label: 'galaxy-s23-chrome',
    platform: 'android',
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; SM-S911U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.113 Mobile Safari/537.36',
    viewport: { width: 360, height: 780 },
    screen: { width: 360, height: 780, availWidth: 360, availHeight: 780, colorDepth: 24, pixelDepth: 24 },
    maxTouchPoints: 5,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    webglVendor: 'Qualcomm',
    webglRenderer: 'Adreno (TM) 740',
  },
  {
    label: 'galaxy-a54-chrome',
    platform: 'android',
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2.625,
    userAgent:
      'Mozilla/5.0 (Linux; Android 13; SM-A546U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.113 Mobile Safari/537.36',
    viewport: { width: 384, height: 854 },
    screen: { width: 384, height: 854, availWidth: 384, availHeight: 854, colorDepth: 24, pixelDepth: 24 },
    maxTouchPoints: 5,
    hardwareConcurrency: 8,
    deviceMemory: 6,
    webglVendor: 'ARM',
    webglRenderer: 'Mali-G68',
  },
];

const DESKTOP_PROFILES = [
  {
    label: 'win-chrome-125',
    platform: 'desktop',
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 1,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    screen: { width: 1366, height: 768, availWidth: 1366, availHeight: 728, colorDepth: 24, pixelDepth: 24 },
    maxTouchPoints: 0,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    webglVendor: 'Google Inc. (NVIDIA)',
    webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0)',
  },
  {
    label: 'win-chrome-124',
    platform: 'desktop',
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 1,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1536, height: 864 },
    screen: { width: 1536, height: 864, availWidth: 1536, availHeight: 824, colorDepth: 24, pixelDepth: 24 },
    maxTouchPoints: 0,
    hardwareConcurrency: 4,
    deviceMemory: 8,
    webglVendor: 'Google Inc. (Intel)',
    webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0)',
  },
  {
    label: 'mac-chrome-125',
    platform: 'desktop',
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 2,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    screen: { width: 1440, height: 900, availWidth: 1440, availHeight: 875, colorDepth: 24, pixelDepth: 24 },
    maxTouchPoints: 0,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    webglVendor: 'Google Inc. (Apple)',
    webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
  },
  {
    label: 'mac-safari',
    platform: 'desktop',
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 2,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    viewport: { width: 1280, height: 800 },
    screen: { width: 1280, height: 800, availWidth: 1280, availHeight: 775, colorDepth: 24, pixelDepth: 24 },
    maxTouchPoints: 0,
    hardwareConcurrency: 8,
    deviceMemory: 16,
    webglVendor: 'Apple Inc.',
    webglRenderer: 'Apple M1',
  },
];

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Prefer Android when proxy looks mobile (ProxyBase sticky mobile pools).
 * Otherwise ~55% Android / 45% desktop so the fleet is mixed.
 */
function pickProfileTemplate({ preferMobile = false } = {}) {
  if (preferMobile) return pickRandom(ANDROID_PROFILES);
  return Math.random() < 0.55 ? pickRandom(ANDROID_PROFILES) : pickRandom(DESKTOP_PROFILES);
}

function buildStickyProfile({ preferMobile = false } = {}) {
  const base = pickProfileTemplate({ preferMobile });
  return {
    ...base,
    timezoneId: pickRandom(TIMEZONES),
    locale: 'en-US',
    assignedAt: new Date().toISOString(),
  };
}

module.exports = {
  ANDROID_PROFILES,
  DESKTOP_PROFILES,
  pickProfileTemplate,
  buildStickyProfile,
};
