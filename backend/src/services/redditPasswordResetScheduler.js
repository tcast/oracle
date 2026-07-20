const redditPasswordResetService = require('./redditPasswordResetService');

class RedditPasswordResetScheduler {
  constructor() {
    this.activeRuns = 0;
  }

  async tick() {
    // Reclaim even when disabled — pilot crashes left jobs stuck in running.
    const reclaimed = await redditPasswordResetService.reclaimStaleRunningJobs(40);

    const settings = await redditPasswordResetService.getSettings();
    if (!settings.enabled) {
      return { skipped: true, reason: 'disabled', reclaimed: reclaimed.length };
    }
    if (redditPasswordResetService.inQuietHours(settings)) {
      return { skipped: true, reason: 'quiet_hours', reclaimed: reclaimed.length };
    }

    const maxConcurrent = Math.min(settings.max_concurrent || 1, 1); // hard-cap 1 for safety
    const availableSlots = Math.max(0, maxConcurrent - this.activeRuns);
    if (availableSlots === 0) {
      return { skipped: true, reason: 'concurrency' };
    }

    // Global daily cap across all accounts
    const { rows: todayRows } = await require('./db').query(
      `SELECT COALESCE(SUM(resets_today), 0)::int AS n
       FROM reddit_password_reset_jobs
       WHERE day_key = CURRENT_DATE`
    );
    if ((todayRows[0]?.n || 0) >= (settings.max_per_day || 2)) {
      return { skipped: true, reason: 'global_daily_cap', resetsToday: todayRows[0].n };
    }

    await redditPasswordResetService.ensureJobsForEligible();
    const accounts = await redditPasswordResetService.listEligibleAccounts();

    // Prefer accounts never rotated, then oldest rotation
    accounts.sort((a, b) => {
      const aAt = a._eligibility?.lastRotatedAt
        ? new Date(a._eligibility.lastRotatedAt).getTime()
        : 0;
      const bAt = b._eligibility?.lastRotatedAt
        ? new Date(b._eligibility.lastRotatedAt).getTime()
        : 0;
      return aAt - bAt;
    });

    const due = [];
    for (const account of accounts) {
      let job = await redditPasswordResetService.ensureJob(account.id);
      job = await redditPasswordResetService.refreshDayState(job, settings);
      if (!job.enabled) continue;
      if (job.status === 'running') continue;
      if (job.cooldown_until && new Date(job.cooldown_until) > new Date()) continue;
      if (job.failure_class === 'bad_credentials') continue;
      if (job.resets_today >= 1) continue; // one reset per account per day max
      if (job.next_due_at && new Date(job.next_due_at) > new Date()) continue;

      // Skip if rotated recently relative to rotate_every_days
      const last = account._eligibility?.lastRotatedAt;
      if (last) {
        const days = (Date.now() - new Date(last).getTime()) / (24 * 60 * 60 * 1000);
        if (days < (settings.rotate_every_days || 30)) continue;
      }

      due.push(account);
      if (due.length >= availableSlots) break;
    }

    if (!due.length) {
      return { ran: 0, results: [], reason: 'none_due' };
    }

    const results = [];
    for (const account of due) {
      this.activeRuns += 1;
      try {
        const result = await redditPasswordResetService.runOneForAccount(account);
        results.push({ accountId: account.id, username: account.username, ...result });
      } finally {
        this.activeRuns -= 1;
      }
    }

    console.log(
      `Reddit password-reset tick: ${results.length}`,
      results.map((r) => ({
        accountId: r.accountId,
        success: r.success,
        skipped: r.skipped,
        reason: r.reason || r.error,
      }))
    );

    return { ran: results.length, results };
  }
}

module.exports = new RedditPasswordResetScheduler();
