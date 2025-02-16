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
    ).subscribe(task => {
      this.handleSimulationTask(task);
    });

    // Handle live tasks
    this.taskSubject.pipe(
      filter(task => task.type === 'live')
    ).subscribe(task => {
      this.handleLiveTask(task);
    });

    // Restore active campaigns on server start
    await this.restoreActiveCampaigns();
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
      
      // Schedule initial posts
      this.taskSubject.next({
        type: taskType,
        action: 'post',
        campaignId
      });

      // Set up recurring checks for comments
      const intervalTime = isLive ? 5 * 60 * 1000 : 30 * 1000; // 5 mins for live, 30 secs for simulation
      console.log(`Setting up ${taskType} mode with interval: ${intervalTime}ms`);

      const intervalId = setInterval(() => {
        // For simulation mode, also create new posts more frequently
        if (!isLive && Math.random() < 0.3) { // 30% chance of new post in simulation
          this.taskSubject.next({
            type: taskType,
            action: 'post',
            campaignId
          });
        }

        this.taskSubject.next({
          type: taskType,
          action: 'comment',
          campaignId
        });
      }, intervalTime);

      this.activeIntervals.set(campaignId, intervalId);
    } catch (error) {
      console.error(`Error starting campaign ${campaignId}:`, error);
      throw error;
    }
  }

  async stopCampaign(campaignId) {
    try {
      const intervalId = this.activeIntervals.get(campaignId);
      if (intervalId) {
        clearInterval(intervalId);
        this.activeIntervals.delete(campaignId);
      }

      // Update database state
      await pool.query(
        'UPDATE campaigns SET is_running = false WHERE id = $1',
        [campaignId]
      );
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

  async handleSimulationTask(task) {
    const { action, campaignId } = task;
    
    try {
      if (action === 'post') {
        // Create 1-2 posts in simulation mode
        const numPosts = Math.floor(Math.random() * 2) + 1;
        for (let i = 0; i < numPosts; i++) {
          await postingService.createSimulatedPost(campaignId);
        }
      } else if (action === 'comment') {
        // Create more comments in simulation mode
        await commentingService.createSimulatedComments(campaignId);
      }
    } catch (error) {
      console.error(`Error handling simulation task: ${error.message}`);
    }
  }

  async handleLiveTask(task) {
    const { action, campaignId } = task;
    
    try {
      if (action === 'post') {
        await postingService.createLivePost(campaignId);
      } else if (action === 'comment') {
        await commentingService.createLiveComments(campaignId);
      }
    } catch (error) {
      console.error(`Error handling live task: ${error.message}`);
    }
  }
}

module.exports = new TaskQueue();