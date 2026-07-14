// backend/src/services/taskQueue.js
const { Subject } = require('rxjs');
const { filter } = require('rxjs/operators');
const pool = require('./db');
const postingService = require('./postingService');
const commentingService = require('./commentingService');
const campaignScorecardService = require('./campaignScorecardService');

class TaskQueue {
  constructor() {
    this.taskSubject = new Subject();
    this.activeIntervals = new Map();
  }

  get activeCampaigns() {
    return Array.from(this.activeIntervals.keys()).map(id => parseInt(id));
  }

  async initialize() {
    this.taskSubject.pipe(
      filter(task => task.type === 'simulation')
    ).subscribe(async task => {
      await this.handleSimulationTask(task.campaignId);
    });

    this.taskSubject.pipe(
      filter(task => task.type === 'live')
    ).subscribe(async task => {
      await this.handleLiveTask(task);
    });

    await this.restoreActiveCampaigns();
  }

  addTask(campaignId, type = 'simulation') {
    this.taskSubject.next({
      type,
      campaignId
    });
  }

  async restoreActiveCampaigns() {
    try {
      const result = await pool.query(
        'SELECT id, simulation_mode FROM campaigns WHERE is_running = true'
      );
      
      for (const campaign of result.rows) {
        console.log(`Restoring campaign ${campaign.id} (simulation_mode: ${campaign.simulation_mode})`);
        await this.startCampaign(campaign.id, !campaign.simulation_mode);
      }
    } catch (error) {
      console.error('Error restoring active campaigns:', error);
    }
  }

  async startCampaign(campaignId, isLive = false) {
    console.log(`Starting campaign ${campaignId} (isLive: ${isLive})`);
    
    if (this.activeIntervals.has(campaignId)) {
      console.log(`Campaign ${campaignId} is already active`);
      return;
    }

    try {
      if (isLive) {
        await pool.query(
          'UPDATE campaigns SET is_running = true, simulation_mode = false, is_live = true WHERE id = $1',
          [campaignId]
        );
      } else {
        await pool.query(
          'UPDATE campaigns SET is_running = true, simulation_mode = true WHERE id = $1',
          [campaignId]
        );
        try {
          await campaignScorecardService.startSimRun(campaignId);
        } catch (err) {
          console.warn('Failed to start sim run scorecard:', err.message);
        }
      }

      const taskType = isLive ? 'live' : 'simulation';
      
      // Immediate first tick
      this.addTask(campaignId, taskType);

      // Single recurring scheduler (no double-schedule from handlers)
      const baseInterval = isLive ? 5 * 60 * 1000 : 30 * 1000;
      console.log(`Setting up ${taskType} mode with base interval: ${baseInterval}ms`);

      const scheduleNext = () => {
        const jitterFactor = 0.2 + Math.random() * 0.2;
        const direction = Math.random() > 0.5 ? 1 : -1;
        const jitteredInterval = baseInterval + baseInterval * jitterFactor * direction;
        const clampedInterval = Math.max(baseInterval * 0.6, Math.min(baseInterval * 1.6, jitteredInterval));

        const timeoutId = setTimeout(() => {
          if (this.activeIntervals.has(campaignId)) {
            this.addTask(campaignId, taskType);
            scheduleNext();
          }
        }, clampedInterval);

        this.activeIntervals.set(campaignId, timeoutId);
      };

      scheduleNext();
    } catch (error) {
      console.error(`Error starting campaign ${campaignId}:`, error);
      throw error;
    }
  }

  async stopCampaign(campaignId) {
    try {
      const prior = await this.getCampaignStatus(campaignId).catch(() => null);

      await pool.query(
        'UPDATE campaigns SET is_running = false WHERE id = $1',
        [campaignId]
      );

      const timerId = this.activeIntervals.get(campaignId);
      if (timerId) {
        clearTimeout(timerId);
        this.activeIntervals.delete(campaignId);
      }

      if (prior?.simulationMode !== false) {
        try {
          await campaignScorecardService.finalizeSimRun(campaignId);
        } catch (err) {
          console.warn('Failed to finalize sim scorecard:', err.message);
        }
      }

      console.log(`Campaign ${campaignId} stopped successfully`);
    } catch (error) {
      console.error(`Error stopping campaign ${campaignId}:`, error);
      throw error;
    }
  }

  async getCampaignStatus(campaignId) {
    try {
      const result = await pool.query(
        'SELECT is_running, simulation_mode, is_live FROM campaigns WHERE id = $1',
        [campaignId]
      );
      
      if (result.rows.length === 0) {
        throw new Error('Campaign not found');
      }

      return {
        isRunning: result.rows[0].is_running,
        simulationMode: result.rows[0].simulation_mode,
        isLive: result.rows[0].is_live,
        hasActiveInterval: this.activeIntervals.has(campaignId)
      };
    } catch (error) {
      console.error(`Error getting campaign status ${campaignId}:`, error);
      throw error;
    }
  }

  async handleSimulationTask(campaignId) {
    try {
      const { rows } = await pool.query(
        'SELECT whisper_enabled, overt_enabled FROM campaigns WHERE id = $1',
        [campaignId]
      );
      const camp = rows[0] || {};
      const whisperOn = camp.whisper_enabled !== false;
      const overtOn = !!camp.overt_enabled;

      if (whisperOn) {
        try {
          await postingService.createSimulatedPost(campaignId);
        } catch (error) {
          if (
            !error.message.includes('post limit') &&
            !error.message.includes('posts limit') &&
            !error.message.includes('No available')
          ) {
            console.error('Error creating simulated post:', error);
          } else {
            console.log(`Simulation post skipped: ${error.message}`);
          }
        }

        try {
          await commentingService.createSimulatedComments(campaignId);
        } catch (error) {
          if (error.message.includes('comment limit') || error.message.includes('No real')) {
            console.log(`Simulation comments skipped: ${error.message}`);
          } else {
            console.error('Error creating comments:', error);
          }
        }
      }

      if (overtOn) {
        try {
          const overtPostingService = require('./overtPostingService');
          await overtPostingService.createAndMaybePublish(campaignId, { live: false });
        } catch (err) {
          console.log(`Overt sim draft skipped: ${err.message}`);
        }
      }
    } catch (error) {
      console.error('Critical error in simulation task:', error);
    }
  }

  async handleLiveTask(task) {
    try {
      const campaign = await pool.query('SELECT * FROM campaigns WHERE id = $1', [task.campaignId]);
      if (!campaign.rows[0]) {
        throw new Error('Campaign not found');
      }
      const camp = campaign.rows[0];
      const whisperOn = camp.whisper_enabled !== false;
      const overtOn = !!camp.overt_enabled;

      if (whisperOn) {
        try {
          await postingService.createPost(task.campaignId, true);
        } catch (postError) {
          if (
            postError.message.includes('post limit') ||
            postError.message.includes('Minimum post interval') ||
            postError.message.includes('No real') ||
            postError.message.includes('No available')
          ) {
            console.log(`Live post skipped for campaign ${task.campaignId}: ${postError.message}`);
          } else {
            console.error(`Error creating live post: ${postError.message}`);
          }
        }

        try {
          await commentingService.createComments(task.campaignId, true);
        } catch (commentError) {
          if (
            commentError.message.includes('comment limit') ||
            commentError.message.includes('Minimum reply interval') ||
            commentError.message.includes('No real')
          ) {
            console.log(`Live comments skipped for campaign ${task.campaignId}: ${commentError.message}`);
          } else {
            console.error(`Error creating live comments: ${commentError.message}`);
          }
        }
      }

      if (overtOn) {
        try {
          const overtPostingService = require('./overtPostingService');
          await overtPostingService.createAndMaybePublish(task.campaignId, { live: true });
        } catch (overtErr) {
          console.error(`Overt post error for campaign ${task.campaignId}:`, overtErr.message);
        }
      }
    } catch (error) {
      console.error(`Critical error handling live task: ${error.message}`);
    }
  }
}

module.exports = new TaskQueue();
