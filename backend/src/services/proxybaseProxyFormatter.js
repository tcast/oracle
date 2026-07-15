/**
 * ProxyBase sticky session formatter / URL parser.
 * Format:
 *   http://{user}-sticky={id}-time=1w-type={mobile|residential}:{password}@proxy.proxybase.org:1081
 */

const DEFAULT_HOST = 'proxy.proxybase.org';
const DEFAULT_PORT = 1081;

function parseProxyUrl(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return null;

  const match = trimmed.match(
    /^(https?):\/\/([^:]+):([^@]+)@([^:\/]+):(\d+)$/i
  );
  if (!match) {
    throw new Error(`Unrecognized ProxyBase URL: ${trimmed}`);
  }

  const [, protocol, username, password, host, port] = match;
  const stickyMatch = username.match(/-sticky=([A-Za-z0-9]{10})(?:-|$)/);
  const typeMatch = username.match(/-type=(mobile|residential)(?:-|$)/i);
  const timeMatch = username.match(/-time=([0-9]+[wdhms])(?:-|$)/i);
  const sessionType = (typeMatch?.[1] || 'residential').toLowerCase();
  const stickyId = stickyMatch?.[1] || null;

  return {
    name: stickyId
      ? `ProxyBase ${sessionType} ${stickyId}`
      : `ProxyBase ${username.slice(0, 12)}`,
    type: protocol.toLowerCase() === 'https' ? 'https' : 'http',
    server: `${host}:${port}`,
    username,
    password,
    country: null,
    city: null,
    provider: 'ProxyBase',
    is_residential: sessionType === 'residential' || sessionType === 'mobile',
    metadata: {
      provider: 'ProxyBase',
      sticky_id: stickyId,
      sticky_time: timeMatch?.[1] || null,
      session_type: sessionType,
      host,
      port: Number(port),
    },
  };
}

function buildStickyUsername(baseUsername, stickyId, {
  time = '1w',
  sessionType = 'residential',
} = {}) {
  if (!/^[A-Za-z0-9]{10}$/.test(stickyId)) {
    throw new Error('stickyId must be exactly 10 alphanumeric characters');
  }
  return `${baseUsername}-sticky=${stickyId}-time=${time}-type=${sessionType}`;
}

function buildProxyUrl({
  baseUsername,
  password,
  stickyId,
  time = '1w',
  sessionType = 'residential',
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
}) {
  const username = buildStickyUsername(baseUsername, stickyId, { time, sessionType });
  return `http://${username}:${password}@${host}:${port}`;
}

function parseProxyList(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map(parseProxyUrl);
}

function randomStickyId(length = 10) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  parseProxyUrl,
  parseProxyList,
  buildStickyUsername,
  buildProxyUrl,
  randomStickyId,
};
