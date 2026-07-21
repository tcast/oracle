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

  _platformKey(account) {
    const p = String(account.platform || 'reddit').toLowerCase();
    return p === 'twitter' ? 'x' : p;
  }

  _shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /**
   * Pick up to `limit` due accounts, round-robin across platforms.
   * Each platform may contribute at most one account per round, so a large
   * Reddit due queue cannot fill all concurrent slots when X/IG/LI are also due.
   */
  async _selectDueFairShare(accounts, settings, limit) {
    const byPlatform = new Map();
    for (const account of accounts) {
      const key = this._platformKey(account);
      if (!byPlatform.has(key)) byPlatform.set(key, []);
      byPlatform.get(key).push(account);
    }

    const platforms = this._shuffleInPlace([...byPlatform.keys()]);
    for (const list of byPlatform.values()) this._shuffleInPlace(list);

    const cursors = new Map(platforms.map((p) => [p, 0]));
    const due = [];

    while (due.length < limit) {
      let progressed = false;
      for (const platform of platforms) {
        if (due.length >= limit) break;
        const list = byPlatform.get(platform);
        let i = cursors.get(platform);

        while (i < list.length) {
          const account = list[i++];
          cursors.set(platform, i);

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
          progressed = true;
          break; // one account per platform per round
        }
      }
      if (!progressed) break;
    }

    return due;
  }

  async tick() {
    // Always reclaim first — even when disabled — so crash leftovers do not
    // permanently occupy status=running slots.
    const reclaimed = await organicCommentService.reclaimStaleRunningJobs(25);

    const settings = await organicCommentService.getSettings();
    if (!settings.enabled) {
      return { skipped: true, reason: 'disabled', reclaimed: reclaimed.length };
    }

    const maxConcurrent = settings.max_concurrent || 2;
    const availableSlots = Math.max(0, maxConcurrent - this.activeRuns);
    if (availableSlots === 0) {
      return { skipped: true, reason: 'concurrency' };
    }

    const accounts = await organicCommentService.listEligibleAccounts();
    const due = await this._selectDueFairShare(accounts, settings, availableSlots);

    const results = [];
    await Promise.all(
      due.map(async (account) => {
        this.activeRuns += 1;
        try {
          const result = await organicCommentService.runOneForAccount(account, { dryRun: false });
          results.push({
            accountId: account.id,
            platform: this._platformKey(account),
            ...result,
          });
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
          platform: r.platform,
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
