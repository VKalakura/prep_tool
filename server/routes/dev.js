const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();
const SESSIONS_DIR = path.join(__dirname, '../sessions');

function getSessionDir(sid) { return path.join(SESSIONS_DIR, sid); }

function safePath(rel) {
  return (rel || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(s => s && s !== '..' && s !== '.')
    .join(path.sep);
}

function buildTree(dir, root) {
  root = root || dir;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(e => !e.name.startsWith('_'))
    .map(e => {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (e.isDirectory()) {
        return { name: e.name, path: rel, type: 'dir', children: buildTree(full, root) };
      }
      return { name: e.name, path: rel, type: 'file', size: fs.statSync(full).size };
    });
}

// GET /:sessionId/state — full session overview for dev
router.get('/:sessionId/state', (req, res) => {
  const sid = req.params.sessionId;
  const sessionDir = getSessionDir(sid);
  if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: 'Session not found' });

  let config = {};
  const configPath = path.join(sessionDir, '_offer_config.json');
  if (fs.existsSync(configPath)) {
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch {}
  }

  let log = [];
  const logPath = path.join(sessionDir, '_activity_log.json');
  if (fs.existsSync(logPath)) {
    try { log = JSON.parse(fs.readFileSync(logPath, 'utf-8')); } catch {}
  }

  let meta = {};
  const metaPath = path.join(sessionDir, '_session_meta.json');
  if (fs.existsSync(metaPath)) {
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch {}
  }

  const stat = fs.statSync(sessionDir);

  res.json({
    sessionId: sid,
    config,
    log,
    tree: buildTree(sessionDir),
    createdAt: stat.birthtime,
    lastActivity: meta.lastActivity || stat.mtime,
  });
});

// GET /:sessionId/file?path=css/style.css
router.get('/:sessionId/file', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path query param required' });

  const sid = req.params.sessionId;
  const sessionDir = getSessionDir(sid);
  const full = path.join(sessionDir, safePath(filePath));

  if (!full.startsWith(sessionDir + path.sep) && full !== sessionDir) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'File not found' });

  try {
    const content = fs.readFileSync(full, 'utf-8');
    res.json({ content, path: filePath, size: content.length });
  } catch {
    res.status(400).json({ error: 'Cannot read file (binary?)' });
  }
});

// PUT /:sessionId/file — save edited file
router.put('/:sessionId/file', (req, res) => {
  const { path: filePath, content } = req.body;
  if (!filePath || content === undefined) {
    return res.status(400).json({ error: 'path and content required' });
  }

  const sid = req.params.sessionId;
  const sessionDir = getSessionDir(sid);
  const full = path.join(sessionDir, safePath(filePath));

  if (!full.startsWith(sessionDir + path.sep)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
  res.json({ ok: true });
});

module.exports = router;
