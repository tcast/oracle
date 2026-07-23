/**
 * Classify automation failures and compute quarantine cooldowns.
 * Keeps organic commenting from hammering blocked/bad accounts.
 */

function classifyFailure(message = '') {
  const msg = String(message || '').toLowerCase();

  if (
    /blocked by network security|network security|disable any extensions|different web browser|try using a different/i.test(msg) ||
    /username input not found after challenge/i.test(msg)
  ) {
    return 'security_block';
  }
  if (
    /incorrect username or password|wrong password|invalid username|invalid password|bad_credentials/i.test(msg) ||
    /login information you entered is incorrect|password was incorrect|sorry, your password/i.test(msg)
  ) {
    return 'bad_credentials';
  }
  // Tunnel / gateway flakes (Playwright net::ERR_* via residential proxy) — soft-skip, not ban.
  if (
    /err_http_response_code_failure|err_tunnel_connection_failed|err_ssl_protocol_error|err_connection_reset|err_connection_closed|err_connection_refused|err_connection_aborted/i.test(
      msg
    )
  ) {
    return 'tunnel_flake';
  }
  if (
    /err_tunnel|err_timed_out|err_proxy|tunnel_connection|proxy_error|err_socks|net::err_/i.test(msg) ||
    /\bproxy\b/i.test(msg)
  ) {
    return 'proxy_error';
  }
  if (
    /temporarily limited|try again later|maximum number of attempts|too many (attempts|tries)|rate.?limit/i.test(msg)
  ) {
    return 'challenge';
  }
  // Platform ban / suspension / deleted — terminal, distinct from dead cookies.
  if (
    /account_suspended|account is suspended|has been suspended|account.?banned|\bbanned\b/i.test(msg) ||
    /account doesn.?t exist|does not exist|this account doesn|user not found|deactivated/i.test(msg)
  ) {
    return 'banned';
  }
  // Dead cookies / missing live session — mark terminal so workers stop retrying.
  if (
    /session_not_logged_in|cookie_session_dead|session_dead|no_live_session/i.test(msg)
  ) {
    return 'session_dead';
  }
  if (/login failed/i.test(msg)) {
    return 'login_failed';
  }
  if (/captcha|challenge/i.test(msg)) {
    return 'challenge';
  }
  return 'other';
}

/** Transient proxy/tunnel classes — soft-skip, never session_dead / ban. */
function isTransientProxyFailure(failureClass) {
  return failureClass === 'proxy_error' || failureClass === 'tunnel_flake';
}

/**
 * Cooldown hours by class. Escalates with consecutive failures.
 * proxy_error / tunnel_flake use short soft-skip windows (see softSkipMinutes).
 */
function cooldownHoursFor(failureClass, consecutiveFailures = 1) {
  const n = Math.max(1, consecutiveFailures);
  const base = {
    security_block: 48,
    bad_credentials: 72,
    banned: 8760, // ~1 year — terminal until replaced
    session_dead: 8760, // ~1 year — terminal until replaced
    challenge: 24,
    proxy_error: 0.5, // 30m — soft; prefer softSkipMinutes for jitter
    tunnel_flake: 0.35, // ~21m
    login_failed: 12,
    other: 4,
  }[failureClass] || 4;

  // Escalate: 1x, 1.5x, 2x (capped)
  const factor = Math.min(2, 1 + (n - 1) * 0.5);
  return Math.round(base * factor * 100) / 100;
}

/** Soft-skip window in minutes for proxy/tunnel flakes (15–30m jitter). */
function softSkipMinutes(failureClass = 'proxy_error') {
  if (failureClass === 'tunnel_flake') {
    return 15 + Math.floor(Math.random() * 11); // 15–25m
  }
  return 15 + Math.floor(Math.random() * 16); // 15–30m
}

function cooldownUntil(failureClass, consecutiveFailures = 1, from = new Date()) {
  if (isTransientProxyFailure(failureClass)) {
    const mins = softSkipMinutes(failureClass);
    return new Date(from.getTime() + mins * 60 * 1000);
  }
  const hours = cooldownHoursFor(failureClass, consecutiveFailures);
  return new Date(from.getTime() + hours * 60 * 60 * 1000);
}

/** Extract a short http/proxy signal token for activity meta. */
function proxySignalFromMessage(message = '') {
  const msg = String(message || '');
  const m =
    msg.match(/net::ERR_[A-Z0-9_]+/i) ||
    msg.match(/ERR_[A-Z0-9_]+/i) ||
    msg.match(/ECONN[A-Z]+/i) ||
    msg.match(/ETIMEDOUT/i);
  return m ? m[0] : null;
}

module.exports = {
  classifyFailure,
  isTransientProxyFailure,
  cooldownHoursFor,
  softSkipMinutes,
  cooldownUntil,
  proxySignalFromMessage,
};
