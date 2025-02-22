// backend/src/services/taskQueue.js
const { Subject } = require('rxjs');
const { filter } = require('rxjs/operators');
const pool = require('./db');
const postingService = require('./postingService');
const commentingService = require('./commentingService');

class TaskQueue {
  constructor() {
    this.taskSubject = new Subject();
    this.activeIntervals = new Map(); // Store intervalIds by campaignId
    this.initialize();
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

      // Set up recurring checks
      const intervalTime = isLive ? 5 * 60 * 1000 : 30 * 1000; // 5 mins for live, 30 secs for simulation
      console.log(`Setting up ${taskType} mode with interval: ${intervalTime}ms`);

      const intervalId = setInterval(() => {
        this.addTask(campaignId, taskType);
      }, intervalTime);

      this.activeIntervals.set(campaignId, intervalId);
    } catch (error) {
      console.error(`Error starting campaign ${campaignId}:`, error);
      throw error;
    }
  }

  async stopCampaign(campaignId) {
    try {
      // Clear any scheduled intervals
      const intervalId = this.activeIntervals.get(campaignId);
      if (intervalId) {
        clearInterval(intervalId);
        this.activeIntervals.delete(campaignId);
      }

      // Update database state immediately
      await pool.query(
        'UPDATE campaigns SET is_running = false WHERE id = $1',
        [campaignId]
      );

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
          console.log('Campaign has reached all post limits - continuing for comments only');
        }
      } catch (error) {
        if (!error.message.includes('Post limit reached')) {
          console.error('Error creating post:', error.message);
        }
      }

      // Always try to generate comments, even if post creation failed
      try {
        await commentingService.createSimulatedComments(campaignId);
      } catch (error) {
        console.error('Error creating comments:', error.message);
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
      console.error('Error handling simulation task:', error);
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
      await postingService.createPost(task.campaignId, true);
      
      // Generate comments
      await commentingService.createComments(task.campaignId, true);
    } catch (error) {
      console.error(`Error handling live task: ${error.message}`);
    }
  }
}

module.exports = new TaskQueue();