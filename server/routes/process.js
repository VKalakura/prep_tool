const express = require('express');
const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const htmlProcessor = require('../services/htmlProcessor');
const { logActivity } = require('../services/activityLogger');

const router = express.Router();

function getSessionDir(sessionId) {
  return path.join(__dirname, '../sessions', sessionId);
}

function getIndexPath(sessionId) {
  const dir = getSessionDir(sessionId);
  const html = path.join(dir, 'index.html');
  const php = path.join(dir, 'index.php');
  if (fs.existsSync(html)) return html;
  if (fs.existsSync(php)) return php;
  return null;
}

// ─── Existing routes ──────────────────────────────────────────────────────────

router.get('/:sessionId/html', (req, res) => {
  const indexPath = getIndexPath(req.params.sessionId);
  if (!indexPath) return res.status(404).json({ error: 'index.html not found' });
  const content = fs.readFileSync(indexPath, 'utf-8');
  res.json({ content, size: content.length, lines: content.split('\n').length });
});

router.get('/:sessionId/scripts', (req, res) => {
  const indexPath = getIndexPath(req.params.sessionId);
  if (!indexPath) return res.status(404).json({ error: 'index.html not found' });
  const content = fs.readFileSync(indexPath, 'utf-8');
  res.json({ scripts: htmlProcessor.extractScripts(content) });
});

router.post('/:sessionId/clean', (req, res) => {
  const { scriptsToRemove } = req.body;
  if (!Array.isArray(scriptsToRemove)) {
    return res.status(400).json({ error: 'scriptsToRemove must be an array' });
  }
  const sid = req.params.sessionId;
  const sessionDir = getSessionDir(sid);
  const indexPath = getIndexPath(sid);
  if (!indexPath) return res.status(404).json({ error: 'index.html not found' });

  const content = fs.readFileSync(indexPath, 'utf-8');
  const { html, removed } = htmlProcessor.removeScripts(content, scriptsToRemove);
  fs.writeFileSync(indexPath, html, 'utf-8');

  // Auto-delete local JS files that were removed from HTML
  const deletedFiles = [];
  for (const script of removed) {
    if (!script.src) continue; // inline script — nothing to delete
    // Only delete files inside js/ directory
    const src = script.src.replace(/^\.\//, '');
    if (!src.startsWith('js/') && !src.match(/^[^/]+\.js$/)) continue;
    const localName = src.startsWith('js/') ? src : `js/${src}`;
    const filePath = path.join(sessionDir, localName);
    // Guard: must be inside sessionDir/js/
    if (!filePath.startsWith(path.join(sessionDir, 'js') + path.sep)) continue;
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      deletedFiles.push(localName);
    }
  }

  // Remove empty asset directories
  removeEmptyDirs(sessionDir, ['js', 'css', 'img', 'fonts']);

  logActivity(sid, 'clean-scripts', { removed: removed.length, deletedFiles: deletedFiles.length });
  res.json({ ok: true, removed, deletedFiles, newSize: html.length });
});

router.post('/:sessionId/inject', (req, res) => {
  const { snippet, position } = req.body;
  if (!snippet || !position) return res.status(400).json({ error: 'snippet and position required' });
  const indexPath = getIndexPath(req.params.sessionId);
  if (!indexPath) return res.status(404).json({ error: 'index.html not found' });

  const content = fs.readFileSync(indexPath, 'utf-8');
  const html = htmlProcessor.injectSnippet(content, snippet, position);
  fs.writeFileSync(indexPath, html, 'utf-8');
  res.json({ ok: true, newSize: html.length });
});

router.get('/:sessionId/insertion-points', (req, res) => {
  const indexPath = getIndexPath(req.params.sessionId);
  if (!indexPath) return res.status(404).json({ error: 'index.html not found' });
  const content = fs.readFileSync(indexPath, 'utf-8');
  res.json({ points: htmlProcessor.detectInsertionPoints(content) });
});

router.post('/:sessionId/save-html', (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
  const indexPath = getIndexPath(req.params.sessionId);
  if (!indexPath) return res.status(404).json({ error: 'index.html not found' });
  fs.writeFileSync(indexPath, content, 'utf-8');
  res.json({ ok: true });
});

// ─── iFrame routes ────────────────────────────────────────────────────────────

router.get('/:sessionId/iframes', (req, res) => {
  const indexPath = getIndexPath(req.params.sessionId);
  if (!indexPath) return res.status(404).json({ error: 'not found' });

  const $ = cheerio.load(fs.readFileSync(indexPath, 'utf-8'), { decodeEntities: false });
  const iframes = [];

  $('iframe').each((i, el) => {
    iframes.push({
      index: i,
      src: $(el).attr('src') || null,
      width: $(el).attr('width') || $(el).css('width') || null,
      height: $(el).attr('height') || $(el).css('height') || null,
      outerHtml: $.html(el).slice(0, 400),
    });
  });

  res.json({ iframes });
});

router.post('/:sessionId/clean-iframes', (req, res) => {
  const { indicesToRemove } = req.body;
  if (!Array.isArray(indicesToRemove)) {
    return res.status(400).json({ error: 'indicesToRemove must be an array' });
  }

  const sid = req.params.sessionId;
  const indexPath = getIndexPath(sid);
  if (!indexPath) return res.status(404).json({ error: 'not found' });

  const $ = cheerio.load(fs.readFileSync(indexPath, 'utf-8'), { decodeEntities: false });
  const toRemove = new Set(indicesToRemove.map(Number));
  let removed = 0;

  $('iframe').each((i, el) => {
    if (toRemove.has(i)) { $(el).remove(); removed++; }
  });

  fs.writeFileSync(indexPath, $.html(), 'utf-8');
  logActivity(sid, 'clean-iframes', { removed });
  res.json({ ok: true, removed });
});

// ─── Unused files routes ──────────────────────────────────────────────────────

function isExternalUrl(url) {
  if (!url) return true;
  const u = url.trim();
  return u.startsWith('http://') || u.startsWith('https://') ||
    u.startsWith('//') || u.startsWith('data:') ||
    u.startsWith('blob:') || u.startsWith('#') || u.startsWith('mailto:');
}

function collectAllRefs(sessionDir) {
  const refs = new Set();

  let indexPath;
  for (const name of ['index.html', 'index.php']) {
    const p = path.join(sessionDir, name);
    if (fs.existsSync(p)) { indexPath = p; break; }
  }
  if (!indexPath) return refs;

  const $ = cheerio.load(fs.readFileSync(indexPath, 'utf-8'), { decodeEntities: false });

  const addRef = (val) => {
    if (!val) return;
    const clean = val.trim().split('?')[0].split('#')[0];
    if (!clean || isExternalUrl(clean)) return;
    refs.add(clean.replace(/^\//, ''));
  };

  $('[src]').each((_, el) => addRef($(el).attr('src')));
  $('link[href]').each((_, el) => addRef($(el).attr('href')));
  ['data-src', 'data-background', 'data-original', 'data-lazy'].forEach(attr => {
    $(`[${attr}]`).each((_, el) => addRef($(el).attr(attr)));
  });
  $('meta[property="og:image"], meta[name="twitter:image"]').each((_, el) => addRef($(el).attr('content')));
  $('[style]').each((_, el) => {
    const style = $(el).attr('style') || '';
    const re = /url\(\s*['"]?([^'"\)\n]+?)['"]?\s*\)/g;
    let m;
    while ((m = re.exec(style)) !== null) addRef(m[1]);
  });

  // Include widgets/ files (they ARE referenced via injected tags, count as used)
  const widgetsDir = path.join(sessionDir, 'widgets');
  if (fs.existsSync(widgetsDir)) {
    const collect = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) collect(full);
        else refs.add(path.relative(sessionDir, full).replace(/\\/g, '/'));
      }
    };
    collect(widgetsDir);
  }

  // Scan CSS files for url() and @import
  const cssDir = path.join(sessionDir, 'css');
  if (fs.existsSync(cssDir)) {
    for (const f of fs.readdirSync(cssDir)) {
      if (!f.endsWith('.css')) continue;
      const cssContent = fs.readFileSync(path.join(cssDir, f), 'utf-8');

      const urlRe = /url\(\s*['"]?([^'"\)\n]+?)['"]?\s*\)/g;
      let m;
      while ((m = urlRe.exec(cssContent)) !== null) {
        const ref = m[1].trim();
        if (!isExternalUrl(ref)) {
          // CSS files are in css/, so ../img/file.png → img/file.png
          const resolved = path.normalize(path.join('css', ref)).replace(/\\/g, '/');
          refs.add(resolved);
        }
      }

      const importRe = /@import\s+(?:url\(\s*['"]?([^'"\)\n]+?)['"]?\s*\)|['"]([^'"]+)['"])/g;
      while ((m = importRe.exec(cssContent)) !== null) {
        const ref = (m[1] || m[2] || '').trim();
        if (ref && !isExternalUrl(ref)) refs.add(`css/${ref}`);
      }
    }
  }

  return refs;
}

router.get('/:sessionId/unused-files', (req, res) => {
  const sessionDir = getSessionDir(req.params.sessionId);
  if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: 'session not found' });

  const refs = collectAllRefs(sessionDir);
  const unused = [];

  for (const folder of ['js', 'css', 'img', 'fonts']) {
    const dir = path.join(sessionDir, folder);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (!fs.statSync(full).isFile()) continue;
      const rel = `${folder}/${f}`;
      if (!refs.has(rel)) unused.push({ path: rel, size: fs.statSync(full).size });
    }
  }

  res.json({ files: unused });
});

router.post('/:sessionId/clean-unused', (req, res) => {
  const { filePaths } = req.body;
  if (!Array.isArray(filePaths)) return res.status(400).json({ error: 'filePaths required' });

  const sid = req.params.sessionId;
  const sessionDir = getSessionDir(sid);
  let deleted = 0;

  for (const relPath of filePaths) {
    const safe = relPath.replace(/\\/g, '/');
    // Only allow deleting within asset subdirs — prevent traversal
    if (!safe.match(/^(js|css|img|fonts)\/[^/]+$/)) continue;
    const full = path.join(sessionDir, safe);
    if (fs.existsSync(full) && full.startsWith(sessionDir)) {
      fs.unlinkSync(full);
      deleted++;
    }
  }

  // Remove empty asset directories
  removeEmptyDirs(sessionDir, ['js', 'css', 'img', 'fonts']);

  logActivity(sid, 'clean-unused', { deleted });
  res.json({ ok: true, deleted });
});

// ─── GET /:id/stats ───────────────────────────────────────────────────────────
router.get('/:sessionId/stats', (req, res) => {
  const sid = req.params.sessionId;
  const sessionDir = getSessionDir(sid);
  if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: 'session not found' });

  // Read activity log
  const logPath = path.join(sessionDir, '_activity_log.json');
  const log = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf-8')) : [];

  // Aggregate stats from log
  let scriptsRemoved = 0, iframesRemoved = 0, unusedDeleted = 0,
      jsFilesDeleted = 0, imagesCompressed = 0, textSaved = 0;

  for (const entry of log) {
    if (entry.action === 'clean-scripts') {
      scriptsRemoved += entry.removed || 0;
      jsFilesDeleted += entry.deletedFiles || 0;
    }
    if (entry.action === 'clean-iframes') iframesRemoved += entry.removed || 0;
    if (entry.action === 'clean-unused') unusedDeleted += entry.deleted || 0;
    if (entry.action === 'compress-image' || entry.action === 'compress-all') {
      imagesCompressed += entry.files || 1;
    }
    if (entry.action === 'save-text' || entry.action === 'bulk-replace') {
      textSaved += entry.applied || 1;
    }
  }

  // Current file count
  let totalFiles = 0, totalSize = 0;
  function countFiles(dir) {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (f.startsWith('_')) continue;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) countFiles(full);
      else { totalFiles++; totalSize += stat.size; }
    }
  }
  countFiles(sessionDir);

  res.json({
    scriptsRemoved, iframesRemoved, unusedDeleted,
    jsFilesDeleted, imagesCompressed, textSaved,
    totalFiles, totalSizeKb: Math.round(totalSize / 1024),
  });
});

// ─── POST /:id/auto-clean — silent full clean for Standard mode ───────────────
router.post('/:sessionId/auto-clean', (req, res) => {
  const sid = req.params.sessionId;
  const sessionDir = getSessionDir(sid);
  const indexPath = getIndexPath(sid);
  if (!indexPath) return res.status(404).json({ error: 'index.html not found' });

  let scriptsRemoved = 0, iframesRemoved = 0, unusedDeleted = 0;

  // 1. Remove all tracking scripts
  let currentHtml = fs.readFileSync(indexPath, 'utf-8');
  const scripts = htmlProcessor.extractScripts(currentHtml);
  const allIndices = scripts.map(s => s.index);
  if (allIndices.length) {
    const result = htmlProcessor.removeScripts(currentHtml, allIndices);
    currentHtml = result.html;
    scriptsRemoved = allIndices.length;
    for (const script of result.removed) {
      if (!script.src) continue;
      const src = script.src.replace(/^\.\//, '');
      if (!src.startsWith('js/') && !src.match(/^[^/]+\.js$/)) continue;
      const localName = src.startsWith('js/') ? src : `js/${src}`;
      const filePath = path.join(sessionDir, localName);
      if (!filePath.startsWith(path.join(sessionDir, 'js') + path.sep)) continue;
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  }

  // 2. Remove all iframes
  const $ = cheerio.load(currentHtml, { decodeEntities: false });
  $('iframe').each((i, el) => { $(el).remove(); iframesRemoved++; });
  currentHtml = $.html();
  fs.writeFileSync(indexPath, currentHtml, 'utf-8');

  // 3. Delete unused files
  const refs = collectAllRefs(sessionDir);
  for (const folder of ['js', 'css', 'img', 'fonts']) {
    const dir = path.join(sessionDir, folder);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (!fs.statSync(full).isFile()) continue;
      const rel = `${folder}/${f}`;
      if (!refs.has(rel)) { fs.unlinkSync(full); unusedDeleted++; }
    }
  }
  removeEmptyDirs(sessionDir, ['js', 'css', 'img', 'fonts']);

  logActivity(sid, 'auto-clean', { scriptsRemoved, iframesRemoved, unusedDeleted });
  res.json({ ok: true, scriptsRemoved, iframesRemoved, unusedDeleted });
});

// ─── Helper: remove empty asset subdirs ───────────────────────────────────────
function removeEmptyDirs(sessionDir, folders) {
  for (const folder of folders) {
    const dir = path.join(sessionDir, folder);
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir);
      if (entries.length === 0) fs.rmdirSync(dir);
    } catch {}
  }
}

module.exports = router;
