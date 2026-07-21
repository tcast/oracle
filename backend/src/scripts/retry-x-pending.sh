#!/bin/bash
set -u
LOG=/tmp/x-pending-retry.log
echo "RETRY START $(date -u)" | tee -a "$LOG"

docker exec whisper-db psql -U postgres -d whisper -c "
UPDATE proxies p SET cooldown_until=NULL, consecutive_failures=0, last_error=NULL, is_active=true
FROM social_account_proxies sap
JOIN social_accounts sa ON sa.id = sap.social_account_id
WHERE p.id = sap.proxy_id AND sa.id IN (649,658,664);
" >/dev/null

for id in 649 658 664; do
  echo "===== $(date -u +%H:%M:%S) account $id =====" | tee -a "$LOG"
  out=$(docker exec whisper-backend node src/scripts/smoke-x-cookie-session.js "$id" 2>&1) || true
  printf '%s\n' "$out" >> "$LOG"
  if printf '%s\n' "$out" | grep -qE '"challenge":"(rate_limit|challenge)"'; then
    echo "RATE id=$id — sleep 15m" | tee -a "$LOG"
    sleep 900
    continue
  fi
  if printf '%s\n' "$out" | grep -q '"success": true'; then
    echo "OK id=$id" | tee -a "$LOG"
  else
    echo "FAIL id=$id" | tee -a "$LOG"
  fi
  sleep 90
done

docker exec whisper-backend node src/scripts/enroll-x-organic.js 620 669 >> "$LOG" 2>&1 || true
echo "FINAL $(date -u)" | tee -a "$LOG"
