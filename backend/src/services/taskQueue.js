// backend/src/services/taskQueue.js
const { Subject } = require('rxjs');
const { filter } = require('rxjs/operators');
const pool = require('./db');
const postingService = require('./postingService');
const commentingService = require('./commentingService');

class TaskQueue {
  constructor() {
    this.taskSubject = new Subject();
    this.activeIntervals = new Map();
  }

  // Add getter for activeCampaigns
  get activeCampaigns() {
    return Array.from(this.activeIntervals.keys()).map(id => parseInt(id));
  }

  async initialize() {
    // Handle simulation tasks
    this.taskSubject.pipe(
      filter(task => task.type === 'simulation')
    ).subscribe(async task => {
      await this.handleSimulationTask(task.campaignId);
    });

    // Handle live tasks
    this.taskSubject.pipe(
      filter(task => task.type === 'live')
    ).subscribe(async task => {
      await this.handleLiveTask(task);
    });

    // Restore active campaigns on server start
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
      // Update database state
      await pool.query(
        'UPDATE campaigns SET is_running = true, simulation_mode = $1 WHERE id = $2',
        [!isLive, campaignId]
      );

      const taskType = isLive ? 'live' : 'simulation';
      
      // Start initial task
      this.addTask(campaignId, taskType);

      // Set up recurring checks with jitter (20-40% random variance)
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
      // Update database state first so if this fails we know
      await pool.query(
        'UPDATE campaigns SET is_running = false WHERE id = $1',
        [campaignId]
      );

      // Then clear timeouts/intervals
      const timerId = this.activeIntervals.get(campaignId);
      if (timerId) {
        clearTimeout(timerId);
        this.activeIntervals.delete(campaignId);
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
        'SELECT is_running, simulation_mode FROM campaigns WHERE id = $1',
        [campaignId]
      );
      
      if (result.rows.length === 0) {
        throw new Error('Campaign not found');
      }

      return {
        isRunning: result.rows[0].is_running,
        simulationMode: result.rows[0].simulation_mode,
        hasActiveInterval: this.activeIntervals.has(campaignId)
      };
    } catch (error) {
      console.error(`Error getting campaign status ${campaignId}:`, error);
      throw error;
    }
  }

  async handleSimulationTask(campaignId) {
    try {
      let shouldContinue = true;

      // Try to create a post
      try {
        const post = await postingService.createSimulatedPost(campaignId);
        if (!post) {
          // Post limit reached - continue silently
        }
      } catch (error) {
        // Check if this is a post limit message (expected behavior)
        if (!error.message.includes('post limit') && !error.message.includes('posts limit')) {
          console.error('Error creating simulated post:', error);
          throw error; // Only throw if it's not a post limit error
        }
      }

      // Always try to generate comments, even if post creation failed
      try {
        await commentingService.createSimulatedComments(campaignId);
      } catch (error) {
        if (error.message.includes('comment limit')) {
          // Comment limit reached - continue silently
        } else {
          console.error('Error creating comments:', error);
          throw error; // Only throw if it's not a comment limit error
        }
      }

      // Check if we should continue (only if campaign is still marked as running)
      const status = await this.getCampaignStatus(campaignId);
      shouldContinue = status.isRunning;

      if (shouldContinue) {
        // Schedule next task with random delay
        const delay = Math.floor(Math.random() * 2000) + 1000; // 1-3 seconds
        setTimeout(() => this.addTask(campaignId, 'simulation'), delay);
      }
    } catch (error) {
      console.error('Critical error in simulation task:', error);
      // Don't stop on error unless it's critical
      const delay = Math.floor(Math.random() * 5000) + 5000; // 5-10 seconds
      setTimeout(() => this.addTask(campaignId, 'simulation'), delay);
    }
  }

  async handleLiveTask(task) {
    try {
      const campaign = await pool.query('SELECT * FROM campaigns WHERE id = $1', [task.campaignId]);
      if (!campaign.rows[0]) {
        throw new Error('Campaign not found');
      }

      // Create a post
      try {
        await postingService.createPost(task.campaignId, true);
      } catch (postError) {
        if (postError.message.includes('post limit') || postError.message.includes('Minimum post interval')) {
          console.log(`Live post skipped for campaign ${task.campaignId}: ${postError.message}`);
        } else {
          console.error(`Error creating live post: ${postError.message}`);
        }
      }
      
      // Generate comments
      try {
        await commentingService.createComments(task.campaignId, true);
      } catch (commentError) {
        if (commentError.message.includes('comment limit') || commentError.message.includes('Minimum reply interval')) {
          console.log(`Live comments skipped for campaign ${task.campaignId}: ${commentError.message}`);
        } else {
          console.error(`Error creating live comments: ${commentError.message}`);
        }
      }
    } catch (error) {
      console.error(`Critical error handling live task: ${error.message}`);
    }
  }
}

module.exports = new TaskQueue();