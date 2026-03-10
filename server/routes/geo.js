const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();
const GEO_PATH = path.join(__dirname, '../../config/geo.json');

// GET /api/geo — get geo config
router.get('/', (req, res) => {
  const config = JSON.parse(fs.readFileSync(GEO_PATH, 'utf-8'));
  res.json({ config });
});

// PUT /api/geo — update geo config
router.put('/', (req, res) => {
  const { config } = req.body;
  if (!config || typeof config !== 'object') {
    return res.status(400).json({ error: 'config must be an object' });
  }

  // Basic validation
  for (const [key, value] of Object.entries(config)) {
    if (!value.endpoint || typeof value.endpoint !== 'string') {
      return res.status(400).json({ error: `GEO entry "${key}" must have an endpoint string` });
    }
  }

  fs.writeFileSync(GEO_PATH, JSON.stringify(config, null, 2), 'utf-8');
  res.json({ ok: true, config });
});

// POST /api/geo/entry — add or update a single geo entry
router.post('/entry', (req, res) => {
  const { code, endpoint, label } = req.body;
  if (!code || !endpoint) {
    return res.status(400).json({ error: 'code and endpoint are required' });
  }

  const config = JSON.parse(fs.readFileSync(GEO_PATH, 'utf-8'));
  config[code.toUpperCase()] = { endpoint, label: label || code.toUpperCase() };
  fs.writeFileSync(GEO_PATH, JSON.stringify(config, null, 2), 'utf-8');
  res.json({ ok: true, config });
});

// DELETE /api/geo/entry/:code
router.delete('/entry/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const config = JSON.parse(fs.readFileSync(GEO_PATH, 'utf-8'));
  if (!config[code]) {
    return res.status(404).json({ error: `GEO code "${code}" not found` });
  }
  delete config[code];
  fs.writeFileSync(GEO_PATH, JSON.stringify(config, null, 2), 'utf-8');
  res.json({ ok: true, config });
});

module.exports = router;
