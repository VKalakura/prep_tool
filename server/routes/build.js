const express = require('express');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');

const router = express.Router();

function getSessionDir(sessionId) {
  return path.join(__dirname, '../sessions', sessionId);
}

function buildTree(dir, rootDir) {
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return items
    .filter((item) => !item.name.startsWith('_')) // hide internal files
    .map((item) => {
      const fullPath = path.join(dir, item.name);
      const relativePath = path.relative(rootDir, fullPath);
      if (item.isDirectory()) {
        return { name: item.name, path: relativePath, type: 'dir', children: buildTree(fullPath, rootDir) };
      }
      const stats = fs.statSync(fullPath);
      return { name: item.name, path: relativePath, type: 'file', size: stats.size };
    });
}

// GET /api/build/:sessionId/file-tree
router.get('/:sessionId/file-tree', (req, res) => {
  const sessionDir = getSessionDir(req.params.sessionId);
  if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: 'Session not found' });
  res.json({ tree: buildTree(sessionDir, sessionDir) });
});

// POST /api/build/:sessionId — zip and download
router.post('/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const sessionDir = getSessionDir(sessionId);

  if (!fs.existsSync(sessionDir)) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="offer-${sessionId.slice(0, 8)}.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => { console.error(err); res.status(500).end(); });
  archive.pipe(res);

  // Add all files except internal _* entries and raw/
  archive.glob('**/*', {
    cwd: sessionDir,
    ignore: ['_*', '_*/**', 'raw', 'raw/**'],
    dot: false,
  });

  archive.finalize();
});

module.exports = router;
