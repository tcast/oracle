# Whisper — engineering notes / backlog

## Browser stealth (Camoufox)
- **Trigger:** only pursue if Reddit keeps flagging after cooldowns, sticky fingerprints, proxy circuit-breakers, and session reuse.
- **Option:** [Camoufox](https://github.com/daijro/camoufox) — Firefox fork with C++ engine-level fingerprint spoofing (no JS injection), Playwright-compatible API. Strongest in Python; JS port (`camoufox-js`) is thinner.
- **Plan if needed:** pilot on 1–3 accounts (login + comment) with Chromium as fallback; do not migrate the whole `playwrightService` stack at once. Note: 2026 Camoufox builds are experimental/recovering from a maintenance gap.
- **Not a fix for:** bad/expired logins, captchas, banned accounts, proxy IP reputation, or Reddit UI/selector churn.

### Camoufox integration (done — additive, opt-in)
- `playwrightService.createBrowser()` now dispatches to `createCamoufoxBrowser()` when
  `BROWSER_ENGINE=camoufox`. Default stays `chromium`, so the 163 organic Reddit
  accounts and every other caller are untouched. The Camoufox path returns the same
  `{ browser, context, page, ... }` shape, so `xLogin`, `persistSession`,
  `verifySessionAlive`, etc. all work on the Playwright Page unchanged.
- **Approach chosen:** `camoufox-js` (`launchOptions()` + `firefox.launch()`), all in Node,
  no Python sidecar. Uses `geoip: true` so locale/timezone/WebRTC/geolocation are derived
  from the proxy exit IP (per-account fingerprint consistency). `camoufox-js` added to
  `backend/package.json`.
- **Production viability:** the prod image is `node:18-alpine`. Camoufox needs **Node ≥ 20 +
  glibc** and a fetched Camoufox binary — it will NOT run in Alpine/Node18. The code is
  committed and safe (opt-in, Chromium default preserved) but Camoufox is a **host/pilot-only
  path** today. To productionize, add a glibc Node 20+ service (or a dedicated Camoufox image
  with `npx camoufox-js fetch` + `playwright install-deps firefox`) and set
  `BROWSER_ENGINE=camoufox` there.
- **How the pilot ran:** dedicated `node:22-bookworm` container on the `whisper_default`
  network (`/home/tcast/camoufox-pilot`), Camoufox binary fetched, DB via `postgres` host.
  Pilot script: `backend/src/scripts/pilot-x-camoufox-login.js` (one account, one attempt,
  stops on rate-limit, live TOTP).

### Camoufox X login pilot — #589 alexandra11sg4 (2026-07-21): result = NO
- Camoufox launched cleanly: real Firefox 147, `navigator.webdriver=false`, geoip-derived
  `tz=America/Chicago`, engine-level fingerprint. Proxy = fresh ProxyBase "residential US"
  #92 (egress `142.147.240.76`). Reached the username→password step, submitted creds.
- X **still** returned **"We've temporarily limited your login. Please try again later."**
  at the username/password step, **before 2FA** — the exact same wall Chromium hit.
- **Conclusion: the block is IP reputation, not browser fingerprint.** Camoufox did NOT get
  past what Chromium couldn't. Smoking gun: the ProxyBase "residential" pool egresses through
  **datacenter/hosting ASNs**, not real residential/mobile — e.g. OVH (AS16276), NTT
  (AS2914), Web2Objects (AS62874), Lamhosting (AS46829), Tier.Net (AS397423), HostPapa
  (AS40092). X trivially flags these.
- **Next lever (in priority order):**
  1. Real **residential or mobile** IPs (ISP/mobile-carrier ASNs, ideally a sticky mobile 4G/5G
     exit), not datacenter-backed "residential" pools.
  2. **Manual cookie export**: log in by hand in a real browser on a clean IP, export
     `auth_token` + `ct0`, import as a session (cookie-only, no password login). Our importer
     already supports ct0/auth_token.
  3. Only after IPs improve is it worth re-testing whether Camoufox's fingerprint adds
     marginal lift over Chromium.

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
