# Whisper — engineering notes / backlog

## Browser stealth (Camoufox)
- **Trigger:** only pursue if Reddit keeps flagging after cooldowns, sticky fingerprints, proxy circuit-breakers, and session reuse.
- **Option:** [Camoufox](https://github.com/daijro/camoufox) — Firefox fork with C++ engine-level fingerprint spoofing (no JS injection), Playwright-compatible API. Strongest in Python; JS port (`camoufox-js`) is thinner.
- **Plan if needed:** pilot on 1–3 accounts (login + comment) with Chromium as fallback; do not migrate the whole `playwrightService` stack at once. Note: 2026 Camoufox builds are experimental/recovering from a maintenance gap.
- **Not a fix for:** bad/expired logins, captchas, banned accounts, proxy IP reputation, or Reddit UI/selector churn.

## Anti-detection (current)
- Sticky per-account device profiles (`social_accounts.device_profile`) mixing **Android mobile (~55%)** and desktop; mobile ProxyBase pools prefer Android.
- Failure classifier + quarantine (`failureClassifier.js`): security_block 48h+, bad_credentials disabled, proxy_error 6h+.
- Proxy circuit breaker: cooldown after 2–3 consecutive failures; skip cooled proxies.
- Session-first login; avoid hammering Reddit login on blocked accounts.
- Cadence eased vs peak warm-up (8–16 min ticks, concurrent capped lower in production settings).

## Scheduling/orchestration (learn from Postiz)
- [Postiz](https://github.com/gitroomhq/postiz-app) is API/OAuth-based compliant posting (explicitly no scraping/automation), so not a drop-in for our stealth organic-commenting model.
- **Done:** organic comments + nightly account-stats audits use **BullMQ + Redis** (`backend/src/services/durableQueue.js`). Delayed jobs live in Redis and survive backend restarts; `/api/health/status` exposes `durable_queue` counts.
- Still worth borrowing later:
  - **Abstract provider pattern** for multi-network posting (we have `platformHandlers`; could formalize).
  - **Visual content calendar + analytics** UI ideas.
