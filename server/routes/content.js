const express = require('express');
const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const multer = require('multer');
const { logActivity } = require('../services/activityLogger');
const WIDGETS_DIR = path.join(__dirname, '../../widgets');

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
  style.textContent='[data-ept-idx]{cursor:pointer;transition:outline 0.1s}[data-ept-idx]:hover{outline:1px dashed rgba(99,102,241,0.5)}[data-ept-selected]{outline:2px solid #6366f1 !important;background:rgba(99,102,241,0.08) !important}[data-ept-img]{cursor:pointer;transition:outline 0.1s}[data-ept-img]:hover{outline:2px dashed rgba(234,88,12,0.7)}[data-ept-img-selected]{outline:3px solid #ea580c !important}[data-ept-video]{cursor:pointer}[data-ept-video]:hover{outline:2px dashed #16a34a}[data-ept-video-selected]{outline:3px solid #16a34a !important}';
  document.head.appendChild(style);

  function clearAll(){
    document.querySelectorAll('[data-ept-selected],[data-ept-img-selected],[data-ept-video-selected]').forEach(function(x){
      x.removeAttribute('data-ept-selected');x.removeAttribute('data-ept-img-selected');x.removeAttribute('data-ept-video-selected');
    });
  }

  // Build a stable CSS path from root → el (used for selector-based delete / insert-after)
  function buildEptPath(el){
    var parts=[];
    var cur=el;
    while(cur&&cur.tagName&&cur!==document.documentElement){
      var tag=cur.tagName.toLowerCase();
      var parent=cur.parentNode;
      if(parent&&parent.children){
        var idx=Array.from(parent.children).indexOf(cur)+1;
        parts.unshift(tag+':nth-child('+idx+')');
      } else { parts.unshift(tag); }
      cur=parent;
    }
    return parts.join('>');
  }

  // Build short label for an element: tag + first 2 classes
  function eptLabel(el){
    var cls=(el.className||'').trim().split(/\s+/).filter(Boolean).slice(0,2).join('.');
    return el.tagName.toLowerCase()+(cls?'.'+cls:'');
  }

  function resolveImg(e,el){
    // Direct click on img
    if(e.target.tagName==='IMG') return e.target;
    // pointer-events:none on img -> e.target is parent (e.g. <a>)
    // check if the element contains only an img with no meaningful text
    var imgs=el.querySelectorAll('img');
    if(imgs.length===1&&!el.innerText.trim()) return imgs[0];
    return null;
  }

  function resolveVideo(e,el){
    if(e.target.tagName==='VIDEO') return e.target;
    var vids=el.querySelectorAll('video');
    if(vids.length===1) return vids[0];
    return null;
  }

  // Text elements
  els.forEach(function(el,idx){
    el.dataset.eptIdx=idx;
    el.addEventListener('click',function(e){
      if(pickActive)return; // pick-delete mode takes over
      e.preventDefault();e.stopPropagation();
      var vidEl=resolveVideo(e,el);
      if(vidEl){
        vidEl.pause();
        clearAll();
        vidEl.setAttribute('data-ept-video-selected','1');
        var vsrc=vidEl.getAttribute('src')||'';
        var vSourceEl=vidEl.querySelector('source');
        if(!vsrc&&vSourceEl)vsrc=vSourceEl.getAttribute('src')||'';
        var vname=vsrc.split('/').pop().split('?')[0];
        window.parent.postMessage({type:'ept-video-select',src:vsrc,name:vname,poster:vidEl.getAttribute('poster')||'',selectorPath:buildEptPath(vidEl)},'*');
        return;
      }
      var imgEl=resolveImg(e,el);
      if(imgEl){
        clearAll();
        imgEl.setAttribute('data-ept-img-selected','1');
        var src=imgEl.getAttribute('src')||'';
        var name=src.split('/').pop().split('?')[0];
        window.parent.postMessage({type:'ept-img-select',src:src,name:name,width:imgEl.naturalWidth,height:imgEl.naturalHeight,selectorPath:buildEptPath(imgEl)},'*');
        return;
      }
      clearAll();
      el.setAttribute('data-ept-selected','1');
      window.parent.postMessage({type:'ept-select',idx:idx,tag:el.tagName.toLowerCase(),html:el.innerHTML,text:el.innerText.trim()},'*');
    },true);
  });

  // Image elements
  document.querySelectorAll('img').forEach(function(img){
    img.dataset.eptImg='1';
    img.addEventListener('click',function(e){
      if(pickActive)return;
      e.preventDefault();e.stopPropagation();
      clearAll();
      img.setAttribute('data-ept-img-selected','1');
      var src=img.getAttribute('src')||'';
      var name=src.split('/').pop().split('?')[0];
      window.parent.postMessage({type:'ept-img-select',src:src,name:name,width:img.naturalWidth,height:img.naturalHeight,selectorPath:buildEptPath(img)},'*');
    },true);
  });

  // Video elements - overlay approach (only reliable way to block Safari playback)
  document.querySelectorAll('video').forEach(function(vid){
    if(!vid.parentNode) return; // skip detached videos
    vid.dataset.eptVideo='1';
    function openVideoPanel(){
      vid.pause();
      clearAll();
      vid.setAttribute('data-ept-video-selected','1');
      var src=vid.getAttribute('src')||'';
      var sourceEl=vid.querySelector('source');
      if(!src&&sourceEl)src=sourceEl.getAttribute('src')||'';
      var name=src.split('/').pop().split('?')[0];
      window.parent.postMessage({type:'ept-video-select',src:src,name:name,poster:vid.getAttribute('poster')||'',selectorPath:buildEptPath(vid)},'*');
    }
    // Wrap video in a positioned container and place a transparent overlay div on top.
    // This prevents Safari (and all browsers) from receiving any pointer events on the video itself.
    var wrapper=document.createElement('div');
    var cs=window.getComputedStyle(vid);
    var pos=cs.position;
    if(pos==='absolute'||pos==='fixed'){
      // Transfer absolute/fixed positioning to wrapper so it doesn't re-flow into page content
      wrapper.style.cssText='position:'+pos+';top:'+cs.top+';right:'+cs.right+';bottom:'+cs.bottom+';left:'+cs.left+
        ';width:'+cs.width+';height:'+cs.height+
        (cs.zIndex&&cs.zIndex!=='auto'?';z-index:'+cs.zIndex:'')+';';
      vid.parentNode.insertBefore(wrapper,vid);
      wrapper.appendChild(vid);
      vid.style.cssText='position:static;width:100%;height:100%;display:block;';
    } else {
      wrapper.style.cssText='position:relative;line-height:0;display:'+(cs.display==='inline'?'inline-block':cs.display)+';width:'+cs.width+';';
      if(cs.maxWidth&&cs.maxWidth!=='none')wrapper.style.maxWidth=cs.maxWidth;
      vid.parentNode.insertBefore(wrapper,vid);
      wrapper.appendChild(vid);
      vid.style.display='block';
      vid.style.width='100%';
    }
    var overlay=document.createElement('div');
    overlay.style.cssText='position:absolute;inset:0;z-index:9999;cursor:pointer;';
    wrapper.appendChild(overlay);
    overlay.addEventListener('click',function(e){if(pickActive)return;e.preventDefault();e.stopPropagation();openVideoPanel();},true);
  });

  // Broadcast catalog of unique element signatures - only elements inside <main>
  try{(function(){
    var TAG_PRIORITY={h1:0,h2:1,h3:2,h4:3,h5:4,h6:5,p:6,li:7,button:8,label:9};
    var scope=document.querySelector('main')||document.body;
    var seen={};
    var catalog=[];
    els.forEach(function(el,i){
      if(!scope.contains(el)) return;
      var tag=el.tagName.toLowerCase();
      var cls=(el.className||'').trim();
      var isImgLink=tag==='a'&&el.querySelector('img')&&!el.innerText.trim();
      var key=tag+'|'+cls+'|'+(isImgLink?'img':'text');
      if(!seen[key]){
        seen[key]=true;
        var imgSrc=isImgLink?(el.querySelector('img').getAttribute('src')||''):'';
        var preview=isImgLink
          ?'[img] '+imgSrc.split('/').pop()
          :el.innerText.trim().slice(0,60);
        var priority=isImgLink?100:(TAG_PRIORITY[tag]!==undefined?TAG_PRIORITY[tag]:50);
        catalog.push({idx:i,tag:tag,className:cls,preview:preview,isImgLink:isImgLink,priority:priority,outerHTML:el.outerHTML});
      }
    });
    catalog.sort(function(a,b){return a.priority-b.priority;});
    // Collect ALL applied styles via document.styleSheets - covers:
    // <link rel="stylesheet">, <style> tags, dynamic JS-injected styles, @import chains
    var cssLinks=[];
    var inlineStyles=[];
    function collectSheet(sheet){
      try{
        var rules=Array.from(sheet.cssRules||sheet.rules||[]);
        // Recurse into @import sub-sheets first
        rules.forEach(function(rule){
          if(rule.type===3&&rule.styleSheet)collectSheet(rule.styleSheet); // CSSImportRule
        });
        if(sheet.href){
          if(cssLinks.indexOf(sheet.href)===-1)cssLinks.push(sheet.href);
        } else {
          // Inline <style> - grab non-@import rules as text
          var css=rules.filter(function(r){return r.type!==3;}).map(function(r){return r.cssText;}).join('\\n');
          if(css)inlineStyles.push(css);
        }
      } catch(e){
        // Cross-origin sheet - cssRules blocked, but href still available
        if(sheet.href&&cssLinks.indexOf(sheet.href)===-1)cssLinks.push(sheet.href);
      }
    }
    Array.from(document.styleSheets).forEach(collectSheet);
    window.parent.postMessage({type:'ept-catalog',items:catalog,cssLinks:cssLinks,inlineStyles:inlineStyles},'*');
  })()}catch(catalogErr){console.warn('ept catalog error',catalogErr);}

  // ─── Pick-to-delete mode ──────────────────────────────────────────────────────
  var pickActive=false;
  var pickStyleEl=document.createElement('style');
  pickStyleEl.textContent='[data-ept-ph]{outline:2px dashed #ef4444!important;outline-offset:2px!important;background:rgba(239,68,68,0.07)!important;cursor:crosshair!important}'+
    '[data-ept-hidden]{display:block!important;visibility:visible!important;opacity:0.4!important;'+
    'outline:2px dashed #f97316!important;outline-offset:2px!important;min-height:24px!important;pointer-events:all!important}';

  // Walk up from el to first semantic or class-bearing element (best "block" for single-click)
  function findMeaningfulBlock(el){
    var SEMANTIC=/^(aside|section|article|nav|header|footer|figure|main|form|fieldset|dialog)$/i;
    var t=el;var withClass=null;
    while(t&&t.tagName&&t!==document.body&&t!==document.documentElement){
      if(SEMANTIC.test(t.tagName))return t;
      if(!withClass&&(typeof t.className==='string'&&t.className.trim()||t.id))withClass=t;
      t=t.parentNode;
    }
    return withClass||el;
  }

  function sendPickMessage(t){
    document.querySelectorAll('[data-ept-ph]').forEach(function(x){x.removeAttribute('data-ept-ph');});
    t.setAttribute('data-ept-ph','1');
    var ancestors=[];
    var ac=t.parentNode;
    while(ac&&ac.tagName&&ac!==document.body&&ac!==document.documentElement){
      ancestors.push({selector:buildEptPath(ac),label:eptLabel(ac),preview:ac.outerHTML.slice(0,300)});
      ac=ac.parentNode;
    }
    window.parent.postMessage({
      type:'ept-pick-delete',
      selector:buildEptPath(t),label:eptLabel(t),
      preview:t.outerHTML.slice(0,300),
      ancestors:ancestors
    },'*');
  }

  function pickOver(e){
    if(!pickActive)return;
    var t=e.target;
    if(!t||!t.tagName||t===document.body||t===document.documentElement)return;
    document.querySelectorAll('[data-ept-ph]').forEach(function(x){x.removeAttribute('data-ept-ph');});
    t.setAttribute('data-ept-ph','1');
  }
  function pickOut(e){if(e.target)e.target.removeAttribute('data-ept-ph');}

  // Single click → auto-navigate to nearest meaningful block (aside, section, .class, #id)
  function pickClick(e){
    if(!pickActive)return;
    e.preventDefault();e.stopPropagation();
    var t=e.target;
    if(!t||!t.tagName||t===document.body||t===document.documentElement)return;
    sendPickMessage(findMeaningfulBlock(t));
  }
  // Double click → select the exact element clicked (drill to innermost)
  function pickDblClick(e){
    if(!pickActive)return;
    e.preventDefault();e.stopPropagation();
    var t=e.target;
    if(!t||!t.tagName||t===document.body||t===document.documentElement)return;
    sendPickMessage(t);
  }

  function setPickMode(on){
    pickActive=on;
    if(on){
      // Temporarily reveal hidden elements so they can be picked
      document.querySelectorAll('*').forEach(function(el){
        if(el.tagName==='SCRIPT'||el.tagName==='STYLE'||el.tagName==='HEAD')return;
        try{
          var cs=window.getComputedStyle(el);
          if(cs.display==='none'){
            var par=el.parentNode;
            if(par&&par.nodeType===1&&window.getComputedStyle(par).display!=='none'){
              el.setAttribute('data-ept-hidden','1');
            }
          }
        }catch(err){}
      });
      document.head.appendChild(pickStyleEl);
      document.addEventListener('mouseover',pickOver,true);
      document.addEventListener('mouseout',pickOut,true);
      document.addEventListener('click',pickClick,true);
      document.addEventListener('dblclick',pickDblClick,true);
    } else {
      document.querySelectorAll('[data-ept-hidden]').forEach(function(el){el.removeAttribute('data-ept-hidden');});
      pickStyleEl.remove();
      document.querySelectorAll('[data-ept-ph]').forEach(function(x){x.removeAttribute('data-ept-ph');});
      document.removeEventListener('mouseover',pickOver,true);
      document.removeEventListener('mouseout',pickOut,true);
      document.removeEventListener('click',pickClick,true);
      document.removeEventListener('dblclick',pickDblClick,true);
    }
  }

  window.addEventListener('message',function(e){
    if(!e.data)return;
    if(e.data.type==='ept-update'){
      var el=els[e.data.idx];
      if(el)el.innerHTML=e.data.html;
    }
    if(e.data.type==='ept-deselect'){clearAll();}
    if(e.data.type==='ept-highlight'){
      clearAll();
      var el=els[e.data.idx];
      if(el){el.setAttribute('data-ept-selected','1');el.scrollIntoView({behavior:'smooth',block:'center'});}
    }
    if(e.data.type==='ept-img-update'){
      document.querySelectorAll('img').forEach(function(img){
        var src=img.getAttribute('src')||'';
        var name=src.split('/').pop().split('?')[0];
        if(name===e.data.name){var base=src.split('?')[0];img.src=base+'?t='+Date.now();}
      });
    }
    if(e.data.type==='ept-video-update'){
      document.querySelectorAll('video').forEach(function(vid){
        var src=vid.getAttribute('src')||'';
        var name=src.split('/').pop().split('?')[0];
        if(name===e.data.name){var base=src.split('?')[0];vid.src=base+'?t='+Date.now();vid.load();}
      });
    }
    if(e.data.type==='ept-pick-mode'){setPickMode(!!e.data.active);}
    if(e.data.type==='ept-pick-highlight'){
      try{
        document.querySelectorAll('[data-ept-ph]').forEach(function(x){x.removeAttribute('data-ept-ph');});
        var hl=document.querySelector(e.data.selector);
        if(hl){hl.setAttribute('data-ept-ph','1');hl.scrollIntoView({behavior:'smooth',block:'center'});}
      }catch(err){}
    }
  });
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

  // Inject editor script before the LAST </body> — using lastIndexOf avoids
  // accidentally matching </body> inside a <script> string/comment earlier in the page.
  const script = buildEditorScript(sid);
  const bodyIdx = html.toLowerCase().lastIndexOf('</body>');
  if (bodyIdx !== -1) {
    html = html.slice(0, bodyIdx) + script + '\n' + html.slice(bodyIdx);
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

  el.html(text);
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

// ─── POST /:id/format-snippet ─────────────────────────────────────────────────
router.post('/:sessionId/format-snippet', async (req, res) => {
  const { html } = req.body;
  if (html === undefined) return res.status(400).json({ error: 'html required' });

  const { formatHtml } = require('../services/htmlFormatter');
  const result = await formatHtml(`<div>${html}</div>`);
  if (!result.success) return res.json({ ok: false, html });

  // Strip the wrapping <div>…</div> added for Prettier context
  const inner = result.html.trim()
    .replace(/^<div>\n?/, '')
    .replace(/\n?<\/div>\s*$/, '')
    .trim();

  res.json({ ok: true, html: inner });
});

// ─── POST /:id/replace-video ──────────────────────────────────────────────────
router.post('/:sessionId/replace-video', upload.fields([{ name: 'file', maxCount: 1 }, { name: 'poster', maxCount: 1 }]), (req, res) => {
  const { name, src } = req.body;
  if (!name || !req.files?.file?.[0]) return res.status(400).json({ error: 'name and file required' });

  const sid = req.params.sessionId;
  const sessionDir = getSessionDir(sid);

  // Try to resolve path from src attr, fallback to recursive search
  let destPath = null;
  if (src) {
    const rel = src.split('?')[0].split('#')[0].replace(/^\//, '').split('/').filter(s => s && s !== '..' && s !== '.').join(path.sep);
    const candidate = path.join(sessionDir, rel);
    if (candidate.startsWith(sessionDir + path.sep) && fs.existsSync(candidate)) destPath = candidate;
  }
  if (!destPath) destPath = findFileByName(sessionDir, name);
  if (!destPath) return res.status(404).json({ error: 'Video file not found in session' });
  if (!destPath.startsWith(sessionDir + path.sep)) return res.status(403).json({ error: 'Forbidden' });

  fs.writeFileSync(destPath, req.files.file[0].buffer);

  let posterRelPath = '';
  if (req.files?.poster?.[0]) {
    const posterName = path.basename(name, path.extname(name)) + '.webp';
    const imgDir = path.join(sessionDir, 'img');
    fs.mkdirSync(imgDir, { recursive: true });
    posterRelPath = `img/${posterName}`;
    fs.writeFileSync(path.join(sessionDir, posterRelPath), req.files.poster[0].buffer);
  }

  // Update HTML: add controls + poster to the matching <video> tag
  const indexPath = getIndexPath(sid);
  if (indexPath) {
    const $ = cheerio.load(fs.readFileSync(indexPath, 'utf-8'), { decodeEntities: false });
    $('video').each((i, el) => {
      const $el = $(el);
      const vidSrc = $el.attr('src') || $el.find('source').first().attr('src') || '';
      if (vidSrc.split('/').pop().split('?')[0] === name) {
        $el.attr('controls', '');
        if (posterRelPath) $el.attr('poster', posterRelPath);
      }
    });
    fs.writeFileSync(indexPath, $.html(), 'utf-8');
  }

  logActivity(sid, 'replace-video', { name, hasPoster: !!posterRelPath });
  res.json({ ok: true, posterPath: posterRelPath });
});

// ─── Helper: find file by name recursively ────────────────────────────────────
function findFileByName(dir, filename) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findFileByName(full, filename);
        if (found) return found;
      } else if (entry.name === filename) {
        return full;
      }
    }
  } catch {}
  return null;
}

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

// ─── POST :id/insert-widget ───────────────────────────────────────────────────
router.post('/:sessionId/insert-widget', (req, res) => {
  const sid = req.params.sessionId;
  const { afterIdx, afterSelector, widgetId } = req.body;
  const indexPath = getIndexPath(sid);
  if (!indexPath) return res.status(404).json({ error: 'Not found' });

  const widgetDir = path.join(WIDGETS_DIR, widgetId);
  if (!fs.existsSync(widgetDir)) return res.status(404).json({ error: 'Widget not found' });

  const html = fs.readFileSync(indexPath, 'utf-8');
  const $ = cheerio.load(html, { decodeEntities: false });
  const els = $(EDITABLE_SEL).toArray();

  const sessionDir = path.join(__dirname, '../sessions', sid);
  const files = fs.readdirSync(widgetDir);
  const htmlFile = files.find(f => f.endsWith('.html'));
  const jsFile   = files.find(f => f.endsWith('.js'));
  const cssFile  = files.find(f => f.endsWith('.css'));

  // Copy JS/CSS assets into session
  const assetsDest = path.join(sessionDir, `widgets/${widgetId}`);
  fs.mkdirSync(assetsDest, { recursive: true });
  if (jsFile)  fs.copyFileSync(path.join(widgetDir, jsFile),  path.join(assetsDest, jsFile));
  if (cssFile) fs.copyFileSync(path.join(widgetDir, cssFile), path.join(assetsDest, cssFile));

  const relPath = `widgets/${widgetId}`;

  // Inject CSS link into <head> (avoid duplicates)
  if (cssFile && !$(`link[href="${relPath}/${cssFile}"]`).length) {
    $('head').append(`\n  <link rel="stylesheet" href="${relPath}/${cssFile}">`);
  }

  // Build HTML snippet + optional script tag
  let widgetHtml = htmlFile ? fs.readFileSync(path.join(widgetDir, htmlFile), 'utf-8').trim() : '';
  let snippet = widgetHtml;
  if (jsFile) snippet += `\n<script src="${relPath}/${jsFile}"></script>`;

  // Insert after target element; fall back to appending to <body>
  let insertTarget = null;
  if (afterSelector) {
    try { insertTarget = $(afterSelector).first(); } catch {}
    if (!insertTarget?.length) insertTarget = null;
  }
  if (!insertTarget && afterIdx >= 0 && afterIdx < els.length) insertTarget = $(els[afterIdx]);
  if (insertTarget?.length) {
    insertTarget.after('\n' + snippet + '\n');
  } else {
    $('body').append('\n' + snippet + '\n');
  }

  fs.writeFileSync(indexPath, $.html());
  logActivity(sid, 'insert-widget', { afterIdx, afterSelector, widgetId });
  res.json({ ok: true });
});

// ─── POST :id/insert-after ────────────────────────────────────────────────────
router.post('/:sessionId/insert-after', (req, res) => {
  const sid = req.params.sessionId;
  const { afterIdx, afterSelector, templateIdx } = req.body;
  const indexPath = getIndexPath(sid);
  if (!indexPath) return res.status(404).json({ error: 'Not found' });

  const html = fs.readFileSync(indexPath, 'utf-8');
  const $ = cheerio.load(html, { decodeEntities: false });
  const els = $(EDITABLE_SEL).toArray();
  if (templateIdx < 0 || templateIdx >= els.length) return res.status(400).json({ error: 'Invalid templateIdx' });

  // Resolve the anchor element — by selector (for images/videos) or by editable index
  let afterEl;
  if (afterSelector) {
    try { afterEl = $(afterSelector).first(); } catch {}
    if (!afterEl?.length) return res.status(404).json({ error: 'Anchor element not found' });
  } else {
    if (afterIdx < 0 || afterIdx >= els.length) return res.status(400).json({ error: 'Invalid afterIdx' });
    afterEl = $(els[afterIdx]);
  }
  const templateEl = $(els[templateIdx]);
  const tag = templateEl.get(0).tagName.toLowerCase();

  const newEl = cheerio.load(`<${tag}></${tag}>`, { decodeEntities: false })('body').children().first();
  // Copy class and style from template
  const cls = templateEl.attr('class');
  const style = templateEl.attr('style');
  if (cls) newEl.attr('class', cls);
  if (style) newEl.attr('style', style);

  // For <a><img> links — preserve full inner markup so image picker can work on the clone
  // For everything else — placeholder text
  const isImgLink = templateEl.find('img').length > 0 && !templateEl.text().trim();
  if (isImgLink) {
    newEl.html(templateEl.html()); // keeps <img src=... class=... style=...> intact
  } else {
    newEl.html('Новий текст');
  }

  // Mark to find new index
  newEl.attr('data-ept-insert-tmp', '1');
  afterEl.after(newEl);

  const newEls = $(EDITABLE_SEL).toArray();
  const newIdx = newEls.findIndex(e => $(e).attr('data-ept-insert-tmp') === '1');
  if (newIdx !== -1) $(newEls[newIdx]).removeAttr('data-ept-insert-tmp');

  fs.writeFileSync(indexPath, $.html());
  logActivity(sid, 'insert-after', { afterIdx, templateIdx, newIdx });
  res.json({ ok: true, newIdx, tag, isImgLink });
});

// ─── POST /:id/delete-by-selector ────────────────────────────────────────────
router.post('/:sessionId/delete-by-selector', (req, res) => {
  const { selector } = req.body;
  if (!selector || typeof selector !== 'string') return res.status(400).json({ error: 'selector required' });

  const sid = req.params.sessionId;
  const indexPath = getIndexPath(sid);
  if (!indexPath) return res.status(404).json({ error: 'Not found' });

  const current = fs.readFileSync(indexPath, 'utf-8');
  const $ = cheerio.load(current, { decodeEntities: false });
  try {
    const el = $(selector).first();
    if (!el.length) return res.status(404).json({ error: 'Element not found' });
    el.remove();
  } catch (e) {
    return res.status(400).json({ error: 'Invalid selector' });
  }

  fs.writeFileSync(indexPath + '.undo', current, 'utf-8');
  fs.writeFileSync(indexPath, $.html(), 'utf-8');
  logActivity(sid, 'delete-by-selector', { selector: selector.slice(0, 120) });
  res.json({ ok: true });
});

// ─── POST :id/delete-element ──────────────────────────────────────────────────
router.post('/:sessionId/delete-element', (req, res) => {
  const sid = req.params.sessionId;
  const { idx } = req.body;
  const indexPath = getIndexPath(sid);
  if (!indexPath) return res.status(404).json({ error: 'Not found' });

  const html = fs.readFileSync(indexPath, 'utf-8');
  const $ = cheerio.load(html, { decodeEntities: false });
  const els = $(EDITABLE_SEL).toArray();
  if (idx < 0 || idx >= els.length) return res.status(400).json({ error: 'Invalid index' });

  $(els[idx]).remove();
  fs.writeFileSync(indexPath + '.undo', html, 'utf-8');
  fs.writeFileSync(indexPath, $.html());
  logActivity(sid, 'delete-element', { idx });
  res.json({ ok: true });
});

// ─── POST /:id/undo ───────────────────────────────────────────────────────────
router.post('/:sessionId/undo', (req, res) => {
  const sid = req.params.sessionId;
  const indexPath = getIndexPath(sid);
  if (!indexPath) return res.status(404).json({ error: 'Not found' });
  const undoPath = indexPath + '.undo';
  if (!fs.existsSync(undoPath)) return res.status(404).json({ error: 'Nothing to undo' });
  fs.copyFileSync(undoPath, indexPath);
  fs.unlinkSync(undoPath);
  logActivity(sid, 'undo-delete', {});
  res.json({ ok: true });
});

module.exports = router;
