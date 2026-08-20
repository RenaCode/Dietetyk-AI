const express = require('express');
const router = express.Router();
const db = require('../db');

// Public health-check endpoint (NO authentication - it must be mounted in server.js
// BEFORE `app.use('/api', requireAuth)`). Used by:
//  - Docker HEALTHCHECK w docker/backend.Dockerfile,
//  - docker-compose.yml (healthcheck: dietetyk-backend),
//  - the "verify health-check after deploy" step in .github/workflows/docker-publish.yml.
//
// It checks not only that the Node process responds, but that SQLite is actually
// queryable - so a container can be "alive" (the process runs) and the health-check
// still reports a failure when, say, the database file is corrupt or the ./data volume
// was not mounted correctly.
router.get('/api/healthz', async (req, res) => {
  try {
    await db.get('SELECT 1 AS ok');
    res.json({
      status: 'ok',
      db: 'ok',
      uptime_seconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('[HEALTHCHECK] Database query failed:', err.message);
    res.status(503).json({ status: 'error', db: 'error', error: err.message });
  }
});

module.exports = router;
