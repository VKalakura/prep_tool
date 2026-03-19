const express = require('express');
const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const { logActivity } = require('../services/activityLogger');

const router = express.Router();
const SESSIONS_DIR = path.join(__dirname, '../sessions');

function getSessionDir(sid) { return path.join(SESSIONS_DIR, sid); }

function generateId() {
  return Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
}

function copyDirRecursive(src, dest, skip) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.includes(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyDirRecursive(s, d, skip);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

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

function countFilesInDir(dir) {
  let count = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('_')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) count += countFilesInDir(full);
      else count++;
    }
  } catch {}
  return count;
}

// ─── GET /sessions — list all active sessions (must be before /:sessionId routes)
router.get('/sessions', (req, res) => {
  if (!fs.existsSync(SESSIONS_DIR)) return res.json({ sessions: [] });

  const sessions = [];
  for (const e of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const sid = e.name;
    const sessionDir = getSessionDir(sid);

    let config = {};
    try {
      const p = path.join(sessionDir, '_offer_config.json');
      if (fs.existsSync(p)) config = JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {}

    let meta = {};
    try {
      const p = path.join(sessionDir, '_session_meta.json');
      if (fs.existsSync(p)) meta = JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {}

    const stat = fs.statSync(sessionDir);
    sessions.push({
      sessionId: sid,
      offerName: config.offerName || null,
      countryCode: config.countryCode || null,
      createdAt: stat.birthtime,
      lastActivity: meta.lastActivity || stat.mtime,
      fileCount: countFilesInDir(sessionDir),
    });
  }

  sessions.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
  res.json({ sessions });
});

// ─── GET /:sessionId/ping — poll for dev-made changes only
router.get('/:sessionId/ping', (req, res) => {
  const sid = req.params.sessionId;
  const sessionDir = getSessionDir(sid);
  if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: 'not found' });

  let lastDevActivity = null;
  try {
    const p = path.join(sessionDir, '_session_meta.json');
    if (fs.existsSync(p)) {
      const meta = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (meta.lastDevActivity) lastDevActivity = meta.lastDevActivity;
    }
  } catch {}

  res.json({ lastDevActivity });
});

// ─── GET /:sessionId/state — full session overview for dev
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

// ─── GET /:sessionId/file?path=css/style.css
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

// ─── PUT /:sessionId/file — save edited file
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
  logActivity(sid, 'dev-save', { path: filePath });

  // Write lastDevActivity separately so standard client can detect dev changes
  const metaPath = path.join(sessionDir, '_session_meta.json');
  let meta = {};
  try { if (fs.existsSync(metaPath)) meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch {}
  meta.lastDevActivity = new Date().toISOString();
  fs.writeFileSync(metaPath, JSON.stringify(meta));

  res.json({ ok: true });
});

// ─── GET /:sessionId/removed-scripts — list all scripts saved during cleaning ─
router.get('/:sessionId/removed-scripts', (req, res) => {
  const sid = req.params.sessionId;
  const sessionDir = getSessionDir(sid);
  const filePath = path.join(sessionDir, '_removed_scripts.json');

  if (!fs.existsSync(filePath)) return res.json({ scripts: [] });

  try {
    const scripts = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    res.json({ scripts });
  } catch {
    res.json({ scripts: [] });
  }
});

// ─── POST /:sessionId/restore-script — restore a previously removed script ───
router.post('/:sessionId/restore-script', (req, res) => {
  const { scriptId } = req.body;
  if (!scriptId) return res.status(400).json({ error: 'scriptId required' });

  const sid = req.params.sessionId;
  const sessionDir = getSessionDir(sid);
  const removedPath = path.join(sessionDir, '_removed_scripts.json');

  if (!fs.existsSync(removedPath)) return res.status(404).json({ error: 'No removed scripts found' });

  let removed;
  try { removed = JSON.parse(fs.readFileSync(removedPath, 'utf-8')); }
  catch { return res.status(500).json({ error: 'Cannot read removed scripts' }); }

  const script = removed.find(s => s.id === scriptId);
  if (!script) return res.status(404).json({ error: 'Script not found' });

  // 1. Restore the JS file from _originals/ if it was deleted
  let fileRestored = false;
  if (script.deletedFile) {
    const originalsDir = path.join(sessionDir, '_originals');
    const origFile = path.join(originalsDir, script.deletedFile);
    const destFile = path.join(sessionDir, script.deletedFile);
    if (fs.existsSync(origFile) && !fs.existsSync(destFile)) {
      try {
        fs.mkdirSync(path.dirname(destFile), { recursive: true });
        fs.copyFileSync(origFile, destFile);
        fileRestored = true;
      } catch {}
    }
  }

  // 2. Inject the script tag back into the HTML
  let indexPath = null;
  for (const name of ['index.html', 'index.php']) {
    const p = path.join(sessionDir, name);
    if (fs.existsSync(p)) { indexPath = p; break; }
  }
  if (!indexPath) return res.status(404).json({ error: 'index.html not found' });

  const html = fs.readFileSync(indexPath, 'utf-8');
  const $ = cheerio.load(html, { decodeEntities: false });

  if (script.position === 'head') {
    $('head').append(script.outerHtml);
  } else {
    $('body').append(script.outerHtml);
  }

  fs.writeFileSync(indexPath, $.html(), 'utf-8');

  // 3. Remove from _removed_scripts.json
  const updated = removed.filter(s => s.id !== scriptId);
  fs.writeFileSync(removedPath, JSON.stringify(updated, null, 2));

  logActivity(sid, 'restore-script', { src: script.src || '(inline)', id: scriptId, fileRestored });
  res.json({ ok: true, fileRestored });
});

// ─── POST /:sessionId/clone-originals — create new dev session from pre-clean snapshot
// _originals/ contains only text files (html/css/js etc.) — binary files (videos, images)
// are never modified by auto-clean, so we copy them from the current session to save disk.
router.post('/:sessionId/clone-originals', (req, res) => {
  const sid = req.params.sessionId;
  const sessionDir = getSessionDir(sid);
  const originalsDir = path.join(SESSIONS_DIR, sid, '_originals');
  if (!fs.existsSync(originalsDir)) {
    return res.status(404).json({ error: 'No originals backup found. Session was uploaded before this feature was added — please re-upload.' });
  }

  const newSid = generateId();
  const newSessionDir = path.join(SESSIONS_DIR, newSid);
  fs.mkdirSync(newSessionDir, { recursive: true });

  // 1. Copy binary files from current session (unmodified by auto-clean)
  copyDirRecursive(sessionDir, newSessionDir, ['_originals', '_tmp', '_activity_log.json', '_session_meta.json', '_offer_config.json']);
  // 2. Overwrite with originals (text files — restores pre-clean HTML/CSS/JS)
  copyDirRecursive(originalsDir, newSessionDir, []);

  logActivity(newSid, 'clone-from', { source: sid });
  res.json({ sessionId: newSid });
});

// ─── POST /:sessionId/push-to/:targetSid — copy current files to buyer session
router.post('/:sessionId/push-to/:targetSid', (req, res) => {
  const sid = req.params.sessionId;
  const targetSid = req.params.targetSid;
  const srcDir = path.join(SESSIONS_DIR, sid);
  const targetDir = path.join(SESSIONS_DIR, targetSid);

  if (!fs.existsSync(targetDir)) return res.status(404).json({ error: 'Target session not found' });

  const SKIP = ['_originals', '_activity_log.json', '_session_meta.json', '_offer_config.json'];
  copyDirRecursive(srcDir, targetDir, SKIP);

  // Update lastDevActivity in target so buyer gets notified
  const metaPath = path.join(targetDir, '_session_meta.json');
  let meta = {};
  try { if (fs.existsSync(metaPath)) meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch {}
  meta.lastDevActivity = new Date().toISOString();
  fs.writeFileSync(metaPath, JSON.stringify(meta));

  logActivity(sid, 'push-to', { target: targetSid });
  res.json({ ok: true });
});

module.exports = router;
