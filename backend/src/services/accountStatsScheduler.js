const accountStatsService = require('./accountStatsService');

class AccountStatsScheduler {
  constructor() {
    this.timeoutId = null;
    this.running = false;
    this.inFlight = false;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    console.log('Account stats audit scheduler started (nightly ~3am America/New_York)');
    this.scheduleNext(20000);
  }

  stop() {
    this.running = false;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  scheduleNext(overrideMs = null) {
    if (!this.running) return;
    if (this.timeoutId) clearTimeout(this.timeoutId);
    // Check every ~10–15 minutes
    const delay = overrideMs != null ? overrideMs : (10 + Math.random() * 5) * 60 * 1000;
    this.timeoutId = setTimeout(async () => {
      try {
        await this.tick();
      } catch (err) {
        console.error('Account stats scheduler tick failed:', err.message);
      } finally {
        this.scheduleNext();
      }
    }, delay);
  }

  async tick() {
    if (this.inFlight) return { skipped: true, reason: 'in_flight' };
    const due = await accountStatsService.shouldRunTonight();
    if (!due) return { skipped: true, reason: 'not_due' };

    this.inFlight = true;
    try {
      console.log('Starting nightly Reddit account stats audit…');
      const result = await accountStatsService.runDailyAudit();
      console.log('Nightly account stats audit complete:', result.summary);
      return result;
    } finally {
      this.inFlight = false;
    }
  }
}

module.exports = new AccountStatsScheduler();
