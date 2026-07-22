const { Queue, Worker } = require('bullmq');

const ORGANIC_QUEUE = 'organic-comments';
const AUDIT_QUEUE = 'account-stats-audit';
const X_FOLLOW_QUEUE = 'x-follows';
const SOCIAL_WARM_QUEUE = 'social-warm';
const REDDIT_PW_RESET_QUEUE = 'reddit-password-reset';
const ACCOUNT_OPS_BRAIN_QUEUE = 'account-ops-brain';

function redisConnection() {
  return {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: null,
  };
}

class DurableQueue {
  constructor() {
    this.connection = null;
    this.queues = {};
    this.workers = {};
    this.started = false;
  }

  async start() {
    if (this.started) return;
    this.connection = redisConnection();

    this.queues[ORGANIC_QUEUE] = new Queue(ORGANIC_QUEUE, { connection: this.connection });
    this.queues[AUDIT_QUEUE] = new Queue(AUDIT_QUEUE, { connection: this.connection });
    this.queues[X_FOLLOW_QUEUE] = new Queue(X_FOLLOW_QUEUE, { connection: this.connection });
    this.queues[SOCIAL_WARM_QUEUE] = new Queue(SOCIAL_WARM_QUEUE, { connection: this.connection });
    this.queues[REDDIT_PW_RESET_QUEUE] = new Queue(REDDIT_PW_RESET_QUEUE, {
      connection: this.connection,
    });
    this.queues[ACCOUNT_OPS_BRAIN_QUEUE] = new Queue(ACCOUNT_OPS_BRAIN_QUEUE, {
      connection: this.connection,
    });

    const organicCommentScheduler = require('./organicCommentScheduler');
    const accountStatsScheduler = require('./accountStatsScheduler');
    const xFollowScheduler = require('./xFollowScheduler');
    const socialWarmScheduler = require('./socialWarmScheduler');
    const redditPasswordResetScheduler = require('./redditPasswordResetScheduler');
    const accountOpsBrainScheduler = require('./accountOpsBrainScheduler');

    this.workers[ORGANIC_QUEUE] = new Worker(
      ORGANIC_QUEUE,
      async (job) => {
        if (job.name !== 'tick') return { skipped: true, reason: 'unknown_job' };
        return organicCommentScheduler.tick();
      },
      {
        connection: this.connection,
        concurrency: 1,
        lockDuration: 30 * 60 * 1000,
      }
    );

    this.workers[AUDIT_QUEUE] = new Worker(
      AUDIT_QUEUE,
      async (job) => {
        if (job.name !== 'tick') return { skipped: true, reason: 'unknown_job' };
        return accountStatsScheduler.tick();
      },
      {
        connection: this.connection,
        concurrency: 1,
        lockDuration: 2 * 60 * 60 * 1000,
      }
    );

    this.workers[X_FOLLOW_QUEUE] = new Worker(
      X_FOLLOW_QUEUE,
      async (job) => {
        if (job.name !== 'tick') return { skipped: true, reason: 'unknown_job' };
        return xFollowScheduler.tick();
      },
      {
        connection: this.connection,
        concurrency: 1,
        lockDuration: 30 * 60 * 1000,
      }
    );

    this.workers[SOCIAL_WARM_QUEUE] = new Worker(
      SOCIAL_WARM_QUEUE,
      async (job) => {
        if (job.name !== 'tick') return { skipped: true, reason: 'unknown_job' };
        return socialWarmScheduler.tick();
      },
      {
        connection: this.connection,
        concurrency: 1,
        lockDuration: 30 * 60 * 1000,
      }
    );

    this.workers[REDDIT_PW_RESET_QUEUE] = new Worker(
      REDDIT_PW_RESET_QUEUE,
      async (job) => {
        if (job.name !== 'tick') return { skipped: true, reason: 'unknown_job' };
        return redditPasswordResetScheduler.tick();
      },
      {
        connection: this.connection,
        concurrency: 1,
        lockDuration: 45 * 60 * 1000,
      }
    );

    this.workers[ACCOUNT_OPS_BRAIN_QUEUE] = new Worker(
      ACCOUNT_OPS_BRAIN_QUEUE,
      async (job) => {
        if (job.name !== 'tick') return { skipped: true, reason: 'unknown_job' };
        return accountOpsBrainScheduler.tick();
      },
      {
        connection: this.connection,
        concurrency: 1,
        lockDuration: 25 * 60 * 1000,
      }
    );

    this.workers[ORGANIC_QUEUE].on('completed', async () => {
      try {
        if ((await this.pendingCount(ORGANIC_QUEUE)) === 0) {
          await this.scheduleOrganicTick();
        }
      } catch (err) {
        console.error('Failed to schedule next organic tick:', err.message);
      }
    });

    this.workers[ORGANIC_QUEUE].on('failed', async (_job, err) => {
      console.error('Organic tick job failed:', err?.message || err);
      try {
        if ((await this.pendingCount(ORGANIC_QUEUE)) === 0) {
          await this.scheduleOrganicTick(60 * 1000);
        }
      } catch (e) {
        console.error('Failed to reschedule organic after failure:', e.message);
      }
    });

    this.workers[AUDIT_QUEUE].on('completed', async () => {
      try {
        if ((await this.pendingCount(AUDIT_QUEUE)) === 0) {
          await this.scheduleAuditTick();
        }
      } catch (err) {
        console.error('Failed to schedule next audit tick:', err.message);
      }
    });

    this.workers[AUDIT_QUEUE].on('failed', async (_job, err) => {
      console.error('Account stats tick job failed:', err?.message || err);
      try {
        if ((await this.pendingCount(AUDIT_QUEUE)) === 0) {
          await this.scheduleAuditTick(60 * 1000);
        }
      } catch (e) {
        console.error('Failed to reschedule audit after failure:', e.message);
      }
    });

    this.workers[X_FOLLOW_QUEUE].on('completed', async () => {
      try {
        if ((await this.pendingCount(X_FOLLOW_QUEUE)) === 0) {
          await this.scheduleXFollowTick();
        }
      } catch (err) {
        console.error('Failed to schedule next X follow tick:', err.message);
      }
    });

    this.workers[X_FOLLOW_QUEUE].on('failed', async (_job, err) => {
      console.error('X follow tick job failed:', err?.message || err);
      try {
        if ((await this.pendingCount(X_FOLLOW_QUEUE)) === 0) {
          await this.scheduleXFollowTick(60 * 1000);
        }
      } catch (e) {
        console.error('Failed to reschedule X follow after failure:', e.message);
      }
    });

    this.workers[SOCIAL_WARM_QUEUE].on('completed', async () => {
      try {
        if ((await this.pendingCount(SOCIAL_WARM_QUEUE)) === 0) {
          await this.scheduleSocialWarmTick();
        }
      } catch (err) {
        console.error('Failed to schedule next social-warm tick:', err.message);
      }
    });

    this.workers[SOCIAL_WARM_QUEUE].on('failed', async (_job, err) => {
      console.error('Social warm tick job failed:', err?.message || err);
      try {
        if ((await this.pendingCount(SOCIAL_WARM_QUEUE)) === 0) {
          await this.scheduleSocialWarmTick(60 * 1000);
        }
      } catch (e) {
        console.error('Failed to reschedule social-warm after failure:', e.message);
      }
    });

    this.workers[REDDIT_PW_RESET_QUEUE].on('completed', async () => {
      try {
        if ((await this.pendingCount(REDDIT_PW_RESET_QUEUE)) === 0) {
          await this.scheduleRedditPasswordResetTick();
        }
      } catch (err) {
        console.error('Failed to schedule next reddit-password-reset tick:', err.message);
      }
    });

    this.workers[REDDIT_PW_RESET_QUEUE].on('failed', async (_job, err) => {
      console.error('Reddit password-reset tick failed:', err?.message || err);
      try {
        if ((await this.pendingCount(REDDIT_PW_RESET_QUEUE)) === 0) {
          await this.scheduleRedditPasswordResetTick(5 * 60 * 1000);
        }
      } catch (e) {
        console.error('Failed to reschedule reddit-password-reset after failure:', e.message);
      }
    });

    this.workers[ACCOUNT_OPS_BRAIN_QUEUE].on('completed', async () => {
      try {
        if ((await this.pendingCount(ACCOUNT_OPS_BRAIN_QUEUE)) === 0) {
          await this.scheduleAccountOpsBrainTick();
        }
      } catch (err) {
        console.error('Failed to schedule next account-ops-brain tick:', err.message);
      }
    });

    this.workers[ACCOUNT_OPS_BRAIN_QUEUE].on('failed', async (_job, err) => {
      console.error('Account ops brain tick failed:', err?.message || err);
      try {
        if ((await this.pendingCount(ACCOUNT_OPS_BRAIN_QUEUE)) === 0) {
          await this.scheduleAccountOpsBrainTick(60 * 1000);
        }
      } catch (e) {
        console.error('Failed to reschedule account-ops-brain after failure:', e.message);
      }
    });

    await this.ensureOrganicLoop();
    await this.ensureAuditLoop();
    await this.ensureXFollowLoop();
    await this.ensureSocialWarmLoop();
    await this.ensureRedditPasswordResetLoop();
    await this.ensureAccountOpsBrainLoop();

    this.started = true;
    console.log(
      `Durable queue started (Redis ${this.connection.host}:${this.connection.port})`
    );
  }

  async stop() {
    this.started = false;
    await Promise.all(
      Object.values(this.workers).map(async (w) => {
        try {
          await w.close();
        } catch (err) {
          console.warn('Worker close warning:', err.message);
        }
      })
    );
    await Promise.all(
      Object.values(this.queues).map(async (q) => {
        try {
          await q.close();
        } catch (err) {
          console.warn('Queue close warning:', err.message);
        }
      })
    );
    this.workers = {};
    this.queues = {};
    console.log('Durable queue stopped');
  }

  organicDelayMs(overrideMs = null) {
    if (overrideMs != null) return overrideMs;
    // ~8–16 min between ticks — slightly calmer than the 6–12 warm-up burst
    const base = 8 * 60 * 1000;
    const jitter = Math.random() * 8 * 60 * 1000;
    return base + jitter;
  }

  /** Drop pending organic ticks and schedule one soon (warm-up / cadence bump). */
  async kickOrganicSoon(delayMs = 5000) {
    const q = this.queues[ORGANIC_QUEUE];
    if (!q) throw new Error('Organic queue not initialized');
    const delayed = await q.getDelayed();
    const waiting = await q.getWaiting();
    for (const job of [...delayed, ...waiting]) {
      if (job.name === 'tick') {
        try {
          await job.remove();
        } catch { /* ignore */ }
      }
    }
    await this.scheduleOrganicTick(delayMs);
  }

  auditDelayMs(overrideMs = null) {
    if (overrideMs != null) return overrideMs;
    return (10 + Math.random() * 5) * 60 * 1000;
  }

  async pendingCount(queueName) {
    const q = this.queues[queueName];
    if (!q) return 0;
    const counts = await q.getJobCounts('delayed', 'waiting', 'active', 'paused');
    return (counts.delayed || 0) + (counts.waiting || 0) + (counts.active || 0) + (counts.paused || 0);
  }

  async scheduleOrganicTick(overrideMs = null) {
    const q = this.queues[ORGANIC_QUEUE];
    if (!q) throw new Error('Organic queue not initialized');
    const delay = this.organicDelayMs(overrideMs);
    await q.add(
      'tick',
      { scheduledAt: new Date().toISOString() },
      {
        delay,
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 1,
      }
    );
    console.log(`Organic tick scheduled in ${Math.round(delay / 1000)}s`);
  }

  async scheduleAuditTick(overrideMs = null) {
    const q = this.queues[AUDIT_QUEUE];
    if (!q) throw new Error('Audit queue not initialized');
    const delay = this.auditDelayMs(overrideMs);
    await q.add(
      'tick',
      { scheduledAt: new Date().toISOString() },
      {
        delay,
        removeOnComplete: 50,
        removeOnFail: 25,
        attempts: 1,
      }
    );
    console.log(`Account stats tick scheduled in ${Math.round(delay / 1000)}s`);
  }

  async ensureOrganicLoop() {
    const pending = await this.pendingCount(ORGANIC_QUEUE);
    if (pending > 0) {
      console.log(`Organic queue already has ${pending} pending job(s) — skipping seed`);
      return;
    }
    await this.scheduleOrganicTick(5000);
  }

  async ensureAuditLoop() {
    const pending = await this.pendingCount(AUDIT_QUEUE);
    if (pending > 0) {
      console.log(`Audit queue already has ${pending} pending job(s) — skipping seed`);
      return;
    }
    await this.scheduleAuditTick(20000);
  }

  xFollowDelayMs(overrideMs = null) {
    if (overrideMs != null) return overrideMs;
    // ~10–20 min between ticks — calmer than organic comments
    const base = 10 * 60 * 1000;
    const jitter = Math.random() * 10 * 60 * 1000;
    return base + jitter;
  }

  async kickXFollowSoon(delayMs = 5000) {
    const q = this.queues[X_FOLLOW_QUEUE];
    if (!q) throw new Error('X follow queue not initialized');
    const delayed = await q.getDelayed();
    const waiting = await q.getWaiting();
    for (const job of [...delayed, ...waiting]) {
      if (job.name === 'tick') {
        try {
          await job.remove();
        } catch { /* ignore */ }
      }
    }
    await this.scheduleXFollowTick(delayMs);
  }

  async scheduleXFollowTick(overrideMs = null) {
    const q = this.queues[X_FOLLOW_QUEUE];
    if (!q) throw new Error('X follow queue not initialized');
    const delay = this.xFollowDelayMs(overrideMs);
    await q.add(
      'tick',
      { scheduledAt: new Date().toISOString() },
      {
        delay,
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 1,
      }
    );
    console.log(`X follow tick scheduled in ${Math.round(delay / 1000)}s`);
  }

  async ensureXFollowLoop() {
    const pending = await this.pendingCount(X_FOLLOW_QUEUE);
    if (pending > 0) {
      console.log(`X follow queue already has ${pending} pending job(s) — skipping seed`);
      return;
    }
    await this.scheduleXFollowTick(8000);
  }

  socialWarmDelayMs(overrideMs = null) {
    if (overrideMs != null) return overrideMs;
    const base = 12 * 60 * 1000;
    const jitter = Math.random() * 10 * 60 * 1000;
    return base + jitter;
  }

  async kickSocialWarmSoon(delayMs = 5000) {
    const q = this.queues[SOCIAL_WARM_QUEUE];
    if (!q) throw new Error('Social warm queue not initialized');
    const delayed = await q.getDelayed();
    const waiting = await q.getWaiting();
    for (const job of [...delayed, ...waiting]) {
      if (job.name === 'tick') {
        try { await job.remove(); } catch { /* ignore */ }
      }
    }
    await this.scheduleSocialWarmTick(delayMs);
  }

  async scheduleSocialWarmTick(overrideMs = null) {
    const q = this.queues[SOCIAL_WARM_QUEUE];
    if (!q) throw new Error('Social warm queue not initialized');
    const delay = this.socialWarmDelayMs(overrideMs);
    await q.add(
      'tick',
      { scheduledAt: new Date().toISOString() },
      { delay, removeOnComplete: 100, removeOnFail: 50, attempts: 1 }
    );
    console.log(`Social warm tick scheduled in ${Math.round(delay / 1000)}s`);
  }

  async ensureSocialWarmLoop() {
    const pending = await this.pendingCount(SOCIAL_WARM_QUEUE);
    if (pending > 0) {
      console.log(`Social warm queue already has ${pending} pending job(s) — skipping seed`);
      return;
    }
    await this.scheduleSocialWarmTick(10000);
  }

  /** ~60–120 min between ticks — intentionally slow; max a few resets/day. */
  redditPasswordResetDelayMs(overrideMs = null) {
    if (overrideMs != null) return overrideMs;
    const base = 60 * 60 * 1000;
    const jitter = Math.random() * 60 * 60 * 1000;
    return base + jitter;
  }

  async kickRedditPasswordResetSoon(delayMs = 10000) {
    const q = this.queues[REDDIT_PW_RESET_QUEUE];
    if (!q) throw new Error('Reddit password-reset queue not initialized');
    const delayed = await q.getDelayed();
    const waiting = await q.getWaiting();
    for (const job of [...delayed, ...waiting]) {
      if (job.name === 'tick') {
        try {
          await job.remove();
        } catch {
          /* ignore */
        }
      }
    }
    await this.scheduleRedditPasswordResetTick(delayMs);
  }

  async scheduleRedditPasswordResetTick(overrideMs = null) {
    const q = this.queues[REDDIT_PW_RESET_QUEUE];
    if (!q) throw new Error('Reddit password-reset queue not initialized');
    const delay = this.redditPasswordResetDelayMs(overrideMs);
    await q.add(
      'tick',
      { scheduledAt: new Date().toISOString() },
      { delay, removeOnComplete: 50, removeOnFail: 25, attempts: 1 }
    );
    console.log(`Reddit password-reset tick scheduled in ${Math.round(delay / 1000)}s`);
  }

  async ensureRedditPasswordResetLoop() {
    const pending = await this.pendingCount(REDDIT_PW_RESET_QUEUE);
    if (pending > 0) {
      console.log(
        `Reddit password-reset queue already has ${pending} pending job(s) — skipping seed`
      );
      return;
    }
    await this.scheduleRedditPasswordResetTick(30000);
  }

  accountOpsBrainDelayMs(overrideMs = null) {
    if (overrideMs != null) return overrideMs;
    // ~2–4 min — faster than organic so enrollment/profile gaps close quickly
    const base = 2 * 60 * 1000;
    const jitter = Math.random() * 2 * 60 * 1000;
    return base + jitter;
  }

  async scheduleAccountOpsBrainTick(overrideMs = null) {
    const q = this.queues[ACCOUNT_OPS_BRAIN_QUEUE];
    if (!q) throw new Error('Account ops brain queue not initialized');
    const delay = this.accountOpsBrainDelayMs(overrideMs);
    await q.add(
      'tick',
      { scheduledAt: new Date().toISOString() },
      { delay, removeOnComplete: 50, removeOnFail: 25, attempts: 1 }
    );
    console.log(`Account ops brain tick scheduled in ${Math.round(delay / 1000)}s`);
  }

  async ensureAccountOpsBrainLoop() {
    const enabled =
      ['1', 'true', 'yes', 'on'].includes(
        String(process.env.ACCOUNT_OPS_BRAIN || '').trim().toLowerCase()
      );
    if (!enabled) {
      console.log('Account ops brain disabled (set ACCOUNT_OPS_BRAIN=1 to enable)');
      return;
    }
    const pending = await this.pendingCount(ACCOUNT_OPS_BRAIN_QUEUE);
    if (pending > 0) {
      console.log(`Account ops brain queue already has ${pending} pending job(s) — skipping seed`);
      return;
    }
    await this.scheduleAccountOpsBrainTick(8000);
  }

  async getStatus() {
    if (!this.started) {
      return { started: false, redis: null, queues: {} };
    }
    const organic = await this.queues[ORGANIC_QUEUE].getJobCounts(
      'delayed',
      'waiting',
      'active',
      'completed',
      'failed'
    );
    const audit = await this.queues[AUDIT_QUEUE].getJobCounts(
      'delayed',
      'waiting',
      'active',
      'completed',
      'failed'
    );
    const xFollow = await this.queues[X_FOLLOW_QUEUE].getJobCounts(
      'delayed',
      'waiting',
      'active',
      'completed',
      'failed'
    );
    const socialWarm = await this.queues[SOCIAL_WARM_QUEUE].getJobCounts(
      'delayed',
      'waiting',
      'active',
      'completed',
      'failed'
    );
    const redditPwReset = await this.queues[REDDIT_PW_RESET_QUEUE].getJobCounts(
      'delayed',
      'waiting',
      'active',
      'completed',
      'failed'
    );
    const accountOpsBrain = this.queues[ACCOUNT_OPS_BRAIN_QUEUE]
      ? await this.queues[ACCOUNT_OPS_BRAIN_QUEUE].getJobCounts(
          'delayed',
          'waiting',
          'active',
          'completed',
          'failed'
        )
      : {};
    return {
      started: true,
      redis: `${this.connection.host}:${this.connection.port}`,
      queues: {
        [ORGANIC_QUEUE]: organic,
        [AUDIT_QUEUE]: audit,
        [X_FOLLOW_QUEUE]: xFollow,
        [SOCIAL_WARM_QUEUE]: socialWarm,
        [REDDIT_PW_RESET_QUEUE]: redditPwReset,
        [ACCOUNT_OPS_BRAIN_QUEUE]: accountOpsBrain,
      },
    };
  }
}

module.exports = new DurableQueue();
