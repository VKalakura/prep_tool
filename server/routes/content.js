const express = require('express');
const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const multer = require('multer');
const { logActivity } = require('../services/activityLogger');
const { getContentScopedEditables, getScopedImages, getScopedVideos, hasFormInScope, resolveScope, buildEptPathCheerio } = require('../services/xaiScope');
const { parsePhotoMarkers, parseVideoMarkers, parsePlaceholderMarkers } = require('../services/photoMarkers');
const {
  applySlotExtensionPlan,
  listScopedEditablesPostExtension,
  extendMediaInScope,
} = require('../services/xaiSlotExtender');
const { chatCompletion, DEFAULT_MODEL } = require('../services/xaiClient');
const { rewritePrompt } = require('../services/xaiPrompts');

// ─── Brief → blocks (deterministic paragraph splitter) ──────────────────────

const MEDIA_LINE_RE = /^\s*(фото|photo|відео|видео|video)\s*\d+\s*$/i;
const FORM_LINE_RE = /^\s*форм[аи]\s+(регистрации|реєстрації)(?=$|[\s.,!?:;()\-])/iu;

const PHOTO_LINE_RE = /^\s*(?:фото|photo)\s*(\d+)\s*$/i;
const VIDEO_LINE_RE = /^\s*(?:відео|видео|video)\s*(\d+)\s*$/i;

/**
 * Split the operator's pasted text into paragraph blocks for verbatim slot
 * mapping. Paragraphs are separated by ONE OR MORE blank lines. Marker-only
 * lines (ФОТО N / VIDEO N / ФОРМА РЕГИСТРАЦИИ) are extracted as POSITION
 * directives — we record which block each marker sits BEFORE, so the photo /
 * video can later be moved into the matching position in the DOM.
 *
 * Within a block, individual hard line breaks are PRESERVED — they're often
 * line-by-line dialogue ("Speaker A: …" / "Speaker B: …") that should land in
 * one slot, not be split.
 *
 * @returns {{
 *   blocks: string[],
 *   photoSlots: { num: number, beforeBlockIdx: number }[],
 *   videoSlots: { num: number, beforeBlockIdx: number }[]
 * }}
 *   beforeBlockIdx is the 0-based block index this marker should appear
 *   BEFORE in DOM order. Markers at the very end of the brief get
 *   beforeBlockIdx = blocks.length (i.e. "after the last block").
 */
function parseBrief(brief) {
  const text = String(brief || '').replace(/\r\n/g, '\n').trim();
  if (!text) return { blocks: [], photoSlots: [], videoSlots: [] };

  const blocks = [];
  const photoSlots = [];
  const videoSlots = [];

  for (const raw of text.split(/\n{2,}/)) {
    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    const cleanedLines = [];
    for (const line of lines) {
      const photoMatch = line.match(PHOTO_LINE_RE);
      if (photoMatch) {
        photoSlots.push({ num: Number(photoMatch[1]), beforeBlockIdx: blocks.length });
        continue;
      }
      const videoMatch = line.match(VIDEO_LINE_RE);
      if (videoMatch) {
        videoSlots.push({ num: Number(videoMatch[1]), beforeBlockIdx: blocks.length });
        continue;
      }
      if (FORM_LINE_RE.test(line)) continue;
      cleanedLines.push(line);
    }
    if (cleanedLines.length) blocks.push(cleanedLines.join('\n'));
  }

  return { blocks, photoSlots, videoSlots };
}

// Backwards-compat shim — kept for any external caller that still imports it.
function splitBriefIntoBlocks(brief) {
  return parseBrief(brief).blocks;
}
const WIDGETS_DIR = path.join(__dirname, '../../widgets');

const router = express.Router();
const SESSIONS_DIR = path.join(__dirname, '../sessions');

// Selector used BOTH in browser (injected script) and server (cheerio) — must match exactly
const EDITABLE_SEL = 'h1,h2,h3,h4,h5,h6,p,button,a,label,li';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB per file (raw photos / 4K screenshots fit)
});

/**
 * Wrap an upload middleware so multer errors (file too large, unexpected field,
 * truncated parts) reach the client as readable JSON instead of disappearing
 * into Express's default 500 handler. Without this, hitting LIMIT_FILE_SIZE
 * on one file produces a generic 500 and the operator just sees "got fewer
 * files than expected" downstream.
 */
function uploadOrJsonError(uploader) {
  return (req, res, next) => {
    uploader(req, res, (err) => {
      if (!err) return next();
      let detail = err.message || 'Upload failed';
      if (err.code === 'LIMIT_FILE_SIZE') {
        detail = `One of the files exceeds the 100 MB upload limit (${err.field || 'photo/video'} field).`;
      } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        detail = `Unexpected file field "${err.field}" — fix the form name.`;
      } else if (err.code === 'LIMIT_PART_COUNT' || err.code === 'LIMIT_FILE_COUNT') {
        detail = `Too many files in one request (${err.code}).`;
      }
      return res.status(400).json({ error: detail, code: err.code });
    });
  };
}

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

  // Resolve the "real" src of an img — handles lazy loaders that hide true URL in data-src/data-srcset
  var LAZY_ATTRS=['data-src','data-srcset','data-lazy','data-original','data-lazy-src','data-full'];
  function resolveImgSrc(img){
    var src=img.getAttribute('src')||'';
    if(src&&!src.startsWith('data:'))return src;
    for(var _i=0;_i<LAZY_ATTRS.length;_i++){
      var v=img.getAttribute(LAZY_ATTRS[_i])||'';
      if(v){return v.split(',')[0].trim().split(/\s+/)[0];}
    }
    return src;
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
        var src=resolveImgSrc(imgEl);
        var name=src.split('/').pop().split('?')[0];
        window.parent.postMessage({type:'ept-img-select',src:src,name:name,width:imgEl.naturalWidth,height:imgEl.naturalHeight,selectorPath:buildEptPath(imgEl)},'*');
        return;
      }
      clearAll();
      el.setAttribute('data-ept-selected','1');
      var cs=window.getComputedStyle(el);
      var eptSpacing={margin:{top:cs.marginTop,right:cs.marginRight,bottom:cs.marginBottom,left:cs.marginLeft},padding:{top:cs.paddingTop,right:cs.paddingRight,bottom:cs.paddingBottom,left:cs.paddingLeft}};
      window.parent.postMessage({type:'ept-select',idx:idx,tag:el.tagName.toLowerCase(),html:el.outerHTML,text:el.innerText.trim(),spacing:eptSpacing},'*');
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
      var src=resolveImgSrc(img);
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

  // Broadcast catalog of unique element signatures - article content only
  try{(function(){
    var TAG_PRIORITY={h1:0,h2:1,h3:2,h4:3,h5:4,h6:5,p:6,li:7,img:8,button:9,label:10,a:11};
    var scope=document.querySelector('main')||document.querySelector('article')||document.querySelector('[role="main"]')||document.body;
    function inChrome(el){
      var t=el.parentNode;
      while(t&&t!==document.body&&t!==document.documentElement){
        if(t.tagName){var tn=t.tagName.toLowerCase();if(tn==='header'||tn==='footer'||tn==='nav'||tn==='aside')return true;}
        t=t.parentNode;
      }
      return false;
    }
    // First class name (non-empty) as dedup key
    function firstCls(el){return(el.className||'').trim().split(/\s+/).filter(Boolean)[0]||'';}

    var seen={};
    var catalog=[];

    // ── Text / interactive elements ──────────────────────────────────────────
    els.forEach(function(el,i){
      if(!scope.contains(el))return;
      if(inChrome(el))return;
      var tag=el.tagName.toLowerCase();
      var cls=firstCls(el);
      var isImgLink=tag==='a'&&el.querySelector('img')&&!el.innerText.trim();
      var key=tag+'|'+cls+'|'+(isImgLink?'imglink':'text');
      if(seen[key])return;
      seen[key]=true;
      var preview=isImgLink
        ?'[img-link] '+(el.querySelector('img').getAttribute('src')||'').split('/').pop().split('?')[0].slice(0,40)
        :el.innerText.trim().slice(0,60);
      var priority=isImgLink?95:(TAG_PRIORITY[tag]!==undefined?TAG_PRIORITY[tag]:50);
      catalog.push({idx:i,tag:tag,className:(el.className||'').trim(),preview:preview,isImgLink:isImgLink,priority:priority,outerHTML:el.outerHTML});
    });

    // ── Standalone img elements (not inside any text element) ────────────────
    document.querySelectorAll('img').forEach(function(img){
      if(!scope.contains(img))return;
      if(inChrome(img))return;
      // Skip imgs already covered via isImgLink (parent is a text element)
      var par=img.parentNode;
      while(par&&par!==document.body){
        if(par.tagName&&/^(h[1-6]|p|li|button|a|label)$/i.test(par.tagName))return;
        par=par.parentNode;
      }
      var src=resolveImgSrc(img);
      var name=src.split('/').pop().split('?')[0].slice(0,40);
      var cls=firstCls(img);
      var key='img|'+cls+'|'+name;
      if(seen[key])return;
      seen[key]=true;
      catalog.push({idx:null,tag:'img',className:(img.className||'').trim(),preview:'[img] '+name,isImgLink:false,isImg:true,priority:8,outerHTML:img.outerHTML,selectorPath:buildEptPath(img)});
    });

    catalog.sort(function(a,b){return a.priority-b.priority;});
    catalog=catalog.slice(0,20);
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

  // ─── Pick mode (delete or scope) ──────────────────────────────────────────────
  var pickActive=false;
  var pickPurpose='delete';
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
      type: pickPurpose==='scope' ? 'ept-scope-pick' : 'ept-pick-delete',
      purpose: pickPurpose,
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

  function setPickMode(on, purpose){
    pickActive=on;
    pickPurpose=purpose||'delete';
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
      if(!el)return;
      // html is outerHTML — extract innerHTML for live preview
      var tmp=document.createElement('div');
      tmp.innerHTML=e.data.html;
      var inner=tmp.firstElementChild?tmp.firstElementChild.innerHTML:e.data.html;
      el.innerHTML=inner;
    }
    if(e.data.type==='ept-update-spacing'){
      var spEl=els[e.data.idx];
      if(!spEl)return;
      var m=e.data.margin||{},p=e.data.padding||{};
      spEl.style.marginTop=m.top||'';spEl.style.marginRight=m.right||'';
      spEl.style.marginBottom=m.bottom||'';spEl.style.marginLeft=m.left||'';
      spEl.style.paddingTop=p.top||'';spEl.style.paddingRight=p.right||'';
      spEl.style.paddingBottom=p.bottom||'';spEl.style.paddingLeft=p.left||'';
    }
    if(e.data.type==='ept-deselect'){clearAll();}
    if(e.data.type==='ept-highlight'){
      clearAll();
      var el=els[e.data.idx];
      if(el){el.setAttribute('data-ept-selected','1');el.scrollIntoView({behavior:'smooth',block:'center'});}
    }
    if(e.data.type==='ept-img-update'){
      // External image replaced with local file — use selector for direct update
      if(e.data.selectorPath&&e.data.newSrc){
        try{
          var _extImg=document.querySelector(e.data.selectorPath);
          if(_extImg){
            ['srcset','data-srcset','data-src','data-lazy','data-original','data-lazy-src','data-full','sizes','data-sizes'].forEach(function(a){_extImg.removeAttribute(a);});
            _extImg.src=e.data.newSrc+'?t='+Date.now();
          }
        }catch(err){}
        return;
      }
      var ALL_SRC_ATTRS=['src'].concat(LAZY_ATTRS);
      document.querySelectorAll('img').forEach(function(img){
        // Check src and all lazy attrs for a filename match
        var matched=false;
        for(var _ai=0;_ai<ALL_SRC_ATTRS.length;_ai++){
          var _v=img.getAttribute(ALL_SRC_ATTRS[_ai])||'';
          var _parts=_v.split(',');
          for(var _pi=0;_pi<_parts.length;_pi++){
            if(_parts[_pi].trim().split(/\s+/)[0].split('/').pop().split('?')[0]===e.data.name){matched=true;break;}
          }
          if(matched)break;
        }
        if(!matched)return;
        var _t=Date.now();
        // Cache-bust visible src if it's a real URL; if data URI, force-load real image
        var _visSrc=img.getAttribute('src')||'';
        if(_visSrc&&!_visSrc.startsWith('data:')){
          img.src=_visSrc.split('?')[0]+'?t='+_t;
        } else {
          // Lazy-loaded: set src directly to real URL so preview refreshes immediately
          var _realSrc=resolveImgSrc(img);
          if(_realSrc&&!_realSrc.startsWith('data:')){img.src=_realSrc.split('?')[0]+'?t='+_t;}
        }
        // Cache-bust all lazy attrs so loaders pick up new file on next trigger
        LAZY_ATTRS.forEach(function(a){
          var _lv=img.getAttribute(a);if(!_lv)return;
          img.setAttribute(a,_lv.replace(/([^\s,]+)/g,function(u){
            return u.split('/').pop().split('?')[0]===e.data.name?u.split('?')[0]+'?t='+_t:u;
          }));
        });
      });
    }
    if(e.data.type==='ept-video-update'){
      document.querySelectorAll('video').forEach(function(vid){
        var src=vid.getAttribute('src')||'';
        var name=src.split('/').pop().split('?')[0];
        if(name===e.data.name){var base=src.split('?')[0];vid.src=base+'?t='+Date.now();vid.load();}
      });
    }
    if(e.data.type==='ept-pick-mode'){setPickMode(!!e.data.active, e.data.purpose);}
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

  // Strip editor-injected attributes before writing to file
  const $tmp = cheerio.load(text, { decodeEntities: false });
  $tmp('*').each((i, node) => {
    Object.keys(node.attribs || {}).forEach(attr => {
      if (attr.startsWith('data-ept-')) $tmp(node).removeAttr(attr);
    });
  });
  const cleanText = $tmp('body').html() || text;

  el.replaceWith(cleanText);
  fs.writeFileSync(indexPath, $.html(), 'utf-8');
  logActivity(sid, 'save-text', { idx, textPreview: cleanText.slice(0, 60) });
  res.json({ ok: true });
});

// ─── POST /:id/save-spacing ───────────────────────────────────────────────────
router.post('/:sessionId/save-spacing', (req, res) => {
  const { idx, margin, padding } = req.body;
  if (idx === undefined) return res.status(400).json({ error: 'idx required' });

  const sid = req.params.sessionId;
  const indexPath = getIndexPath(sid);
  if (!indexPath) return res.status(404).json({ error: 'not found' });

  const $ = cheerio.load(fs.readFileSync(indexPath, 'utf-8'), { decodeEntities: false });
  const el = $(EDITABLE_SEL).eq(Number(idx));
  if (!el.length) return res.status(404).json({ error: 'Element not found' });

  // Parse existing inline style into object
  const existing = {};
  (el.attr('style') || '').split(';').forEach(part => {
    const sep = part.indexOf(':');
    if (sep < 0) return;
    const k = part.slice(0, sep).trim();
    const v = part.slice(sep + 1).trim();
    if (k) existing[k] = v;
  });

  // Merge margin/padding — empty value removes the property
  const sides = ['top', 'right', 'bottom', 'left'];
  sides.forEach(s => {
    const mk = `margin-${s}`, pk = `padding-${s}`;
    const mv = margin?.[s], pv = padding?.[s];
    if (mv === '' || mv === undefined) delete existing[mk]; else existing[mk] = mv;
    if (pv === '' || pv === undefined) delete existing[pk]; else existing[pk] = pv;
  });

  const newStyle = Object.entries(existing).map(([k, v]) => `${k}: ${v}`).join('; ');
  if (newStyle) el.attr('style', newStyle); else el.removeAttr('style');

  fs.writeFileSync(indexPath, $.html(), 'utf-8');
  logActivity(sid, 'save-spacing', { idx });
  res.json({ ok: true });
});

// ─── Scoped content rewrite (deterministic paragraph mapping — no AI call) ───
function normalizeReplacements(rawList, allowedIdx) {
  const out = [];
  const seen = new Set();
  for (const r of rawList) {
    const idx = Number(r.idx);
    if (!Number.isInteger(idx) || idx < 0 || !allowedIdx.has(idx)) continue;
    if (seen.has(idx)) continue;
    seen.add(idx);
    let text = typeof r.text === 'string' ? r.text : '';
    text = text.replace(/\r/g, '');
    if (/<\s*script/i.test(text)) continue;
    if (text.length > 16000) text = text.slice(0, 16000);
    out.push({ idx, text });
  }
  return out;
}

// ─── GET /:id/detect-scope — preview detected (or custom) scope without calling xAI ──
router.get('/:sessionId/detect-scope', (req, res) => {
  const sid = req.params.sessionId;
  const indexPath = getIndexPath(sid);
  if (!indexPath) return res.status(404).json({ error: 'not found' });
  const $ = cheerio.load(fs.readFileSync(indexPath, 'utf-8'), { decodeEntities: false });
  const sel = typeof req.query?.scopeSelector === 'string' && req.query.scopeSelector.trim() ? req.query.scopeSelector.trim() : null;
  const { scopeLabel, scopeSelectorPath, scopeUsedCustom, elements } = getContentScopedEditables($, EDITABLE_SEL, sel);
  const imgs = getScopedImages($, sel);
  const vids = getScopedVideos($, sel);
  const hasForm = hasFormInScope($, sel);
  res.json({
    ok: true,
    scopeLabel,
    scopeSelectorPath,
    scopeUsedCustom,
    editableCount: elements.length,
    imageCount: imgs.length,
    videoCount: vids.length,
    hasForm,
    sampleTexts: elements.slice(0, 6).map((e) => ({ tag: e.tag, text: e.text.slice(0, 140) })),
  });
});

router.post('/:sessionId/xai-suggest', async (req, res) => {
  const sid = req.params.sessionId;
  const indexPath = getIndexPath(sid);
  if (!indexPath) return res.status(404).json({ error: 'not found' });

  const brief = typeof req.body?.brief === 'string' ? req.body.brief.trim() : '';
  if (!brief || brief.length > 120000) {
    return res.status(400).json({ error: 'brief required (max 120000 chars)' });
  }

  const scopeSelector = typeof req.body?.scopeSelector === 'string' && req.body.scopeSelector.trim()
    ? req.body.scopeSelector.trim()
    : null;
  const $ = cheerio.load(fs.readFileSync(indexPath, 'utf-8'), { decodeEntities: false });
  const { scopeLabel, scopeSelectorPath, scopeUsedCustom, elements } = getContentScopedEditables($, EDITABLE_SEL, scopeSelector);
  const scopedImages = getScopedImages($, scopeSelector);
  const scopedVideos = getScopedVideos($, scopeSelector);
  const photoMarkersList = parsePhotoMarkers(brief);
  const videoMarkersList = parseVideoMarkers(brief);
  const placeholderRaw = parsePlaceholderMarkers(brief);
  const scopeHasForm = hasFormInScope($, scopeSelector);
  const placeholderInfo = {
    needsFormParagraph: placeholderRaw.needsForm && !scopeHasForm,
    formText: placeholderRaw.formText,
    hasForm: scopeHasForm,
    formInBrief: placeholderRaw.needsForm,
  };
  const scopedImagesPreview = scopedImages.slice(0, 36).map((im, index) => ({
    index,
    name: im.name,
    url: `/session-files/${sid}/${im.src.replace(/^\//, '')}`,
  }));
  const scopedVideosPreview = scopedVideos.slice(0, 24).map((v, index) => {
    let posterUrl = null;
    try {
      const node = $(v.selectorPath).get(0);
      if (node) {
        const poster = $(node).attr('poster') || '';
        if (poster.trim() && !poster.startsWith('data:')) {
          posterUrl = `/session-files/${sid}/${poster.replace(/^\//, '')}`;
        }
      }
    } catch (_) { /* ignore */ }
    return {
      index,
      name: v.name,
      posterUrl,
      srcLabel: (v.src || '').split('/').pop() || v.name,
    };
  });

  if (!elements.length) {
    return res.status(400).json({
      error: 'No editable text blocks in content scope (inside main/article, excluding header/footer/nav/aside).',
      scopeLabel,
    });
  }

  try {
    const { blocks, photoSlots, videoSlots } = parseBrief(brief);
    if (!blocks.length) {
      return res.status(400).json({
        error: 'Pasted text has no readable paragraphs (only photo/video markers were detected).',
      });
    }

    // Build the SLOTS manifest the LLM will reason over. Slot numbers are
    // 1-based DOM order in the picked zone (n=1..elements.length). We hand
    // a short preview of the slot's current text so the model can match
    // headings / dialogue / list items semantically.
    const slotsManifest = elements.map((e, i) => ({
      n: i + 1,
      tag: e.tag,
      current: (e.text || '').slice(0, 180),
    }));

    // Single Grok call. The prompt does ALL the placement, tag-swapping,
    // overflow-cloning and photo-positioning. Server post-processes the
    // returned JSON deterministically; no second AI call.
    const briefForModel = brief.slice(0, 24000);
    const userMessage = [
      '### TEXT (article body to place; keep verbatim)',
      briefForModel,
      '',
      '### SLOTS (DOM order, 1-based)',
      JSON.stringify(slotsManifest, null, 0),
    ].join('\n');

    let aiPlan = null;
    let aiUsage = null;
    try {
      const aiRes = await chatCompletion({
        messages: [
          { role: 'system', content: rewritePrompt },
          { role: 'user', content: userMessage },
        ],
        jsonMode: true,
        maxCompletionTokens: 12000,
      });
      aiUsage = aiRes.usage;
      try {
        aiPlan = JSON.parse(aiRes.content);
      } catch (parseErr) {
        const stripped = aiRes.content
          .replace(/^[\s\S]*?\{/, '{')
          .replace(/\}[\s\S]*$/, '}');
        try {
          aiPlan = JSON.parse(stripped);
        } catch (_) {
          throw new Error(`AI returned non-JSON: ${aiRes.content.slice(0, 240)}`);
        }
      }
    } catch (apiErr) {
      console.error('[xai-suggest] LLM call failed:', apiErr.message);
      return res.status(502).json({
        error: `AI placement failed: ${apiErr.message}. Check XAI_API_KEY in server/.env.`,
        code: apiErr.code || 'AI_FAIL',
      });
    }

    if (!aiPlan || typeof aiPlan !== 'object') {
      return res.status(502).json({ error: 'AI returned an empty plan' });
    }

    const aiFills = Array.isArray(aiPlan.fills) ? aiPlan.fills : [];
    const aiDeletes = Array.isArray(aiPlan.deletes) ? aiPlan.deletes : [];
    const aiExtensions = Array.isArray(aiPlan.extensions) ? aiPlan.extensions : [];
    const aiPhotos = Array.isArray(aiPlan.photos) ? aiPlan.photos : [];
    const aiVideos = Array.isArray(aiPlan.videos) ? aiPlan.videos : [];

    // Apply extensions (clone N body slots after slotN). aiExtensions:
    // [{afterSlot:int, tag:'p'|'li', texts:[...]}] in slot-order. We translate
    // each entry into a single applySlotExtensionPlan op (cloning the
    // afterSlot's element `texts.length` times) and remember the cloned
    // slots' eventual texts in `extensionTexts` keyed by clone-order.
    const validTags = new Set(['p', 'li']);
    const slotExtensionPlan = [];
    const extensionFillTexts = []; // ordered list of (text) for cloned slots
    for (const ext of aiExtensions) {
      if (!ext || !Number.isInteger(ext.afterSlot)) continue;
      const slotNum = ext.afterSlot;
      const sourceIdx = slotNum >= 1 && slotNum <= elements.length
        ? elements[slotNum - 1].idx
        : null;
      if (sourceIdx == null) continue;
      const tag = validTags.has(String(ext.tag).toLowerCase())
        ? String(ext.tag).toLowerCase()
        : 'p';
      const texts = Array.isArray(ext.texts) ? ext.texts.filter((t) => typeof t === 'string') : [];
      if (!texts.length) continue;
      slotExtensionPlan.push({ sourceIdx, count: texts.length, tag });
      for (const t of texts) extensionFillTexts.push(t);
    }
    let slotsCloned = 0;
    let workingElements = elements;
    let workingScopeMeta = { scopeLabel, scopeSelectorPath, scopeUsedCustom };
    if (slotExtensionPlan.length) {
      slotsCloned = applySlotExtensionPlan($, slotExtensionPlan, EDITABLE_SEL);
      const rescan = listScopedEditablesPostExtension($, EDITABLE_SEL, scopeSelector);
      workingElements = rescan.elements;
      workingScopeMeta = {
        scopeLabel: rescan.scopeLabel,
        scopeSelectorPath: rescan.scopeSelectorPath,
        scopeUsedCustom: rescan.scopeUsedCustom,
      };
    }

    // Build replacement records for original slots.
    const fillsBySlot = new Map();
    for (const f of aiFills) {
      if (!f || !Number.isInteger(f.slot)) continue;
      if (f.slot < 1 || f.slot > elements.length) continue;
      fillsBySlot.set(f.slot, f);
    }
    const deleteSet = new Set(aiDeletes.filter((n) => Number.isInteger(n) && n >= 1 && n <= elements.length));

    const replacements = [];
    let deleted = 0;
    let tagSwaps = 0;
    elements.forEach((e, i) => {
      const slotNum = i + 1;
      const fill = fillsBySlot.get(slotNum);
      if (fill && typeof fill.text === 'string' && fill.text.trim() !== '') {
        const rec = { idx: e.idx, text: fill.text, slot: slotNum };
        const reqTag = String(fill.replaceTag || '').toLowerCase();
        if (reqTag && reqTag !== e.tag && /^(p|h1|h2|h3|h4|h5|h6|li)$/.test(reqTag)) {
          rec.replaceTag = reqTag;
          tagSwaps++;
        }
        replacements.push(rec);
        return;
      }
      // Either explicitly listed in deletes OR not mentioned anywhere — both
      // mean "remove". The LLM was instructed to enumerate every slot;
      // anything missing gets removed for cleanliness.
      replacements.push({ idx: e.idx, text: '', slot: slotNum });
      deleted++;
    });

    // Cloned slots get the extension texts. After applySlotExtensionPlan +
    // rescan, workingElements > elements; the new entries (cloned===true)
    // appear right after their source slot in DOM order. We feed them
    // extensionFillTexts in order. Cloned slots don't need a slot number —
    // photos never reference them (the LLM only sees original 1..N).
    if (extensionFillTexts.length) {
      const cloneSlots = workingElements.filter((e) => e.cloned);
      for (let k = 0; k < cloneSlots.length && k < extensionFillTexts.length; k++) {
        replacements.push({
          idx: cloneSlots[k].idx,
          text: extensionFillTexts[k],
        });
      }
    }

    // Photo / video positioning. The LLM gives `beforeSlot` (the slot
    // number BEFORE which the marker sits). Apply-time will resolve this
    // against `[data-ept-slot="N"]` markers we'll stamp during xai-apply,
    // so deletions / tag-swaps / clone insertions don't break the lookup.
    // No CSS paths needed — `data-ept-slot` is anchored to the node itself.
    function buildPositionPlan(markers) {
      const list = (Array.isArray(markers) ? markers : [])
        .filter((m) => m && Number.isInteger(m.num) && m.num >= 1);
      const seen = new Set();
      const out = [];
      for (const m of list) {
        if (seen.has(m.num)) continue;
        seen.add(m.num);
        const before = Number.isInteger(m.beforeSlot) ? m.beforeSlot : null;
        const atEnd = before == null || before > elements.length;
        out.push({
          num: m.num,
          beforeSlot: before,
          atEnd,
        });
      }
      out.sort((a, b) => a.num - b.num);
      return out;
    }
    let photoMoves = buildPositionPlan(aiPhotos);
    let videoMoves = buildPositionPlan(aiVideos);
    if (!photoMoves.length && photoSlots.length) {
      photoMoves = photoSlots.map((m) => ({ num: m.num, beforeSlot: null, atEnd: true }))
        .sort((a, b) => a.num - b.num);
    }
    if (!videoMoves.length && videoSlots.length) {
      videoMoves = videoSlots.map((m) => ({ num: m.num, beforeSlot: null, atEnd: true }))
        .sort((a, b) => a.num - b.num);
    }

    const mediaTrim = {
      photoCount: photoMoves.length,
      videoCount: videoMoves.length,
    };

    const previewRows = replacements.map((r) => {
      const prev = workingElements.find((el) => el.idx === r.idx);
      const willDelete = typeof r.text !== 'string' || r.text.trim() === '';
      return {
        idx: r.idx,
        slot: r.slot || null,
        tag: prev?.tag || '?',
        oldText: prev?.cloned ? '' : (prev?.text || ''),
        newText: r.text,
        cloned: !!prev?.cloned,
        deleting: willDelete,
        kept: false,
        replaceTag: r.replaceTag || null,
      };
    });

    logActivity(sid, 'xai-suggest', {
      mode: 'llm-place',
      replacementsCount: replacements.length,
      blocksCount: blocks.length,
      scopeLabel: workingScopeMeta.scopeLabel,
      slotsCloned,
      deletedCount: deleted,
      tagSwaps,
      photoMoves: photoMoves.length,
      videoMoves: videoMoves.length,
      imagesInScope: scopedImages.length,
      videosInScope: scopedVideos.length,
      ...(aiUsage ? { xai_usage: aiUsage } : {}),
    });

    res.json({
      ok: true,
      scopeLabel: workingScopeMeta.scopeLabel,
      scopeSelectorPath: workingScopeMeta.scopeSelectorPath,
      scopeUsedCustom: workingScopeMeta.scopeUsedCustom,
      scopedBlockCount: workingElements.length,
      blocksCount: blocks.length,
      replacements,
      previewRows,
      slotExtensionPlan,
      slotsCloned,
      deletedCount: deleted,
      tagSwaps,
      photoMarkers: photoMarkersList,
      videoMarkers: videoMarkersList,
      photoMoves,
      videoMoves,
      mediaTrim,
      scopedImageCount: scopedImages.length,
      scopedImagesPreview,
      scopedVideoCount: scopedVideos.length,
      scopedVideosPreview,
      placeholderInfo,
      aiUsage,
      aiModel: aiUsage?.model || DEFAULT_MODEL,
    });
  } catch (err) {
    console.error('[xai-suggest]', err);
    return res.status(500).json({ error: err.message || 'rewrite failed' });
  }
});

// ─── GET /:id/scoped-images — ordered imgs in content scope (for ФОТО picker UI) ─
router.get('/:sessionId/scoped-images', (req, res) => {
  const sid = req.params.sessionId;
  const indexPath = getIndexPath(sid);
  if (!indexPath) return res.status(404).json({ error: 'not found' });
  const $ = cheerio.load(fs.readFileSync(indexPath, 'utf-8'), { decodeEntities: false });
  const sel = typeof req.query?.scopeSelector === 'string' && req.query.scopeSelector.trim() ? req.query.scopeSelector.trim() : null;
  const imgs = getScopedImages($, sel);
  const list = imgs.map((im, index) => ({
    index,
    name: im.name,
    src: im.src,
    url: `/session-files/${sid}/${im.src.replace(/^\//, '')}`,
  }));
  res.json({ images: list, count: list.length });
});

// ─── POST /:id/apply-photo-markers — ФОТО N → scoped img[n-1], save as WebP ───
router.post('/:sessionId/apply-photo-markers', uploadOrJsonError(upload.array('photo', 24)), async (req, res) => {
  const sid = req.params.sessionId;
  const indexPath = getIndexPath(sid);
  if (!indexPath) return res.status(404).json({ error: 'not found' });

  let slots;
  try {
    slots = JSON.parse(req.body.slots || '[]');
  } catch {
    return res.status(400).json({ error: 'slots must be JSON array of numbers, e.g. [1,2]' });
  }
  if (!Array.isArray(slots) || !slots.length) {
    return res.status(400).json({ error: 'slots required' });
  }
  const files = req.files || [];
  if (files.length !== slots.length) {
    return res.status(400).json({
      error: `Photo upload mismatch: ${slots.length} slot(s) selected (ФОТО ${slots.join(', ')}) but server received ${files.length} file(s). Likely a file was cleared in the picker, or a single file was over 100 MB.`,
      slotsExpected: slots.length,
      filesReceived: files.length,
    });
  }

  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    return res.status(501).json({ error: 'sharp required for WebP. Run: npm install sharp in server/' });
  }

  const sessionDir = getSessionDir(sid);
  const imgDir = path.join(sessionDir, 'img');
  fs.mkdirSync(imgDir, { recursive: true });

  const $ = cheerio.load(fs.readFileSync(indexPath, 'utf-8'), { decodeEntities: false });
  const scopeSel = typeof req.body?.scopeSelector === 'string' && req.body.scopeSelector.trim() ? req.body.scopeSelector.trim() : null;
  let imgs = getScopedImages($, scopeSel);
  if (!imgs.length) {
    return res.status(400).json({ error: 'No images found in content scope' });
  }

  for (let i = 0; i < slots.length; i++) {
    const slot = Number(slots[i]);
    if (!Number.isInteger(slot) || slot < 1) {
      return res.status(400).json({ error: `Invalid slot: ${slots[i]}` });
    }
  }

  // Auto-clone last <img> when ФОТО N markers exceed available images in scope.
  // "the same kind by analogy until all the photos fit". Cloned <img> inherits
  // wrapper/class/style; src and lazy attrs are stripped (we set src below).
  const maxSlot = Math.max(...slots.map((s) => Number(s)));
  let imagesCloned = 0;
  if (maxSlot > imgs.length) {
    const { node: scopeNode } = resolveScope($, scopeSel);
    const deficit = maxSlot - imgs.length;
    // Clone the LAST IN-FLOW article photo as template — not the very last
    // <img> in scope (often a footer share-toolbar icon), which would be
    // filtered out again by getScopedImages.
    const templateEl = imgs.length ? $(imgs[imgs.length - 1].selectorPath).get(0) : null;
    const inserted = extendMediaInScope($, scopeNode, 'img', deficit, (node) => buildEptPathCheerio(node), templateEl);
    imagesCloned = inserted.length;
    if (imagesCloned < deficit) {
      return res.status(400).json({
        error: `ФОТО ${maxSlot}: scope has only ${imgs.length} image(s) and no template <img> to clone — pick a scope that contains at least one image.`,
      });
    }
    // Cloned <img> have no src (extendMediaInScope strips it so the upload
    // overwrites it cleanly), so getScopedImages — which requires a real src
    // — would silently drop them on rescan. Append cloned imgs explicitly
    // by their data-ept-cloned marker, in DOM order, AFTER the existing
    // in-flow list. ФОТО N then maps to imgs[N-1] as expected.
    const seen = new Set(imgs.map((i) => i.selectorPath));
    $('img[data-ept-cloned="1"]').each((_i, el) => {
      if (!el || el.type !== 'tag') return;
      let cur = el;
      let inScope = false;
      while (cur) { if (cur === scopeNode) { inScope = true; break; } cur = cur.parent; }
      if (!inScope) return;
      const sp = buildEptPathCheerio(el);
      if (seen.has(sp)) return;
      seen.add(sp);
      const src = $(el).attr('src') || '';
      imgs.push({
        selectorPath: sp,
        src,
        name: (src || `clone-${imgs.length + 1}`).replace(/^\//, '').split('/').pop().split('?')[0],
      });
    });
  }

  const LAZY_ATTRS = ['data-src', 'data-srcset', 'srcset', 'data-lazy', 'data-original', 'data-lazy-src', 'data-full', 'data-sizes', 'sizes'];

  try {
    for (let i = 0; i < slots.length; i++) {
      const slot = Number(slots[i]);
      const imgIdx = slot - 1;
      const meta = imgs[imgIdx];
      if (!meta) {
        return res.status(400).json({ error: `ФОТО ${slot}: image slot missing after auto-clone (have ${imgs.length})` });
      }
      const fileName = `ept-${Date.now()}-${i}-slot${slot}.webp`;
      const destAbs = path.join(imgDir, fileName);
      const relPath = `img/${fileName}`;

      await sharp(files[i].buffer)
        .webp({ quality: 82 })
        .toFile(destAbs);

      const el = $(meta.selectorPath);
      if (!el.length) {
        return res.status(500).json({ error: `Selector failed for ФОТО ${slot}` });
      }
      el.attr('src', relPath);
      LAZY_ATTRS.forEach((a) => el.removeAttr(a));

      // For cloned imgs we also wrap in <a data-ept-cloned="1"> with no href.
      // Now that the photo file exists, point that wrapper at the new image
      // (lightbox-style click-to-open). For the original (non-cloned) img we
      // leave its existing wrapping alone — the designer's link target may
      // intentionally differ from the photo source.
      const parent = el.parent();
      if (
        parent.length
        && (parent.get(0).name || '').toLowerCase() === 'a'
        && parent.attr('data-ept-cloned') === '1'
      ) {
        parent.attr('href', relPath);
      }
    }

    // Reposition each <img> (or its <a>/<figure>/<picture> wrapper) so it
    // appears in the SAME order in the DOM as the operator's brief.
    //
    // CRITICAL: cheerio nth-child selectors are evaluated against the LIVE
    // tree, so as soon as we move the first photo the selector paths for
    // the remaining ones become stale (every sibling has shifted). We
    // therefore resolve ALL source + target nodes UPFRONT in two passes,
    // holding cheerio node references (not selector strings) — node refs
    // survive any number of subsequent moves.
    let movedPhotos = 0;
    if (req.body.photoMoves) {
      let moves = req.body.photoMoves;
      if (typeof moves === 'string') {
        try { moves = JSON.parse(moves); } catch { moves = []; }
      }
      if (Array.isArray(moves)) {
        const scopeNode = resolveScope($, scopeSel).node;
        const resolved = [];
        for (const move of moves) {
          if (!move || !Number.isInteger(move.num) || move.num < 1) continue;
          const meta = imgs[move.num - 1];
          if (!meta) continue;
          const imgNode = $(meta.selectorPath).get(0);
          if (!imgNode) continue;
          // Pick the OUTERMOST wrapper that exists solely for this image —
          // typically <a><img></a> or <figure><img></figure>.
          let moveNode = imgNode;
          const $img = $(imgNode);
          let $cur = $img;
          for (let depth = 0; depth < 3; depth++) {
            const $p = $cur.parent();
            if (!$p.length) break;
            const pTag = ($p.get(0).name || '').toLowerCase();
            if (pTag !== 'a' && pTag !== 'figure' && pTag !== 'picture') break;
            // wrapper must hold ONLY this image (and at most a <figcaption>
            // in <figure>), otherwise we'd drag unrelated siblings around
            const sibCount = $p.children().toArray()
              .filter((c) => c.type === 'tag' && (c.name || '').toLowerCase() !== 'figcaption')
              .length;
            if (sibCount > 1) break;
            moveNode = $p.get(0);
            $cur = $p;
          }
          let targetNode = null;
          if (!move.atEnd) {
            if (Number.isInteger(move.beforeSlot) && move.beforeSlot >= 1) {
              targetNode = $(`[data-ept-slot="${move.beforeSlot}"]`).get(0) || null;
            }
            if (!targetNode && move.beforeSelectorPath) {
              targetNode = $(move.beforeSelectorPath).get(0) || null;
            }
          }
          resolved.push({ moveNode, targetNode, atEnd: !!move.atEnd || !targetNode, num: move.num });
        }
        // Pass 2: actually move. Order doesn't matter because we hold node
        // refs — but DOM-order (ascending num) is the natural fit.
        for (const r of resolved) {
          if (r.atEnd || !r.targetNode) {
            if (scopeNode) {
              $(scopeNode).append(r.moveNode);
              movedPhotos++;
            }
            continue;
          }
          $(r.targetNode).before(r.moveNode);
          movedPhotos++;
        }
      }
    }

    fs.writeFileSync(indexPath, $.html(), 'utf-8');
    logActivity(sid, 'apply-photo-markers', { slots, count: slots.length, imagesCloned, movedPhotos });
    res.json({ ok: true, applied: slots.length, imagesCloned, movedPhotos });
  } catch (e) {
    console.error('[apply-photo-markers]', e);
    res.status(500).json({ error: e.message || 'WebP / write failed' });
  }
});

// ─── POST /:id/apply-video-markers — VIDEO N → scoped video[N-1], replace file ─
router.post('/:sessionId/apply-video-markers', uploadOrJsonError(upload.array('video', 24)), async (req, res) => {
  const sid = req.params.sessionId;
  const indexPath = getIndexPath(sid);
  if (!indexPath) return res.status(404).json({ error: 'not found' });

  let slots;
  try {
    slots = JSON.parse(req.body.slots || '[]');
  } catch {
    return res.status(400).json({ error: 'slots must be JSON array of numbers, e.g. [1,2]' });
  }
  if (!Array.isArray(slots) || !slots.length) {
    return res.status(400).json({ error: 'slots required' });
  }
  const files = req.files || [];
  if (files.length !== slots.length) {
    return res.status(400).json({
      error: `Video upload mismatch: ${slots.length} slot(s) selected (VIDEO ${slots.join(', ')}) but server received ${files.length} file(s). Likely a file was cleared in the picker, or a single file was over 100 MB.`,
      slotsExpected: slots.length,
      filesReceived: files.length,
    });
  }

  const sessionDir = getSessionDir(sid);
  const videoDir = path.join(sessionDir, 'video');
  fs.mkdirSync(videoDir, { recursive: true });

  const $ = cheerio.load(fs.readFileSync(indexPath, 'utf-8'), { decodeEntities: false });
  const scopeSelV = typeof req.body?.scopeSelector === 'string' && req.body.scopeSelector.trim() ? req.body.scopeSelector.trim() : null;
  let vids = getScopedVideos($, scopeSelV);
  if (!vids.length) {
    return res.status(400).json({ error: 'No videos found in content scope' });
  }

  for (let i = 0; i < slots.length; i++) {
    const slot = Number(slots[i]);
    if (!Number.isInteger(slot) || slot < 1) {
      return res.status(400).json({ error: `Invalid slot: ${slots[i]}` });
    }
  }

  // Auto-clone last <video> when VIDEO N markers exceed available videos in
  // scope. Cloned <video> keeps wrapper/class/style; src + <source> children
  // are stripped (set fresh below).
  const maxSlotV = Math.max(...slots.map((s) => Number(s)));
  let videosCloned = 0;
  if (maxSlotV > vids.length) {
    const { node: scopeNode } = resolveScope($, scopeSelV);
    const deficit = maxSlotV - vids.length;
    const inserted = extendMediaInScope($, scopeNode, 'video', deficit, (node) => buildEptPathCheerio(node));
    videosCloned = inserted.length;
    if (videosCloned < deficit) {
      return res.status(400).json({
        error: `VIDEO ${maxSlotV}: scope has only ${vids.length} video(s) and no template <video> to clone — pick a scope that contains at least one video.`,
      });
    }
    vids = getScopedVideos($, scopeSelV);
  }

  try {
    for (let i = 0; i < slots.length; i++) {
      const slot = Number(slots[i]);
      const vidIdx = slot - 1;
      const meta = vids[vidIdx];
      if (!meta) {
        return res.status(400).json({ error: `VIDEO ${slot}: video slot missing after auto-clone (have ${vids.length})` });
      }
      const origName = files[i].originalname || `upload-${i}.mp4`;
      let ext = path.extname(origName);
      if (!ext || !/^\.[a-z0-9]{1,8}$/i.test(ext)) ext = '.mp4';
      const fileName = `ept-${Date.now()}-${i}-slot${slot}${ext}`;
      const relPath = `video/${fileName}`;
      const destAbs = path.join(sessionDir, relPath);
      fs.writeFileSync(destAbs, files[i].buffer);

      const el = $(meta.selectorPath);
      if (!el.length) {
        return res.status(500).json({ error: `Selector failed for VIDEO ${slot}` });
      }
      const $v = el;
      const $sources = $v.find('source');
      if ($sources.length) {
        $sources.first().attr('src', relPath);
        $v.removeAttr('src');
      } else {
        $v.attr('src', relPath);
      }
      $v.attr('controls', '');
    }

    // Reposition each <video> to match the brief's order. Same two-pass
    // resolve-then-move dance as apply-photo-markers — see comment there.
    let movedVideos = 0;
    if (req.body.videoMoves) {
      let moves = req.body.videoMoves;
      if (typeof moves === 'string') {
        try { moves = JSON.parse(moves); } catch { moves = []; }
      }
      if (Array.isArray(moves)) {
        const scopeNode = resolveScope($, scopeSelV).node;
        const resolved = [];
        for (const move of moves) {
          if (!move || !Number.isInteger(move.num) || move.num < 1) continue;
          const meta = vids[move.num - 1];
          if (!meta) continue;
          const node = $(meta.selectorPath).get(0);
          if (!node) continue;
          let targetNode = null;
          if (!move.atEnd) {
            if (Number.isInteger(move.beforeSlot) && move.beforeSlot >= 1) {
              targetNode = $(`[data-ept-slot="${move.beforeSlot}"]`).get(0) || null;
            }
            if (!targetNode && move.beforeSelectorPath) {
              targetNode = $(move.beforeSelectorPath).get(0) || null;
            }
          }
          resolved.push({ moveNode: node, targetNode, atEnd: !!move.atEnd || !targetNode, num: move.num });
        }
        for (const r of resolved) {
          if (r.atEnd || !r.targetNode) {
            if (scopeNode) {
              $(scopeNode).append(r.moveNode);
              movedVideos++;
            }
            continue;
          }
          $(r.targetNode).before(r.moveNode);
          movedVideos++;
        }
      }
    }

    fs.writeFileSync(indexPath, $.html(), 'utf-8');
    logActivity(sid, 'apply-video-markers', { slots, count: slots.length, videosCloned, movedVideos });
    res.json({ ok: true, applied: slots.length, videosCloned, movedVideos });
  } catch (e) {
    console.error('[apply-video-markers]', e);
    res.status(500).json({ error: e.message || 'Video write failed' });
  }
});

router.post('/:sessionId/xai-apply', (req, res) => {
  const {
    replacements,
    usageSnapshot,
    scopeSelector,
    placeholderInsertions,
    slotExtensionPlan,
    mediaTrim,
  } = req.body || {};
  if (!Array.isArray(replacements) || !replacements.length) {
    return res.status(400).json({ error: 'replacements array required' });
  }

  const sid = req.params.sessionId;
  const indexPath = getIndexPath(sid);
  if (!indexPath) return res.status(404).json({ error: 'not found' });

  const $ = cheerio.load(fs.readFileSync(indexPath, 'utf-8'), { decodeEntities: false });
  const sel = typeof scopeSelector === 'string' && scopeSelector.trim() ? scopeSelector.trim() : null;

  // Re-apply the same slot-extension plan that xai-suggest used in-memory, so
  // the idx values returned by the suggest step still address the right DOM
  // positions. The plan is deterministic (descending sourceIdx + cheerio
  // .clone/.after) so suggest-time and apply-time DOMs match.
  let slotsCloned = 0;
  if (Array.isArray(slotExtensionPlan) && slotExtensionPlan.length) {
    slotsCloned = applySlotExtensionPlan($, slotExtensionPlan, EDITABLE_SEL);
  }

  // Use post-extension scope listing so cloned slots count toward allowedIdx.
  const { scopeLabel, elements } = slotsCloned > 0
    ? listScopedEditablesPostExtension($, EDITABLE_SEL, sel)
    : getContentScopedEditables($, EDITABLE_SEL, sel);
  const allowedIdx = new Set(elements.map(e => e.idx));
  const normalized = normalizeReplacements(replacements, allowedIdx);
  if (!normalized.length) {
    return res.status(400).json({ error: 'No valid replacements for current content scope' });
  }

  // Apply replacements. Empty text == "delete this slot from the article"
  // (compact bulk-replace semantics — operator opted out of the default
  // keep-original behaviour in xai-suggest).
  //
  // CRITICAL: process in DESCENDING idx order so that .remove() on a later
  // slot doesn't shift the global EDITABLE_SEL indices of earlier slots.
  // Replacements operate on $(EDITABLE_SEL).eq(idx); removing idx N only
  // affects positions > N in the live cheerio collection.
  let applied = 0;
  let removed = 0;
  let skippedNoop = 0;
  let tagSwaps = 0;

  // replacements carry: replaceTag (heading→paragraph demotion) and `slot`
  // (1-based slot number from xai-suggest's LLM plan). We stamp `slot` on
  // the surviving element so apply-photo-markers can resolve photo
  // anchors via [data-ept-slot="N"], surviving deletions / DOM shifts.
  const tagSwapByIdx = new Map();
  const slotNumByIdx = new Map();
  for (const r of (Array.isArray(replacements) ? replacements : [])) {
    if (!r || !Number.isInteger(Number(r.idx))) continue;
    const idxNum = Number(r.idx);
    if (typeof r.replaceTag === 'string') {
      tagSwapByIdx.set(idxNum, String(r.replaceTag).toLowerCase());
    }
    if (Number.isInteger(Number(r.slot)) && Number(r.slot) >= 1) {
      slotNumByIdx.set(idxNum, Number(r.slot));
    }
  }

  const sortedNormalized = [...normalized].sort((a, b) => Number(b.idx) - Number(a.idx));
  for (const { idx, text } of sortedNormalized) {
    const el = $(EDITABLE_SEL).eq(Number(idx));
    if (!el.length) continue;
    const isEmpty = typeof text !== 'string' || text.trim() === '';
    const slotNum = slotNumByIdx.get(Number(idx));
    if (isEmpty) {
      const parent = el.parent();
      if (
        parent.length
        && parent.children().length === 1
        && parent.attr('data-ept-cloned') === '1'
      ) {
        parent.remove();
      } else {
        el.remove();
      }
      removed++;
    } else {
      const wantTag = tagSwapByIdx.get(Number(idx));
      const currentTag = (el.get(0)?.name || '').toLowerCase();
      if (wantTag && wantTag !== currentTag) {
        const safe = escapeHtmlText(text).replace(/\n/g, '<br>');
        const slotAttr = slotNum ? ` data-ept-slot="${slotNum}"` : '';
        el.replaceWith(`<${wantTag}${slotAttr}>${safe}</${wantTag}>`);
        tagSwaps++;
        applied++;
        continue;
      }

      const existingText = el.text().trim();
      const incomingText = text.trim();
      if (existingText && existingText === incomingText) {
        if (slotNum) el.attr('data-ept-slot', String(slotNum));
        skippedNoop++;
        continue;
      }
      setTextPreserveMarkup($, el, text);
      if (slotNum) el.attr('data-ept-slot', String(slotNum));
      applied++;
    }
  }

  // Lead-capture widget heading (#form-feedback-title) is inside <article>
  // but excluded from editable slots — strict pour never overwrites it, so
  // the old locale (e.g. "Regístrese ahora") survives. Clear when this apply
  // run included mediaTrim (strict article replace flow).
  let formTitlesCleared = 0;
  if (mediaTrim && typeof mediaTrim === 'object') {
    const { node: scopeAfter } = resolveScope($, sel);
    if (scopeAfter) {
      $(scopeAfter).find('#form-feedback-title, h2.form-feedback-title').each((_i, n) => {
        if ($(n).text().trim()) {
          $(n).empty();
          formTitlesCleared++;
        }
      });
    }
  }

  // Trim media that the brief doesn't account for. The strict-pour contract
  // is "the brief is the only source of truth": if the operator pasted N
  // ФОТО markers, only N images stay in scope. Anything beyond that — and
  // any leftover <video> beyond videoCount — is removed.
  //
  // If photoCount/videoCount > current count, apply-photo-markers will clone
  // the missing ones later; we never delete a slot it would need to clone.
  // mediaTrim is OPTIONAL (older clients omit it) — when missing, no media
  // changes happen here.
  let trimmedImages = 0;
  let trimmedVideos = 0;
  if (mediaTrim && typeof mediaTrim === 'object') {
    const photoCount = Number.isInteger(mediaTrim.photoCount) ? mediaTrim.photoCount : null;
    const videoCount = Number.isInteger(mediaTrim.videoCount) ? mediaTrim.videoCount : null;

    if (photoCount !== null) {
      const imgs = getScopedImages($, sel);
      const survivors = Math.max(photoCount, imgs.length); // never delete what'll be cloned later
      // Sanity: keep first `photoCount`, remove anything beyond, but only when
      // there ARE images to remove (don't touch when photoCount >= imgs.length).
      if (photoCount < imgs.length) {
        for (let i = imgs.length - 1; i >= photoCount; i--) {
          const node = $(imgs[i].selectorPath).get(0);
          if (!node) continue;
          const $node = $(node);
          // Drop the <a> wrapper if it exists ONLY to hold this <img>.
          const parent = $node.parent();
          if (
            parent.length
            && (parent.get(0).name || '').toLowerCase() === 'a'
            && parent.children().length === 1
          ) {
            parent.remove();
          } else {
            $node.remove();
          }
          trimmedImages++;
        }
      }
      // survivors variable kept as documentation; not used further
      void survivors;
    }

    if (videoCount !== null) {
      const vids = getScopedVideos($, sel);
      if (videoCount < vids.length) {
        for (let i = vids.length - 1; i >= videoCount; i--) {
          const node = $(vids[i].selectorPath).get(0);
          if (!node) continue;
          $(node).remove();
          trimmedVideos++;
        }
      }
    }
  }

  // Append a placeholder <p>ФОРМА РЕГИСТРАЦИИ</p> only when the scope has no
  // real <form> / lead-capture widget. Server re-checks state to avoid duplicates.
  let placeholdersInserted = 0;
  if (placeholderInsertions && typeof placeholderInsertions === 'object') {
    const { node: scopeNode } = resolveScope($, sel);
    const $scope = scopeNode ? $(scopeNode) : $('body').first();
    const formScopeHasIt = hasFormInScope($, sel);
    const wantForm = !!placeholderInsertions.needsFormParagraph && !formScopeHasIt;

    if (wantForm) {
      const txt = String(placeholderInsertions.formText || 'ФОРМА РЕГИСТРАЦИИ').slice(0, 200);
      $scope.append(`<p data-ept-placeholder="form">${escapeHtmlText(txt)}</p>`);
      placeholdersInserted++;
    }
  }

  fs.writeFileSync(indexPath, $.html(), 'utf-8');
  logActivity(sid, 'xai-apply', {
    applied,
    removed,
    skippedNoop,
    scopeLabel,
    placeholdersInserted,
    slotsCloned,
    trimmedImages,
    trimmedVideos,
    tagSwaps,
    formTitlesCleared,
    ...(usageSnapshot && typeof usageSnapshot === 'object' ? { xai_usage: usageSnapshot } : {}),
  });
  res.json({
    ok: true,
    applied,
    removed,
    skippedNoop,
    scopeLabel,
    placeholdersInserted,
    slotsCloned,
    trimmedImages,
    trimmedVideos,
    tagSwaps,
    formTitlesCleared,
  });
});

function escapeHtmlText(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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
router.post('/:sessionId/replace-image', uploadOrJsonError(upload.single('file')), (req, res) => {
  const { name, src, selectorPath } = req.body;
  if (!name || !req.file) return res.status(400).json({ error: 'name and file required' });

  const sid = req.params.sessionId;
  const sessionDir = getSessionDir(sid);
  const imgDir = path.join(sessionDir, 'img');

  // External URL — save file locally and rewrite HTML attributes
  const isExternal = src && /^(https?:)?\/\//i.test(src);
  if (isExternal) {
    const newName = path.basename(req.file.originalname) || name;
    const safe = newName.replace(/[^a-zA-Z0-9._-]/g, '_');
    fs.mkdirSync(imgDir, { recursive: true });
    const dest = path.join(imgDir, safe);
    fs.writeFileSync(dest, req.file.buffer);
    const localPath = `img/${safe}`;

    // Update img element in HTML: replace all src-like attrs with local path
    const indexPath = getIndexPath(sid);
    if (indexPath && selectorPath) {
      try {
        const $ = cheerio.load(fs.readFileSync(indexPath, 'utf-8'), { decodeEntities: false });
        const el = $(selectorPath);
        if (el.length) {
          el.attr('src', localPath);
          ['data-src', 'data-srcset', 'srcset', 'data-lazy', 'data-original',
           'data-lazy-src', 'data-full', 'data-sizes', 'sizes'].forEach(a => el.removeAttr(a));
          fs.writeFileSync(indexPath, $.html(), 'utf-8');
        }
      } catch (e) { /* invalid selector — skip HTML update */ }
    }

    logActivity(sid, 'replace-image', { name: safe, external: true, size: req.file.size });
    return res.json({ ok: true, newSrc: localPath, size: req.file.size });
  }

  // Local file — find and overwrite in-place
  const safe = path.basename(name);
  let dest = null;
  if (src) {
    const rel = src.split('?')[0].split('#')[0].replace(/^\//, '').split('/').filter(s => s && s !== '..' && s !== '.').join(path.sep);
    const candidate = path.join(sessionDir, rel);
    if (candidate.startsWith(sessionDir + path.sep) && fs.existsSync(candidate)) dest = candidate;
  }
  if (!dest) dest = findFileByName(sessionDir, safe);
  if (!dest) {
    fs.mkdirSync(imgDir, { recursive: true });
    dest = path.join(imgDir, safe);
  }

  if (!dest.startsWith(sessionDir + path.sep)) {
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

  // Copy shared/ assets (preloader.gif etc.)
  const sharedSrc = path.join(WIDGETS_DIR, 'shared');
  if (fs.existsSync(sharedSrc)) {
    const sharedDest = path.join(sessionDir, 'widgets/shared');
    fs.mkdirSync(sharedDest, { recursive: true });
    for (const f of fs.readdirSync(sharedSrc)) {
      const s = path.join(sharedSrc, f);
      if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(sharedDest, f));
    }
  }

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
  const { afterIdx, afterSelector, templateIdx, templateHtml } = req.body;
  const indexPath = getIndexPath(sid);
  if (!indexPath) return res.status(404).json({ error: 'Not found' });

  const html = fs.readFileSync(indexPath, 'utf-8');
  const $ = cheerio.load(html, { decodeEntities: false });
  const els = $(EDITABLE_SEL).toArray();

  // Resolve the anchor element — by selector (for images/videos) or by editable index
  let afterEl;
  if (afterSelector) {
    try { afterEl = $(afterSelector).first(); } catch {}
    if (!afterEl?.length) return res.status(404).json({ error: 'Anchor element not found' });
  } else {
    if (afterIdx < 0 || afterIdx >= els.length) return res.status(400).json({ error: 'Invalid afterIdx' });
    afterEl = $(els[afterIdx]);
  }

  // ── templateHtml path: direct HTML clone (used for standalone img catalog items) ──
  if (templateHtml) {
    const $clone = cheerio.load(templateHtml, { decodeEntities: false })('body').children().first();
    if (!$clone.length) return res.status(400).json({ error: 'Invalid templateHtml' });
    $clone.attr('data-ept-insert-tmp', '1');
    afterEl.after($clone);
    const newEls = $(EDITABLE_SEL).toArray();
    const newIdx = newEls.findIndex(e => $(e).attr('data-ept-insert-tmp') === '1');
    if (newIdx !== -1) $(newEls[newIdx]).removeAttr('data-ept-insert-tmp');
    fs.writeFileSync(indexPath, $.html());
    logActivity(sid, 'insert-after', { afterSelector, templateHtml: templateHtml.slice(0, 60), newIdx });
    return res.json({ ok: true, newIdx: newIdx === -1 ? null : newIdx, tag: $clone.get(0)?.tagName?.toLowerCase(), isImgLink: false });
  }

  if (templateIdx < 0 || templateIdx >= els.length) return res.status(400).json({ error: 'Invalid templateIdx' });
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
