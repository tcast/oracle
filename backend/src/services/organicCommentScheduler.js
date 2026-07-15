const organicCommentService = require('./organicCommentService');

class OrganicCommentScheduler {
  constructor() {
    this.timeoutId = null;
    this.running = false;
    this.activeRuns = 0;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    console.log('Organic comment scheduler started');
    this.scheduleNext(5000);
  }

  stop() {
    this.running = false;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    console.log('Organic comment scheduler stopped');
  }

  scheduleNext(overrideMs = null) {
    if (!this.running) return;
    if (this.timeoutId) clearTimeout(this.timeoutId);

    // 15–30 min base with jitter
    const base = 15 * 60 * 1000;
    const jitter = Math.random() * 15 * 60 * 1000;
    const delay = overrideMs != null ? overrideMs : base + jitter;

    this.timeoutId = setTimeout(async () => {
      try {
        await this.tick();
      } catch (err) {
        console.error('Organic scheduler tick failed:', err.message);
      } finally {
        this.scheduleNext();
      }
    }, delay);
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
    // Shuffle for fairness
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
      console.log(`Organic comments tick: ${results.length} job(s)`, results.map((r) => ({
        accountId: r.accountId,
        success: r.success,
        skipped: r.skipped,
        reason: r.reason,
      })));
    }

    return { ran: results.length, results };
  }
}

module.exports = new OrganicCommentScheduler();
