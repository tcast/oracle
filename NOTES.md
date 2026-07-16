# Whisper — engineering notes / backlog

## Browser stealth (Camoufox)
- **Trigger:** only pursue if Reddit (or other targets) start flagging our Chromium automation as a bot and we cannot get around it with session reuse, proxies, delays, and selector fixes.
- **Option:** [Camoufox](https://github.com/daijro/camoufox) — Firefox fork with C++ engine-level fingerprint spoofing (no JS injection), Playwright-compatible API. Strongest in Python; JS port (`camoufox-js`) is thinner.
- **Plan if needed:** pilot on 1–3 accounts (login + comment) with Chromium as fallback; do not migrate the whole `playwrightService` stack at once. Note: 2026 Camoufox builds are experimental/recovering from a maintenance gap.
- **Not a fix for:** bad/expired logins, captchas, banned accounts, proxy IP reputation, or Reddit UI/selector churn.

## Scheduling/orchestration (learn from Postiz)
- [Postiz](https://github.com/gitroomhq/postiz-app) is API/OAuth-based compliant posting (explicitly no scraping/automation), so not a drop-in for our stealth organic-commenting model.
- Worth borrowing:
  - **Durable job orchestration** (Postiz uses Temporal; formerly BullMQ) instead of our in-process `setTimeout` schedulers, which lose state on restart. Would make organic + nightly audit survive crashes/reboots.
  - **Abstract provider pattern** for multi-network posting (we have `platformHandlers`; could formalize).
  - **Visual content calendar + analytics** UI ideas.
