const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const folderScanner = require('../services/folderScanner');
const fileNormalizer = require('../services/fileNormalizer');
const { formatHtml } = require('../services/htmlFormatter');

const router = express.Router();

const SESSIONS_DIR = path.join(__dirname, '../sessions');

// Use memoryStorage — we write files manually to preserve folder structure.
// multer v2 sanitises originalname (strips slashes) in all storage modes,
// so we send paths in a separate JSON field (req.body.filePaths) and use those instead.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 2000 },
});

// Sanitise a relative path: block traversal, keep normal subdir structure
function safePath(rel) {
  return (rel || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '..' && s !== '.')
    .join(path.sep);
}

// files array only — filePaths arrives as a text body field (not a file)
const uploadMiddleware = upload.array('files', 2000);

// Wrap multer to surface its errors as JSON
function runMulter(req, res, next) {
  uploadMiddleware(req, res, (err) => {
    if (err) {
      console.error('Multer error:', err);
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    }
    next();
  });
}

router.post('/', runMulter, async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    if (!sessionId) {
      return res.status(400).json({ error: 'X-Session-Id header is required' });
    }

    const filesField = req.files;

    if (!filesField || filesField.length === 0) {
      return res.status(400).json({ error: 'No files received. Make sure you selected a folder.' });
    }

    // Parse paths sent by the client as a text body field
    let paths = [];
    if (req.body?.filePaths) {
      try {
        paths = JSON.parse(req.body.filePaths);
      } catch {
        console.warn('filePaths field is not valid JSON — falling back to originalname');
      }
    }
    // Fallback: use originalname (may be sanitised by multer v2, but better than nothing)
    if (!paths.length) {
      paths = filesField.map((f) => f.originalname);
    }

    const rawDir = path.join(SESSIONS_DIR, sessionId, 'raw');
    const sessionDir = path.join(SESSIONS_DIR, sessionId);

    // Write each file preserving the folder structure from paths[]
    for (let i = 0; i < filesField.length; i++) {
      const rel = safePath(paths[i] || filesField[i].originalname);
      if (!rel) continue;
      const dest = path.join(rawDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, filesField[i].buffer);
    }

    // Find index.html anywhere in the raw tree
    const indexPath = folderScanner.findIndexHtml(rawDir);
    if (!indexPath) {
      fs.rmSync(rawDir, { recursive: true, force: true });
      return res.status(404).json({
        error: 'No index.html found in the uploaded folder.',
        filesUploaded: filesField.length,
      });
    }

    // Normalise: js/ css/ fonts/ img/ at sessionDir root, update all paths
    const norm = fileNormalizer.normalize(rawDir, indexPath, sessionDir);

    // Remove raw dir
    fs.rmSync(rawDir, { recursive: true, force: true });

    const newIndex = norm.newIndexPath;

    // Format the normalized HTML with Prettier
    const rawHtml = fs.readFileSync(newIndex, 'utf-8');
    const fmt = await formatHtml(rawHtml);
    if (fmt.success) fs.writeFileSync(newIndex, fmt.html, 'utf-8');

    const stats = fs.statSync(newIndex);

    res.json({
      sessionId,
      filesUploaded: filesField.length,
      indexPath: path.relative(sessionDir, newIndex),
      indexSize: stats.size,
      indexSizeKb: Math.round(stats.size / 1024),
      formatted: fmt.success,
      normalization: {
        moved: norm.moved,
        removed: norm.removed,
        warnings: norm.warnings.slice(0, 10),
      },
    });
  } catch (err) {
    console.error('Upload handler error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:sessionId', (req, res) => {
  const dir = path.join(SESSIONS_DIR, req.params.sessionId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  res.json({ ok: true });
});

module.exports = router;
