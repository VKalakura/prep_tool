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
  const sid = req.params.sessionId;
  const indexPath = getIndexPath(sid);
  if (!indexPath) return res.status(404).json({ error: 'index.html not found' });
  const content = fs.readFileSync(indexPath, 'utf-8');
  res.json({ scripts: htmlProcessor.extractScripts(content, getSessionDir(sid)) });
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

  // Parse string IDs like 'script-3' and 'noscript-0'
  const scriptIndices = scriptsToRemove
    .filter(id => String(id).startsWith('script-'))
    .map(id => parseInt(String(id).replace('script-', ''), 10))
    .filter(n => !isNaN(n));
  const noscriptIndices = new Set(
    scriptsToRemove
      .filter(id => String(id).startsWith('noscript-'))
      .map(id => parseInt(String(id).replace('noscript-', ''), 10))
      .filter(n => !isNaN(n))
  );

  const content = fs.readFileSync(indexPath, 'utf-8');

  // Get interactivity info before removing (so we can save it to removed-scripts log)
  const allScripts = htmlProcessor.extractScripts(content, sessionDir);
  const interactiveByIndex = new Map(allScripts.filter(s => !s.isNoscript).map(s => [s.index, s.isInteractive]));

  let { html, removed } = htmlProcessor.removeScripts(content, scriptIndices);

  // Remove selected noscript tags
  if (noscriptIndices.size > 0) {
    const $n = cheerio.load(html, { decodeEntities: false });
    $n('noscript').each((i, el) => { if (noscriptIndices.has(i)) $n(el).remove(); });
    html = $n.html();
  }

  fs.writeFileSync(indexPath, html, 'utf-8');

  // Delete local JS files and track which file was deleted per script
  const removedWithMeta = [];
  for (const script of removed) {
    let deletedFile = null;
    if (script.src) {
      const src = script.src.replace(/^\.\//, '');
      if (src.startsWith('js/') || src.match(/^[^/]+\.js$/)) {
        const localName = src.startsWith('js/') ? src : `js/${src}`;
        const filePath = path.join(sessionDir, localName);
        if (filePath.startsWith(path.join(sessionDir, 'js') + path.sep) && fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          deletedFile = localName;
        }
      }
    }
    removedWithMeta.push({
      ...script,
      isInteractive: interactiveByIndex.get(script.index) || false,
      deletedFile,
    });
  }

  // Remove empty asset directories
  removeEmptyDirs(sessionDir, ['js', 'css', 'img', 'fonts']);

  // Save removed scripts for potential restore
  appendRemovedScripts(sessionDir, removedWithMeta);

  logActivity(sid, 'clean-scripts', { removed: removed.length, deletedFiles: removedWithMeta.filter(r => r.deletedFile).length });
  res.json({ ok: true, removed, deletedFiles: removedWithMeta.filter(r => r.deletedFile).map(r => r.deletedFile), newSize: html.length });
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

// ─── Head items routes ────────────────────────────────────────────────────────

router.get('/:sessionId/head-items', (req, res) => {
  const indexPath = getIndexPath(req.params.sessionId);
  if (!indexPath) return res.status(404).json({ error: 'index.html not found' });
  const html = fs.readFileSync(indexPath, 'utf-8');
  res.json({ items: htmlProcessor.extractHeadItems(html) });
});

router.post('/:sessionId/clean-head', (req, res) => {
  const { indicesToRemove } = req.body;
  if (!Array.isArray(indicesToRemove)) return res.status(400).json({ error: 'indicesToRemove required' });
  const sid = req.params.sessionId;
  const indexPath = getIndexPath(sid);
  if (!indexPath) return res.status(404).json({ error: 'index.html not found' });

  const html = fs.readFileSync(indexPath, 'utf-8');
  const { html: newHtml, stats } = htmlProcessor.cleanHeadItems(html, indicesToRemove);
  fs.writeFileSync(indexPath, newHtml, 'utf-8');
  const total = stats.jsonld + stats.externalLinks + stats.meta;
  logActivity(sid, 'clean-head', { ...stats, total });
  res.json({ ok: true, stats, total });
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

  // Scan <style> tags for url() — catches @font-face declarations inline in HTML
  $('style').each((_, el) => {
    const css = $(el).text() || '';
    const re = /url\(\s*['"]?([^'"\)\n]+?)['"]?\s*\)/g;
    let m;
    while ((m = re.exec(css)) !== null) addRef(m[1]);
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

  // Scan CSS files for url() and @import — recursive to handle subdirectories like css/vendor/
  const cssDir = path.join(sessionDir, 'css');
  const scanCssDir = (dir, relBase) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) { scanCssDir(full, `${relBase}/${f.name}`); continue; }
      if (!f.name.endsWith('.css')) continue;
      const cssContent = fs.readFileSync(full, 'utf-8');

      const urlRe = /url\(\s*['"]?([^'"\)\n]+?)['"]?\s*\)/g;
      let m;
      while ((m = urlRe.exec(cssContent)) !== null) {
        // Strip query strings (?v=4.7.0) and fragments (#iefix) — common in icon font CSS
        const ref = m[1].trim().split('?')[0].split('#')[0];
        if (ref && !isExternalUrl(ref)) {
          // Resolve relative to this CSS file's location
          const resolved = path.normalize(path.join(relBase, ref)).replace(/\\/g, '/');
          refs.add(resolved);
        }
      }

      const importRe = /@import\s+(?:url\(\s*['"]?([^'"\)\n]+?)['"]?\s*\)|['"]([^'"]+)['"])/g;
      while ((m = importRe.exec(cssContent)) !== null) {
        const ref = (m[1] || m[2] || '').trim();
        if (ref && !isExternalUrl(ref)) {
          const resolved = path.normalize(path.join(relBase, ref)).replace(/\\/g, '/');
          refs.add(resolved);
        }
      }
    }
  };
  scanCssDir(cssDir, 'css');

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

// ─── POST /:id/auto-clean — silent smart clean for Standard mode ──────────────
router.post('/:sessionId/auto-clean', (req, res) => {
  const sid = req.params.sessionId;
  const sessionDir = getSessionDir(sid);
  const indexPath = getIndexPath(sid);
  if (!indexPath) return res.status(404).json({ error: 'index.html not found' });

  let scriptsRemoved = 0, scriptsPreserved = 0, iframesRemoved = 0, unusedDeleted = 0, headCleaned = 0;

  let currentHtml = fs.readFileSync(indexPath, 'utf-8');

  // 0. Head cleanup: schema.org, external scripts/links, meta (except charset + viewport)
  const headResult = htmlProcessor.cleanHead(currentHtml);
  currentHtml = headResult.html;
  headCleaned = headResult.total;

  // 1. Smart script removal: keep interactive scripts (they control page elements)
  const scripts = htmlProcessor.extractScripts(currentHtml, sessionDir);

  // Keep only scripts with suggestion 'keep' (interactive UI + critical libs that are actually used)
  // Everything else: tracking, form handlers, unknown, orphaned dependencies → remove
  const toRemoveIndices = scripts.filter(s => s.suggestion !== 'keep').map(s => s.index);
  const toKeep = scripts.filter(s => s.suggestion === 'keep');
  scriptsPreserved = toKeep.length;

  if (toRemoveIndices.length) {
    const result = htmlProcessor.removeScripts(currentHtml, toRemoveIndices);
    currentHtml = result.html;
    scriptsRemoved = toRemoveIndices.length;

    const removedWithMeta = [];
    for (const script of result.removed) {
      let deletedFile = null;
      if (script.src) {
        const src = script.src.replace(/^\.\//, '');
        if (src.startsWith('js/') || src.match(/^[^/]+\.js$/)) {
          const localName = src.startsWith('js/') ? src : `js/${src}`;
          const filePath = path.join(sessionDir, localName);
          if (filePath.startsWith(path.join(sessionDir, 'js') + path.sep) && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            deletedFile = localName;
          }
        }
      }
      removedWithMeta.push({ ...script, isInteractive: false, deletedFile });
    }
    appendRemovedScripts(sessionDir, removedWithMeta);
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

  logActivity(sid, 'auto-clean', { scriptsRemoved, scriptsPreserved, iframesRemoved, unusedDeleted, headCleaned });
  res.json({ ok: true, scriptsRemoved, scriptsPreserved, iframesRemoved, unusedDeleted, headCleaned });
});

// ─── Helper: append removed scripts to _removed_scripts.json ─────────────────
function appendRemovedScripts(sessionDir, removedList) {
  const filePath = path.join(sessionDir, '_removed_scripts.json');
  let existing = [];
  try {
    if (fs.existsSync(filePath)) existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {}

  const now = new Date().toISOString();
  const toAppend = removedList.map(r => ({
    id: `script-${Date.now()}-${r.index}`,
    index: r.index,
    src: r.src || null,
    outerHtml: r.outerHtml,
    inlineContent: r.inlineContent || null,
    isInteractive: r.isInteractive || false,
    position: r.position || 'body',
    deletedFile: r.deletedFile || null,
    removedAt: now,
  }));

  fs.writeFileSync(filePath, JSON.stringify([...existing, ...toAppend], null, 2));
}

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
