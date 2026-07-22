const accountOpsBrainService = require('./accountOpsBrainService');

/**
 * Account Ops Brain tick. Scheduling owned by durableQueue when ACCOUNT_OPS_BRAIN=1.
 */
class AccountOpsBrainScheduler {
  constructor() {
    this.activeRuns = 0;
  }

  async start() {}
  stop() {}

  async tick() {
    if (this.activeRuns > 0) {
      return { skipped: true, reason: 'overlap' };
    }
    this.activeRuns += 1;
    try {
      return await accountOpsBrainService.tick();
    } finally {
      this.activeRuns -= 1;
    }
  }
}

module.exports = new AccountOpsBrainScheduler();
