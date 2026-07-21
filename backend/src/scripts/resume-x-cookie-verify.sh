#!/bin/bash
# Resume cookie-session smoke for remaining X accounts with long gaps.
# Usage: bash resume-x-cookie-verify.sh [accountId ...]
set -u
LOG=/tmp/x-cookie-verify-resume.log
IDS="${*:-}"
if [ -z "$IDS" ]; then
  echo "Usage: $0 <accountId> [accountId...]"
  exit 1
fi
ok=0
fail=0
echo "RESUME START $(date -u) IDS=$IDS" | tee -a "$LOG"
for id in $IDS; do
  echo "===== $(date -u +%H:%M:%S) account $id =====" | tee -a "$LOG"
  out=$(docker exec whisper-backend node src/scripts/smoke-x-cookie-session.js "$id" 2>&1) || true
  printf '%s\n' "$out" >> "$LOG"
  if printf '%s\n' "$out" | grep -qE '"challenge":"(rate_limit|challenge)"'; then
    echo "RATE_LIMIT id=$id — sleeping 15m then continuing" | tee -a "$LOG"
    fail=$((fail + 1))
    sleep 900
    continue
  fi
  if printf '%s\n' "$out" | grep -q '"success": true'; then
    ok=$((ok + 1))
    echo "OK id=$id" | tee -a "$LOG"
  else
    fail=$((fail + 1))
    echo "FAIL id=$id" | tee -a "$LOG"
  fi
  sleep $((75 + RANDOM % 45))
done
echo "FINAL ok=$ok fail=$fail $(date -u)" | tee -a "$LOG"
