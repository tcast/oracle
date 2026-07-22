const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const accountOpsBrainService = require('../services/accountOpsBrainService');
const brainLiveState = require('../services/brainLiveState');

router.use(authMiddleware);

async function enrichSnapshot() {
  try {
    if (!brainLiveState._hydrated) {
      await brainLiveState.hydrate();
    }
  } catch (err) {
    console.warn('brain hydrate:', err.message);
  }
  try {
    await accountOpsBrainService.refreshLivePools();
  } catch (err) {
    console.warn('brain enrich pools:', err.message);
  }
  brainLiveState.setMeta({
    enabled: accountOpsBrainService.isEnabled(),
    parallel: accountOpsBrainService.getParallel(),
  });
  const capacity = accountOpsBrainService.getLastCapacity();
  if (capacity?.computed_at) brainLiveState.setCapacity(capacity);
  return brainLiveState.getSnapshot();
}

/** Snapshot of brain live state */
router.get('/live', async (req, res) => {
  try {
    const snapshot = await enrichSnapshot();
    res.json(snapshot);
  } catch (error) {
    console.error('Brain live error:', error);
    res.status(500).json({ error: error.message || 'Failed to load brain state' });
  }
});

/**
 * SSE stream — pushes snapshot on connect, then tick/action events.
 * Auth via Authorization header or ?token= (EventSource cannot set headers).
 */
router.get('/stream', async (req, res) => {
  try {
    const snapshot = await enrichSnapshot();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send('snapshot', snapshot);

    const onUpdate = (evt) => {
      try {
        if (evt.type === 'tick_end' || evt.type === 'tick_start') {
          send(evt.type, { ...evt, snapshot: brainLiveState.getSnapshot() });
        } else {
          send(evt.type, evt);
        }
      } catch (_) {
        /* client gone */
      }
    };
    const unsub = brainLiveState.subscribe(onUpdate);

    const heartbeat = setInterval(() => {
      try {
        res.write(`: heartbeat ${Date.now()}\n\n`);
      } catch (_) {
        /* ignore */
      }
    }, 15000);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsub();
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
  } catch (error) {
    console.error('Brain stream error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || 'Failed to open brain stream' });
    }
  }
});

module.exports = router;
