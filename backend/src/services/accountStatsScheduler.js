const accountStatsService = require('./accountStatsService');

/**
 * Nightly account-stats audit tick. Scheduling is owned by durableQueue (BullMQ/Redis).
 */
class AccountStatsScheduler {
  constructor() {
    this.inFlight = false;
  }

  async start() {
    // Loop is started by durableQueue.start()
  }

  stop() {
    // Loop is stopped by durableQueue.stop()
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
