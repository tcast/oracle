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
  if (/err_tunnel|err_timed_out|err_proxy|tunnel_connection|proxy|net::err_/i.test(msg)) {
    return 'proxy_error';
  }
  if (
    /temporarily limited|try again later|maximum number of attempts|too many (attempts|tries)|rate.?limit/i.test(msg)
  ) {
    return 'challenge';
  }
  // Cookie dumps cannot be refreshed — treat as terminal, not a retryable login miss.
  if (/no_live_session|session_not_logged_in|cookie_session_dead|session_dead/i.test(msg)) {
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

/**
 * Cooldown hours by class. Escalates with consecutive failures.
 */
function cooldownHoursFor(failureClass, consecutiveFailures = 1) {
  const n = Math.max(1, consecutiveFailures);
  const base = {
    security_block: 48,
    bad_credentials: 72,
    session_dead: 8760, // ~1 year — terminal until replaced
    challenge: 24,
    proxy_error: 6,
    login_failed: 12,
    other: 4,
  }[failureClass] || 4;

  // Escalate: 1x, 1.5x, 2x (capped)
  const factor = Math.min(2, 1 + (n - 1) * 0.5);
  return Math.round(base * factor);
}

function cooldownUntil(failureClass, consecutiveFailures = 1, from = new Date()) {
  const hours = cooldownHoursFor(failureClass, consecutiveFailures);
  return new Date(from.getTime() + hours * 60 * 60 * 1000);
}

module.exports = {
  classifyFailure,
  cooldownHoursFor,
  cooldownUntil,
};
