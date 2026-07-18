const socialWarmService = require('./socialWarmService');

const PLATFORMS = ['instagram', 'tiktok'];

class SocialWarmScheduler {
  constructor() {
    this.activeRuns = 0;
  }

  async tick() {
    const allResults = [];
    for (const platform of PLATFORMS) {
      const settings = await socialWarmService.getSettings(platform);
      if (!settings.enabled) {
        allResults.push({ platform, skipped: true, reason: 'disabled' });
        continue;
      }

      const maxConcurrent = settings.max_concurrent || 1;
      const availableSlots = Math.max(0, maxConcurrent - this.activeRuns);
      if (availableSlots === 0) {
        allResults.push({ platform, skipped: true, reason: 'concurrency' });
        continue;
      }

      const accounts = await socialWarmService.listEligibleAccounts(platform);
      for (let i = accounts.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [accounts[i], accounts[j]] = [accounts[j], accounts[i]];
      }

      const due = [];
      for (const account of accounts) {
        let job = await socialWarmService.ensureJob(account.id);
        job = await socialWarmService.refreshDayState(job, settings);
        if (!job.enabled) continue;
        if (job.status === 'running') continue;
        if (job.cooldown_until && new Date(job.cooldown_until) > new Date()) continue;
        if (job.failure_class === 'bad_credentials') continue;
        if (job.actions_today >= (job.daily_target || settings.max_per_day)) continue;
        if (job.next_due_at && new Date(job.next_due_at) > new Date()) continue;
        if (socialWarmService.inQuietHours(settings)) continue;
        due.push(account);
        if (due.length >= availableSlots) break;
      }

      const results = [];
      await Promise.all(
        due.map(async (account) => {
          this.activeRuns += 1;
          try {
            const result = await socialWarmService.runOneForAccount(account);
            results.push({ accountId: account.id, ...result });
          } finally {
            this.activeRuns -= 1;
          }
        })
      );

      if (results.length) {
        console.log(
          `Social warm tick (${platform}): ${results.length}`,
          results.map((r) => ({
            accountId: r.accountId,
            success: r.success,
            handle: r.handle,
            reason: r.reason,
          }))
        );
      }
      allResults.push({ platform, ran: results.length, results });
    }
    return { platforms: allResults };
  }
}

module.exports = new SocialWarmScheduler();
