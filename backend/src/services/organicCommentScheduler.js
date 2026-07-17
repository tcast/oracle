const organicCommentService = require('./organicCommentService');

/**
 * Organic comment tick logic. Scheduling is owned by durableQueue (BullMQ/Redis)
 * so delayed jobs survive backend restarts.
 */
class OrganicCommentScheduler {
  constructor() {
    this.activeRuns = 0;
  }

  async start() {
    // Loop is started by durableQueue.start()
  }

  stop() {
    // Loop is stopped by durableQueue.stop()
  }

  async tick() {
    const settings = await organicCommentService.getSettings();
    if (!settings.enabled) {
      return { skipped: true, reason: 'disabled' };
    }

    const maxConcurrent = settings.max_concurrent || 2;
    const availableSlots = Math.max(0, maxConcurrent - this.activeRuns);
    if (availableSlots === 0) {
      return { skipped: true, reason: 'concurrency' };
    }

    const accounts = await organicCommentService.listEligibleAccounts();
    for (let i = accounts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [accounts[i], accounts[j]] = [accounts[j], accounts[i]];
    }

    const due = [];
    for (const account of accounts) {
      let job = await organicCommentService.ensureJob(account.id);
      job = await organicCommentService.refreshDayState(job, settings);
      if (!job.enabled) continue;
      if (job.status === 'running') continue;
      if (job.cooldown_until && new Date(job.cooldown_until) > new Date()) continue;
      if (job.failure_class === 'bad_credentials') continue;
      if (job.comments_today >= (job.daily_target || settings.max_per_day)) continue;
      if (job.next_due_at && new Date(job.next_due_at) > new Date()) continue;
      if (organicCommentService.inQuietHours(settings)) continue;
      due.push(account);
      if (due.length >= availableSlots) break;
    }

    const results = [];
    await Promise.all(
      due.map(async (account) => {
        this.activeRuns += 1;
        try {
          const result = await organicCommentService.runOneForAccount(account, { dryRun: false });
          results.push({ accountId: account.id, ...result });
        } finally {
          this.activeRuns -= 1;
        }
      })
    );

    if (results.length) {
      console.log(
        `Organic comments tick: ${results.length} job(s)`,
        results.map((r) => ({
          accountId: r.accountId,
          success: r.success,
          skipped: r.skipped,
          reason: r.reason,
        }))
      );
    }

    return { ran: results.length, results };
  }
}

module.exports = new OrganicCommentScheduler();
