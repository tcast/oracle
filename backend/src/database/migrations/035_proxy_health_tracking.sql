-- Proxy health telemetry for NOC / burn protection

ALTER TABLE proxies
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS last_failure_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS last_health_check_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS last_health_ok BOOLEAN;

COMMENT ON COLUMN proxies.last_error IS 'Most recent failure reason (truncated)';
COMMENT ON COLUMN proxies.last_success_at IS 'Last successful use or health probe';
COMMENT ON COLUMN proxies.last_failure_at IS 'Last failed use or health probe';
COMMENT ON COLUMN proxies.last_health_check_at IS 'Last lightweight health probe time';
COMMENT ON COLUMN proxies.last_health_ok IS 'Result of last lightweight health probe';
