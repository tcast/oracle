const { Queue, Worker } = require('bullmq');

const ORGANIC_QUEUE = 'organic-comments';
const AUDIT_QUEUE = 'account-stats-audit';

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

    const organicCommentScheduler = require('./organicCommentScheduler');
    const accountStatsScheduler = require('./accountStatsScheduler');

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

    await this.ensureOrganicLoop();
    await this.ensureAuditLoop();

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
    const base = 15 * 60 * 1000;
    const jitter = Math.random() * 15 * 60 * 1000;
    return base + jitter;
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
    return {
      started: true,
      redis: `${this.connection.host}:${this.connection.port}`,
      queues: {
        [ORGANIC_QUEUE]: organic,
        [AUDIT_QUEUE]: audit,
      },
    };
  }
}

module.exports = new DurableQueue();
