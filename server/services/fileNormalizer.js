const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const FONT_EXTS = new Set(['.woff', '.woff2', '.ttf', '.eot', '.otf']);
const IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.avif', '.bmp']);
const JS_EXTS = new Set(['.js', '.mjs']);
const CSS_EXTS = new Set(['.css']);

function isExternal(url) {
  if (!url) return true;
  const u = url.trim();
  return (
    u.startsWith('http://') || u.startsWith('https://') ||
    u.startsWith('//') || u.startsWith('data:') ||
    u.startsWith('blob:') || u.startsWith('#') || u.startsWith('mailto:')
  );
}

function cleanRef(ref) {
  if (!ref) return null;
  return ref.trim().split('?')[0].split('#')[0].trim() || null;
}

// Resolve a reference to an absolute path.
// Root-relative (/) refs are resolved from sessionRawDir.
function resolveRef(fromDir, sessionRawDir, ref) {
  const clean = cleanRef(ref);
  if (!clean || isExternal(ref)) return null;
  if (clean.startsWith('/')) {
    return path.resolve(sessionRawDir, clean.slice(1));
  }
  return path.resolve(fromDir, clean);
}

function getFolderForExt(ext) {
  if (FONT_EXTS.has(ext)) return 'fonts';
  if (IMG_EXTS.has(ext)) return 'img';
  if (JS_EXTS.has(ext)) return 'js';
  if (CSS_EXTS.has(ext)) return 'css';
  return null;
}

function collectAllFiles(dir, results = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collectAllFiles(full, results);
    else results.push(full);
  }
  return results;
}

function removeEmptyDirs(dir, root) {
  if (dir === root) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) removeEmptyDirs(path.join(dir, e.name), root);
  }
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {}
}

/**
 * Normalize offer folder structure.
 *
 * @param {string} rawDir   - Source dir (where messy uploaded files live)
 * @param {string} indexPath - Absolute path to the found index.html inside rawDir
 * @param {string} destDir   - Where normalized output goes (e.g. sessions/<id>/)
 *
 * Output in destDir:
 *   index.html
 *   js/
 *   css/
 *   fonts/
 *   img/
 */
function normalize(rawDir, indexPath, destDir) {
  const indexDir = path.dirname(indexPath);

  for (const d of ['js', 'css', 'fonts', 'img']) {
    fs.mkdirSync(path.join(destDir, d), { recursive: true });
  }

  // fileMap: absOrigPath → { folder, newName, newRel, updatedContent? }
  const fileMap = new Map();
  const usedNames = { js: new Set(), css: new Set(), fonts: new Set(), img: new Set() };
  const warnings = [];

  function uniqueName(folder, basename) {
    const base = path.basename(basename);
    let name = base;
    let i = 1;
    while (usedNames[folder].has(name.toLowerCase())) {
      const ext = path.extname(base);
      name = `${path.basename(base, ext)}_${i}${ext}`;
      i++;
    }
    usedNames[folder].add(name.toLowerCase());
    return name;
  }

  function registerFile(absPath, folder) {
    if (!usedNames[folder]) return null; // unknown folder
    if (fileMap.has(absPath)) return fileMap.get(absPath).newRel;
    const name = uniqueName(folder, path.basename(absPath));
    const newRel = `${folder}/${name}`;
    fileMap.set(absPath, { folder, newName: name, newRel });
    return newRel;
  }

  function processAttr($, el, attr, folder) {
    const val = $(el).attr(attr);
    if (!val || isExternal(val)) return;
    const abs = resolveRef(indexDir, rawDir, val);
    if (!abs) return;
    if (!fs.existsSync(abs)) { warnings.push(`Not found: ${val}`); return; }
    const newRel = registerFile(abs, folder);
    if (newRel) $(el).attr(attr, newRel);
  }

  function processAttrAuto($, el, attr) {
    const val = $(el).attr(attr);
    if (!val || isExternal(val)) return;
    const ext = path.extname(cleanRef(val) || '').toLowerCase();
    const folder = getFolderForExt(ext);
    if (folder) processAttr($, el, attr, folder);
  }

  function processSrcset($, el, attr) {
    const val = $(el).attr(attr);
    if (!val) return;
    const updated = val.split(',').map((part) => {
      const tokens = part.trim().split(/\s+/);
      const ref = tokens[0];
      if (!ref || isExternal(ref)) return part.trim();
      const abs = resolveRef(indexDir, rawDir, ref);
      if (!abs || !fs.existsSync(abs)) return part.trim();
      const newRel = registerFile(abs, 'img');
      if (newRel) tokens[0] = newRel;
      return tokens.join(' ');
    }).join(', ');
    $(el).attr(attr, updated);
  }

  // --- Parse HTML ---
  const html = fs.readFileSync(indexPath, 'utf-8');
  const $ = cheerio.load(html, { decodeEntities: false });

  // CSS
  $('link[rel="stylesheet"], link[as="style"], link[rel="preload"][as="style"]').each((_, el) => processAttr($, el, 'href', 'css'));
  $('link[rel="preload"][as="script"]').each((_, el) => processAttr($, el, 'href', 'js'));
  $('link[rel="preload"][as="font"]').each((_, el) => processAttr($, el, 'href', 'fonts'));

  // JS
  $('script[src]').each((_, el) => processAttr($, el, 'src', 'js'));

  // Images
  $('img').each((_, el) => {
    processAttr($, el, 'src', 'img');
    ['data-src', 'data-original', 'data-lazy', 'data-bg'].forEach((a) => processAttr($, el, a, 'img'));
    processSrcset($, el, 'srcset');
    processSrcset($, el, 'data-srcset');
  });
  $('picture source').each((_, el) => {
    processAttr($, el, 'src', 'img');
    processSrcset($, el, 'srcset');
  });
  $('video').each((_, el) => {
    processAttr($, el, 'poster', 'img');
    processAttr($, el, 'src', 'img');
  });
  $('video source, audio source').each((_, el) => processAttr($, el, 'src', 'img'));
  $('[data-background]').each((_, el) => processAttr($, el, 'data-background', 'img'));

  // Favicons / manifest
  $('link[rel*="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]').each((_, el) =>
    processAttrAuto($, el, 'href')
  );

  // OG meta
  $('meta[property="og:image"], meta[name="twitter:image"]').each((_, el) => {
    const val = $(el).attr('content');
    if (!val || isExternal(val)) return;
    const abs = resolveRef(indexDir, rawDir, val);
    if (abs && fs.existsSync(abs)) $(el).attr('content', registerFile(abs, 'img') || val);
  });

  // Inline style url()
  $('[style]').each((_, el) => {
    const style = $(el).attr('style');
    if (!style || !style.includes('url(')) return;
    const updated = style.replace(/url\(\s*['"]?([^'"\)\n]+?)['"]?\s*\)/g, (m, ref) => {
      if (isExternal(ref)) return m;
      const abs = resolveRef(indexDir, rawDir, ref);
      if (!abs || !fs.existsSync(abs)) return m;
      const ext = path.extname(abs).toLowerCase();
      const folder = IMG_EXTS.has(ext) ? 'img' : FONT_EXTS.has(ext) ? 'fonts' : null;
      if (!folder) return m;
      const newRel = registerFile(abs, folder);
      return newRel ? `url('${newRel}')` : m;
    });
    $(el).attr('style', updated);
  });

  // --- Follow @import in CSS files to discover transitively referenced CSS ---
  // Do this BEFORE the url() pass so all CSS files are registered in fileMap first.
  {
    const IMPORT_RE = /@import\s+(?:url\(\s*['"]?([^'"\)\n]+?)['"]?\s*\)|['"]([^'"]+)['"])/g;
    const visited = new Set();
    const queue = [...fileMap.entries()]
      .filter(([, info]) => info.folder === 'css')
      .map(([abs]) => abs);

    while (queue.length) {
      const absPath = queue.shift();
      if (visited.has(absPath)) continue;
      visited.add(absPath);

      let cssContent;
      try { cssContent = fs.readFileSync(absPath, 'utf-8'); } catch { continue; }
      const cssDir = path.dirname(absPath);

      let m;
      IMPORT_RE.lastIndex = 0;
      while ((m = IMPORT_RE.exec(cssContent)) !== null) {
        const ref = (m[1] || m[2] || '').trim();
        if (!ref || isExternal(ref)) continue;
        const absRef = resolveRef(cssDir, rawDir, ref);
        if (!absRef || !fs.existsSync(absRef)) {
          warnings.push(`CSS @import not found: ${ref}`);
          continue;
        }
        registerFile(absRef, 'css');
        if (!visited.has(absRef)) queue.push(absRef);
      }
    }
  }

  // --- Process CSS files for inner url() and @import paths ---
  for (const [absPath, info] of fileMap.entries()) {
    if (info.folder !== 'css') continue;
    let cssContent;
    try { cssContent = fs.readFileSync(absPath, 'utf-8'); } catch { continue; }
    const cssDir = path.dirname(absPath);

    // Update url() references (images, fonts)
    cssContent = cssContent.replace(/url\(\s*['"]?([^'"\)\n]+?)['"]?\s*\)/g, (match, ref) => {
      ref = ref.trim();
      if (isExternal(ref) || ref.startsWith('#')) return match;
      const absRef = resolveRef(cssDir, rawDir, ref);
      if (!absRef || !fs.existsSync(absRef)) return match;

      const ext = path.extname(absRef).toLowerCase();
      const folder = FONT_EXTS.has(ext) ? 'fonts' : IMG_EXTS.has(ext) ? 'img' : null;
      if (!folder) return match;

      const newRel = registerFile(absRef, folder);
      if (!newRel) return match;
      // CSS lives at css/file.css, so go up one level to reach fonts/ or img/
      return `url('../${newRel}')`;
    });

    // Update @import paths — all CSS files end up in css/ so imports become filename-only
    cssContent = cssContent.replace(
      /@import\s+(?:url\(\s*['"]?([^'"\)\n]+?)['"]?\s*\)|['"]([^'"]+)['"])/g,
      (match, urlRef, strRef) => {
        const ref = (urlRef || strRef || '').trim();
        if (!ref || isExternal(ref)) return match;
        const absRef = resolveRef(cssDir, rawDir, ref);
        if (!absRef || !fileMap.has(absRef)) return match;
        const importedName = fileMap.get(absRef).newName;
        return urlRef !== undefined
          ? `@import url('${importedName}')`
          : `@import '${importedName}'`;
      }
    );

    info.updatedContent = cssContent;
  }

  // --- Write all registered files to destDir ---
  const newFilePaths = new Set();
  let moved = 0;

  for (const [absPath, { newRel, updatedContent }] of fileMap.entries()) {
    const dest = path.join(destDir, newRel);
    newFilePaths.add(dest);
    if (!fs.existsSync(absPath) && updatedContent === undefined) continue;
    try {
      if (updatedContent !== undefined) {
        fs.writeFileSync(dest, updatedContent, 'utf-8');
      } else if (absPath !== dest) {
        fs.copyFileSync(absPath, dest);
      }
      moved++;
    } catch (e) {
      warnings.push(`Failed to copy ${absPath}: ${e.message}`);
    }
  }

  // --- Write normalized index.html ---
  const newIndexPath = path.join(destDir, 'index.html');
  newFilePaths.add(newIndexPath);
  fs.writeFileSync(newIndexPath, $.html(), 'utf-8');

  // Note: rawDir will be cleaned up by the caller
  return { newIndexPath, moved, removed: 0, warnings };
}

module.exports = { normalize };
