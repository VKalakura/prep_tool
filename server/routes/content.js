const express = require('express');
const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const multer = require('multer');
const { logActivity } = require('../services/activityLogger');

const router = express.Router();
const SESSIONS_DIR = path.join(__dirname, '../sessions');

// Selector used BOTH in browser (injected script) and server (cheerio) — must match exactly
const EDITABLE_SEL = 'h1,h2,h3,h4,h5,h6,p,button,a,label,li';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function getSessionDir(sid) { return path.join(SESSIONS_DIR, sid); }

function getIndexPath(sid) {
  const dir = getSessionDir(sid);
  for (const name of ['index.html', 'index.php']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ─── Editor script injected into preview iframe ───────────────────────────────
function buildEditorScript(sid) {
  return `<script>
(function(){
  var SEL='${EDITABLE_SEL}';
  var els=Array.from(document.querySelectorAll(SEL));
  var style=document.createElement('style');
  style.textContent='[data-ept-idx]{cursor:pointer;transition:outline 0.1s}[data-ept-idx]:hover{outline:1px dashed rgba(99,102,241,0.5)}[data-ept-selected]{outline:2px solid #6366f1 !important;background:rgba(99,102,241,0.08) !important}[data-ept-img]{cursor:pointer;transition:outline 0.1s}[data-ept-img]:hover{outline:2px dashed rgba(234,88,12,0.7)}[data-ept-img-selected]{outline:3px solid #ea580c !important}';
  document.head.appendChild(style);

  // Text elements
  els.forEach(function(el,idx){
    el.dataset.eptIdx=idx;
    el.addEventListener('click',function(e){
      e.preventDefault();e.stopPropagation();
      document.querySelectorAll('[data-ept-selected],[data-ept-img-selected]').forEach(function(x){x.removeAttribute('data-ept-selected');x.removeAttribute('data-ept-img-selected');});
      el.setAttribute('data-ept-selected','1');
      window.parent.postMessage({type:'ept-select',idx:idx,tag:el.tagName.toLowerCase(),text:el.innerText.trim()},'*');
    },true);
  });

  // Image elements
  document.querySelectorAll('img').forEach(function(img){
    img.dataset.eptImg='1';
    img.addEventListener('click',function(e){
      e.preventDefault();e.stopPropagation();
      document.querySelectorAll('[data-ept-selected],[data-ept-img-selected]').forEach(function(x){x.removeAttribute('data-ept-selected');x.removeAttribute('data-ept-img-selected');});
      img.setAttribute('data-ept-img-selected','1');
      // Extract filename from src
      var src=img.getAttribute('src')||'';
      var name=src.split('/').pop().split('?')[0];
      window.parent.postMessage({type:'ept-img-select',src:src,name:name,width:img.naturalWidth,height:img.naturalHeight},'*');
    },true);
  });

  window.addEventListener('message',function(e){
    if(!e.data)return;
    if(e.data.type==='ept-update'){
      var el=els[e.data.idx];
      if(el)el.innerText=e.data.text;
    }
    if(e.data.type==='ept-deselect'){
      document.querySelectorAll('[data-ept-selected],[data-ept-img-selected]').forEach(function(x){x.removeAttribute('data-ept-selected');x.removeAttribute('data-ept-img-selected');});
    }
    if(e.data.type==='ept-highlight'){
      document.querySelectorAll('[data-ept-selected]').forEach(function(x){x.removeAttribute('data-ept-selected');});
      var el=els[e.data.idx];
      if(el){el.setAttribute('data-ept-selected','1');el.scrollIntoView({behavior:'smooth',block:'center'});}
    }
    if(e.data.type==='ept-img-update'){
      // Refresh image by busting cache
      document.querySelectorAll('img').forEach(function(img){
        var src=img.getAttribute('src')||'';
        var name=src.split('/').pop().split('?')[0];
        if(name===e.data.name){
          var base=src.split('?')[0];
          img.src=base+'?t='+Date.now();
        }
      });
    }
  });
  // Prevent form submissions in preview
  document.querySelectorAll('form').forEach(function(f){f.addEventListener('submit',function(e){e.preventDefault();});});
})();
</script>`;
}

// ─── GET /:id/preview-iframe ──────────────────────────────────────────────────
router.get('/:sessionId/preview-iframe', (req, res) => {
  const sid = req.params.sessionId;
  const indexPath = getIndexPath(sid);
  if (!indexPath) return res.status(404).send('Not found');

  let html = fs.readFileSync(indexPath, 'utf-8');

  // Inject <base> so relative assets load from the session static dir
  const baseTag = `<base href="/session-files/${sid}/" />`;
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/(<head[^>]*>)/i, `$1\n  ${baseTag}`);
  } else {
    html = `<head>${baseTag}</head>` + html;
  }

  // Inject editor script before </body>
  const script = buildEditorScript(sid);
  if (/<\/body>/i.test(html)) {
    html = html.replace(/<\/body>/i, `${script}\n</body>`);
  } else {
    html += script;
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ─── GET /:id/editable-elements ───────────────────────────────────────────────
router.get('/:sessionId/editable-elements', (req, res) => {
  const indexPath = getIndexPath(req.params.sessionId);
  if (!indexPath) return res.status(404).json({ error: 'not found' });

  const $ = cheerio.load(fs.readFileSync(indexPath, 'utf-8'), { decodeEntities: false });
  const elements = [];
  $(EDITABLE_SEL).each((i, el) => {
    const text = $(el).text().trim();
    if (text) elements.push({ idx: i, tag: el.tagName.toLowerCase(), text });
  });

  res.json({ elements, total: $(EDITABLE_SEL).length });
});

// ─── POST /:id/save-text ──────────────────────────────────────────────────────
router.post('/:sessionId/save-text', (req, res) => {
  const { idx, text } = req.body;
  if (idx === undefined || text === undefined) {
    return res.status(400).json({ error: 'idx and text required' });
  }

  const sid = req.params.sessionId;
  const indexPath = getIndexPath(sid);
  if (!indexPath) return res.status(404).json({ error: 'not found' });

  const $ = cheerio.load(fs.readFileSync(indexPath, 'utf-8'), { decodeEntities: false });
  const el = $(EDITABLE_SEL).eq(Number(idx));
  if (!el.length) return res.status(404).json({ error: 'Element not found' });

  setTextPreserveMarkup($, el, text);
  fs.writeFileSync(indexPath, $.html(), 'utf-8');
  logActivity(sid, 'save-text', { idx, textPreview: text.slice(0, 60) });
  res.json({ ok: true });
});

// ─── POST /:id/bulk-replace ───────────────────────────────────────────────────
router.post('/:sessionId/bulk-replace', (req, res) => {
  const { replacements } = req.body;
  if (!Array.isArray(replacements)) {
    return res.status(400).json({ error: 'replacements must be an array' });
  }

  const sid = req.params.sessionId;
  const indexPath = getIndexPath(sid);
  if (!indexPath) return res.status(404).json({ error: 'not found' });

  const $ = cheerio.load(fs.readFileSync(indexPath, 'utf-8'), { decodeEntities: false });
  let applied = 0;

  for (const { idx, text } of replacements) {
    if (typeof text !== 'string') continue;
    const el = $(EDITABLE_SEL).eq(Number(idx));
    if (el.length) { setTextPreserveMarkup($, el, text); applied++; }
  }

  fs.writeFileSync(indexPath, $.html(), 'utf-8');
  logActivity(sid, 'bulk-replace', { applied });
  res.json({ ok: true, applied });
});

// ─── GET /:id/images ──────────────────────────────────────────────────────────
router.get('/:sessionId/images', (req, res) => {
  const sid = req.params.sessionId;
  const imgDir = path.join(getSessionDir(sid), 'img');
  if (!fs.existsSync(imgDir)) return res.json({ images: [] });

  const IMG_EXTS = /\.(png|jpg|jpeg|gif|webp|svg|avif|bmp|ico)$/i;
  const images = fs.readdirSync(imgDir)
    .filter(f => IMG_EXTS.test(f) && fs.statSync(path.join(imgDir, f)).isFile())
    .map(f => {
      const stat = fs.statSync(path.join(imgDir, f));
      return {
        name: f,
        path: `img/${f}`,
        size: stat.size,
        url: `/session-files/${sid}/img/${encodeURIComponent(f)}`,
      };
    });

  res.json({ images });
});

// ─── POST /:id/replace-image ──────────────────────────────────────────────────
router.post('/:sessionId/replace-image', upload.single('file'), (req, res) => {
  const { name } = req.body;
  if (!name || !req.file) return res.status(400).json({ error: 'name and file required' });

  const sid = req.params.sessionId;
  const safe = path.basename(name);
  const dest = path.join(getSessionDir(sid), 'img', safe);

  if (!dest.startsWith(path.join(getSessionDir(sid), 'img'))) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  fs.writeFileSync(dest, req.file.buffer);
  logActivity(sid, 'replace-image', { name: safe, size: req.file.size });
  res.json({ ok: true, size: req.file.size });
});

// ─── POST /:id/compress-image ─────────────────────────────────────────────────
router.post('/:sessionId/compress-image', async (req, res) => {
  const { name, quality = 80, format } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  let sharp;
  try { sharp = require('sharp'); } catch {
    return res.status(501).json({ error: 'Image processing unavailable (sharp not installed). Run: npm install sharp' });
  }

  const sid = req.params.sessionId;
  const sessionDir = getSessionDir(sid);
  const safe = path.basename(name);
  const srcPath = path.join(sessionDir, 'img', safe);

  if (!fs.existsSync(srcPath)) return res.status(404).json({ error: 'Image not found' });

  const originalSize = fs.statSync(srcPath).size;
  const ext = path.extname(safe).slice(1).toLowerCase();
  const targetFormat = (format || ext).replace('jpg', 'jpeg');

  try {
    let s = sharp(srcPath);
    if (targetFormat === 'webp') s = s.webp({ quality: Number(quality) });
    else if (targetFormat === 'jpeg') s = s.jpeg({ quality: Number(quality) });
    else if (targetFormat === 'png') s = s.png({ quality: Number(quality) });
    else s = s.webp({ quality: Number(quality) });

    const buffer = await s.toBuffer();
    const newExt = targetFormat === 'jpeg' ? 'jpg' : targetFormat;
    const newName = `${path.basename(safe, path.extname(safe))}.${newExt}`;
    const newPath = path.join(sessionDir, 'img', newName);

    fs.writeFileSync(newPath, buffer);
    if (newName !== safe) {
      updateFileRefs(sessionDir, `img/${safe}`, `img/${newName}`);
      fs.unlinkSync(srcPath);
    }

    const saved = originalSize - buffer.length;
    logActivity(sid, 'compress-image', { name: safe, newName, savedBytes: saved });
    res.json({
      ok: true, originalName: safe, newName,
      originalSize, newSize: buffer.length,
      savedBytes: saved, savedPercent: Math.round((saved / originalSize) * 100),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /:id/compress-all ───────────────────────────────────────────────────
router.post('/:sessionId/compress-all', async (req, res) => {
  const { quality = 80, format } = req.body;

  let sharp;
  try { sharp = require('sharp'); } catch {
    return res.status(501).json({ error: 'Image processing unavailable (sharp not installed)' });
  }

  const sid = req.params.sessionId;
  const sessionDir = getSessionDir(sid);
  const imgDir = path.join(sessionDir, 'img');
  if (!fs.existsSync(imgDir)) return res.json({ ok: true, results: [] });

  const RASTER = /\.(png|jpg|jpeg|webp|avif)$/i;
  const files = fs.readdirSync(imgDir).filter(f => RASTER.test(f) && fs.statSync(path.join(imgDir, f)).isFile());
  const results = [];
  let totalSaved = 0;

  for (const file of files) {
    const srcPath = path.join(imgDir, file);
    const originalSize = fs.statSync(srcPath).size;
    const ext = path.extname(file).slice(1).toLowerCase();
    const targetFormat = (format || ext).replace('jpg', 'jpeg');
    const newExt = targetFormat === 'jpeg' ? 'jpg' : targetFormat;
    const newName = `${path.basename(file, path.extname(file))}.${newExt}`;

    try {
      let s = sharp(srcPath);
      if (targetFormat === 'webp') s = s.webp({ quality: Number(quality) });
      else if (targetFormat === 'jpeg') s = s.jpeg({ quality: Number(quality) });
      else if (targetFormat === 'png') s = s.png({ quality: Number(quality) });
      else s = s.webp({ quality: Number(quality) });

      const buffer = await s.toBuffer();
      fs.writeFileSync(path.join(imgDir, newName), buffer);
      if (newName !== file) {
        updateFileRefs(sessionDir, `img/${file}`, `img/${newName}`);
        fs.unlinkSync(srcPath);
      }
      const saved = originalSize - buffer.length;
      totalSaved += saved;
      results.push({ name: file, newName, originalSize, newSize: buffer.length, savedBytes: saved });
    } catch (e) {
      results.push({ name: file, error: e.message });
    }
  }

  logActivity(sid, 'compress-all', { files: files.length, totalSaved });
  res.json({ ok: true, results, totalSaved });
});

// ─── Helper: update text while preserving inner HTML markup ──────────────────
// Handles common offer patterns like <h1><span class="x">text</span></h1>
// and <button><span>CTA</span></button> without destroying the child elements.
function setTextPreserveMarkup($, $el, newText) {
  // No child elements → simple text replacement
  if ($el.children().length === 0) {
    $el.text(newText);
    return;
  }
  // No direct text nodes (all text lives inside child tags):
  // Walk down single-child chains (span inside span inside h1, etc.) and
  // update the deepest single-child descendant.
  const hasDirectText = $el.contents().toArray()
    .some(n => n.type === 'text' && (n.data || '').trim());
  if (!hasDirectText) {
    let target = $el;
    while (target.children().length === 1) {
      target = target.children().first();
    }
    // target is either a leaf or a multi-child element
    if (target.children().length === 0) {
      target.text(newText);
    } else {
      // Multi-child with no direct text — update first child only
      target.children().first().text(newText);
    }
    return;
  }
  // Mixed content (direct text nodes + child elements) → replace entire text
  $el.text(newText);
}

// ─── Helper: update file references in HTML and CSS ──────────────────────────
function updateFileRefs(sessionDir, oldRef, newRef) {
  const oldBase = path.basename(oldRef);
  const newBase = path.basename(newRef);

  for (const name of ['index.html', 'index.php']) {
    const p = path.join(sessionDir, name);
    if (!fs.existsSync(p)) continue;
    let content = fs.readFileSync(p, 'utf-8');
    content = content.split(oldRef).join(newRef);
    content = content.split(`"${oldBase}"`).join(`"${newBase}"`);
    content = content.split(`'${oldBase}'`).join(`'${newBase}'`);
    fs.writeFileSync(p, content, 'utf-8');
  }

  const cssDir = path.join(sessionDir, 'css');
  if (fs.existsSync(cssDir)) {
    for (const f of fs.readdirSync(cssDir)) {
      if (!f.endsWith('.css')) continue;
      const p = path.join(cssDir, f);
      let content = fs.readFileSync(p, 'utf-8');
      content = content.split(`../${oldRef}`).join(`../${newRef}`);
      content = content.split(`"${oldBase}"`).join(`"${newBase}"`);
      content = content.split(`'${oldBase}'`).join(`'${newBase}'`);
      fs.writeFileSync(p, content, 'utf-8');
    }
  }
}

module.exports = router;
