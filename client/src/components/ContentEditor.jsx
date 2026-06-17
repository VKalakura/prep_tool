import { useState, useEffect, useRef, useCallback } from 'react';
import MonacoEditor from '@monaco-editor/react';
import { emmetHTML, emmetCSS, emmetJSX } from 'emmet-monaco-es';
import {
  getEditableElements, saveText, saveSpacing, xaiSuggest, xaiApply, applyPhotoMarkers, applyVideoMarkers, detectScope,
  getImages, replaceImage, compressImage, compressAll, replaceVideo, formatSnippet,
  insertAfter, deleteElement, deleteBySelector, undoDelete, insertWidget, getWidgets,
  getDevFile, saveDevFile, getDevState,
} from '../api.js';

function normalizeHtml(html) {
  return (html || '').trim().replace(/\s*\n\s*/g, ' ').replace(/  +/g, ' ');
}

async function generatePoster(videoFile) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';
    const url = URL.createObjectURL(videoFile);
    video.src = url;
    video.onloadeddata = () => { video.currentTime = 0.1; };
    video.onseeked = () => {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => { URL.revokeObjectURL(url); resolve(blob); }, 'image/webp', 0.85);
    };
    video.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
  });
}

// ─── Element label map ────────────────────────────────────────────────────────
const ELEMENT_LABELS = {
  h1:'Heading 1', h2:'Heading 2', h3:'Heading 3',
  h4:'Heading 4', h5:'Heading 5', h6:'Heading 6',
  p:'Paragraph', li:'List item', button:'Button', a:'Link', label:'Label',
};

function ElementCard({ item, sessionId, cssLinks, inlineStyles, onClick }) {
  const label = item.isImgLink ? 'Image link' : (ELEMENT_LABELS[item.tag] || item.tag);
  const base = `/session-files/${sessionId}/`;
  // cssLinks already contain fully resolved absolute URLs (l.href from iframe)
  const linkTags = cssLinks.map(h => `<link rel="stylesheet" href="${h}">`).join('');
  const styleTags = inlineStyles.map(s => `<style>${s}</style>`).join('');
  const srcdoc = `<!DOCTYPE html><html><head><base href="${base}">${linkTags}${styleTags}<style>html,body{margin:0;padding:8px 10px;overflow:hidden;background:transparent}*{pointer-events:none!important;max-width:100%!important}</style></head><body>${item.outerHTML}</body></html>`;

  return (
    <button className="element-card" onClick={onClick}>
      <div className="element-card__visual">
        <iframe
          srcDoc={srcdoc}
          sandbox="allow-same-origin"
          className="element-card__iframe"
          title={label}
          scrolling="no"
        />
      </div>
      <div className="element-card__footer">
        <code className="element-card__tag">
          &lt;{item.tag}{item.className ? ` .${item.className.split(' ')[0]}` : ''}&gt;
        </code>
        <span className="element-card__label">{label}</span>
      </div>
    </button>
  );
}

// ─── Live Text Editor ─────────────────────────────────────────────────────────
function TextEditorTab({ sessionId, onError, externalReloadKey }) {
  const iframeRef = useRef(null);
  const [selected, setSelected] = useState(null); // { idx, tag, text } | { _img: true, ... } | { _video: true, ... }
  const [editText, setEditText] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  const [iframeKey, setIframeKey] = useState(0);
  const imgReplaceRef = useRef(null);
  const [imgReplacing, setImgReplacing] = useState(false);
  const videoReplaceRef = useRef(null);
  const [videoReplacing, setVideoReplacing] = useState(false);
  const [formatting, setFormatting] = useState(false);
  const [catalog, setCatalog] = useState([]);
  const [cssLinks, setCssLinks] = useState([]);
  const [inlineStyles, setInlineStyles] = useState([]);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerTab, setPickerTab] = useState('elements'); // 'elements' | 'widgets'
  const [widgets, setWidgets] = useState(null); // null = not loaded yet
  const [previewWidget, setPreviewWidget] = useState(null); // currently previewed widget
  const [widgetPreviewTab, setWidgetPreviewTab] = useState('preview'); // 'preview' | 'html' | 'js' | 'css'
  const [inserting, setInserting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [imgDeleteConfirm, setImgDeleteConfirm] = useState(false);
  const [videoDeleteConfirm, setVideoDeleteConfirm] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [spacing, setSpacing] = useState(null); // { margin:{top,right,bottom,left}, padding:{...} } in px numbers
  const [spacingSaving, setSpacingSaving] = useState(false);
  const [previewMode, setPreviewMode] = useState('responsive'); // 'responsive' | 'desktop' | 'mobile'
  const [previewSize, setPreviewSize] = useState({ w: 0, h: 0 });
  const iframeWrapRef = useRef(null);
  const DESKTOP_W = 1280;
  const MOBILE_W = 375;
  const [deletePickMode, setDeletePickMode] = useState(false);
  const deletePickModeRef = useRef(false);
  const [pendingDelete, setPendingDelete] = useState(null); // { selector, preview }
  const pendingSelectRef = useRef(null); // { idx, tag, text } — select after iframe reload

  // Listen for messages from iframe
  useEffect(() => {
    const handler = (e) => {
      if (!e.data) return;
      if (e.data.type === 'ept-catalog') {
        setCatalog(e.data.items);
        setCssLinks(e.data.cssLinks || []);
        setInlineStyles(e.data.inlineStyles || []);
      }
      if (e.data.type === 'ept-select') {
        const clean = normalizeHtml(e.data.html);
        setSelected({ idx: e.data.idx, tag: e.data.tag, text: clean });
        setEditText(clean);
        setShowPicker(false);
        if (e.data.spacing) {
          const px = (v) => parseInt(v, 10) || 0;
          const { margin: m, padding: p } = e.data.spacing;
          setSpacing({
            margin:  { top: px(m.top),  right: px(m.right),  bottom: px(m.bottom),  left: px(m.left)  },
            padding: { top: px(p.top),  right: px(p.right),  bottom: px(p.bottom),  left: px(p.left)  },
          });
        }
      }
      if (e.data.type === 'ept-img-select') {
        setSelected({ _img: true, name: e.data.name, src: e.data.src, width: e.data.width, height: e.data.height, selectorPath: e.data.selectorPath });
        setEditText('');
      }
      if (e.data.type === 'ept-video-select') {
        setSelected({ _video: true, name: e.data.name, src: e.data.src, poster: e.data.poster, selectorPath: e.data.selectorPath });
        setEditText('');
      }
      if (e.data.type === 'ept-pick-delete') {
        setPendingDelete({ selector: e.data.selector, label: e.data.label, preview: e.data.preview, ancestors: e.data.ancestors || [] });
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const sendToIframe = (msg) => {
    iframeRef.current?.contentWindow?.postMessage(msg, '*');
  };

  const handleTextChange = (val) => {
    setEditText(val);
    if (selected !== null) {
      sendToIframe({ type: 'ept-update', idx: selected.idx, html: val });
    }
  };

  const handleSave = async () => {
    if (selected === null) return;
    setSaving(true);
    try {
      await saveText(sessionId, selected.idx, editText);
      setSavedCount(c => c + 1);
      setSelected(s => ({ ...s, text: editText }));
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleDeselect = () => {
    setSelected(null);
    setEditText('');
    setSpacing(null);
    setShowPicker(false);
    setImgDeleteConfirm(false);
    setVideoDeleteConfirm(false);
    sendToIframe({ type: 'ept-deselect' });
  };

  const togglePickMode = (on) => {
    const next = on !== undefined ? on : !deletePickMode;
    setDeletePickMode(next);
    deletePickModeRef.current = next;
    setPendingDelete(null);
    if (!next) {
      // also clear normal selection when exiting pick mode
    }
    sendToIframe({ type: 'ept-pick-mode', active: next });
  };

  const handleDeleteBySelector = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteBySelector(sessionId, pendingDelete.selector);
      setCanUndo(true);
      setPendingDelete(null);
      togglePickMode(false);
      setSelected(null);
      setEditText('');
      setIframeKey(k => k + 1);
    } catch (err) {
      onError(err.response?.data?.error || 'Delete failed');
    } finally {
      setDeleting(false);
    }
  };

  const handleReload = useCallback(() => {
    setSelected(null);
    setEditText('');
    setSpacing(null);
    setDeletePickMode(false);
    deletePickModeRef.current = false;
    setPendingDelete(null);
    setImgDeleteConfirm(false);
    setVideoDeleteConfirm(false);
    setCanUndo(false);
    setIframeKey(k => k + 1);
  }, []);

  const handleUndo = async () => {
    try {
      await undoDelete(sessionId);
      setCanUndo(false);
      setPendingDelete(null);
      setSelected(null);
      setEditText('');
      setIframeKey(k => k + 1);
    } catch (err) {
      onError(err.response?.data?.error || 'Undo failed');
    }
  };

  // Listen for external reload requests (e.g. from standard-mode notification)
  useEffect(() => {
    let ch;
    try {
      ch = new BroadcastChannel('ept-content-reload-' + sessionId);
      ch.onmessage = () => handleReload();
    } catch {}
    return () => ch?.close();
  }, [sessionId, handleReload]);

  // Reload when parent signals an external reload (e.g. dev updated, user may be on another step)
  useEffect(() => {
    if (externalReloadKey > 0) handleReload();
  }, [externalReloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Track iframe wrapper size for desktop scaling
  useEffect(() => {
    const el = iframeWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setPreviewSize({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    ro.observe(el);
    setPreviewSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const handleIframeLoad = () => {
    // Re-activate pick mode if it was on before reload
    if (deletePickModeRef.current) {
      setTimeout(() => sendToIframe({ type: 'ept-pick-mode', active: true }), 120);
    }
    if (!pendingSelectRef.current) return;
    const { idx, tag, text } = pendingSelectRef.current;
    pendingSelectRef.current = null;
    // Small delay — let injected editor script finish initialising
    setTimeout(() => {
      sendToIframe({ type: 'ept-highlight', idx });
      if (text !== null) {
        setSelected({ idx, tag, text });
        setEditText(text);
      }
      // text === null means img-link: just scroll to it, user clicks img themselves
    }, 120);
  };

  const handleInsertAfter = async (item) => {
    if (!selected) return;
    setInserting(true);
    setShowPicker(false);
    try {
      const isMedia = selected._img || selected._video;
      const afterSelector = isMedia ? selected.selectorPath : undefined;
      const afterIdx = isMedia ? undefined : selected.idx;
      const templateIdx = item.isImg ? undefined : item.idx;
      const templateHtml = item.isImg ? item.outerHTML : undefined;
      const res = await insertAfter(sessionId, afterIdx, templateIdx, afterSelector, templateHtml);
      const { newIdx, tag, isImgLink } = res.data;
      if (!isMedia) {
        pendingSelectRef.current = isImgLink
          ? { idx: newIdx, tag, text: null }
          : { idx: newIdx, tag, text: `<${tag}>Новий текст</${tag}>` };
      }
      setSavedCount(c => c + 1);
      setSelected(null);
      setEditText('');
      setIframeKey(k => k + 1);
    } catch (err) {
      onError(err.response?.data?.error || 'Insert failed');
    } finally {
      setInserting(false);
    }
  };

  const openPicker = async (tab = 'elements') => {
    setPickerTab(tab);
    setShowPicker(true);
    setPreviewWidget(null);
    if (tab === 'widgets' && widgets === null) {
      try {
        const res = await getWidgets();
        setWidgets(res.data.widgets);
      } catch {
        setWidgets([]);
      }
    }
  };

  const handleInsertWidget = async (widgetId) => {
    if (!selected) return;
    setInserting(true);
    setShowPicker(false);
    try {
      const isMedia = selected._img || selected._video;
      const afterSelector = isMedia ? selected.selectorPath : undefined;
      const afterIdx = isMedia ? undefined : selected.idx;
      await insertWidget(sessionId, afterIdx, widgetId, afterSelector);
      setIframeKey(k => k + 1);
      setSelected(null);
      setEditText('');
    } catch (err) {
      onError(err.response?.data?.error || 'Widget insert failed');
    } finally {
      setInserting(false);
    }
  };

  const handleDelete = async () => {
    if (!selected || selected._img || selected._video) return;
    setDeleting(true);
    try {
      await deleteElement(sessionId, selected.idx);
      setCanUndo(true);
      setSelected(null);
      setEditText('');
      setConfirmDelete(false);
      setIframeKey(k => k + 1);
    } catch (err) {
      onError(err.response?.data?.error || 'Delete failed');
    } finally {
      setDeleting(false);
    }
  };

  const handleDeleteSelected = async () => {
    const sp = selected?.selectorPath;
    if (!sp) return;
    setDeleting(true);
    try {
      await deleteBySelector(sessionId, sp);
      setCanUndo(true);
      setSelected(null);
      setEditText('');
      setImgDeleteConfirm(false);
      setVideoDeleteConfirm(false);
      setIframeKey(k => k + 1);
    } catch (err) {
      onError(err.response?.data?.error || 'Delete failed');
    } finally {
      setDeleting(false);
    }
  };

  const handleImgReplace = async (e) => {
    const file = e.target.files[0];
    if (!file || !selected?._img) return;
    setImgReplacing(true);
    try {
      const imgRes = await replaceImage(sessionId, selected.name, file, selected.src, selected.selectorPath);
      setSavedCount(c => c + 1);
      if (imgRes.data.newSrc) {
        sendToIframe({ type: 'ept-img-update', selectorPath: selected.selectorPath, newSrc: imgRes.data.newSrc });
      } else {
        sendToIframe({ type: 'ept-img-update', name: selected.name });
      }
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to replace image');
    } finally {
      setImgReplacing(false);
      e.target.value = '';
    }
  };

  const toStyleVal = (n) => n > 0 ? `${n}px` : '';

  const handleSpacingChange = (type, side, val) => {
    const num = Math.max(0, parseInt(val, 10) || 0);
    const next = { ...spacing, [type]: { ...spacing[type], [side]: num } };
    setSpacing(next);
    sendToIframe({
      type: 'ept-update-spacing',
      idx: selected.idx,
      margin:  { top: `${next.margin.top}px`,  right: `${next.margin.right}px`,  bottom: `${next.margin.bottom}px`,  left: `${next.margin.left}px`  },
      padding: { top: `${next.padding.top}px`, right: `${next.padding.right}px`, bottom: `${next.padding.bottom}px`, left: `${next.padding.left}px` },
    });
  };

  const handleApplySpacing = async () => {
    if (!selected || !spacing) return;
    setSpacingSaving(true);
    try {
      await saveSpacing(
        sessionId, selected.idx,
        { top: toStyleVal(spacing.margin.top),   right: toStyleVal(spacing.margin.right),
          bottom: toStyleVal(spacing.margin.bottom), left: toStyleVal(spacing.margin.left) },
        { top: toStyleVal(spacing.padding.top),  right: toStyleVal(spacing.padding.right),
          bottom: toStyleVal(spacing.padding.bottom), left: toStyleVal(spacing.padding.left) },
      );
      setSavedCount(c => c + 1);
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to save spacing');
    } finally {
      setSpacingSaving(false);
    }
  };

  const handleFormat = async () => {
    if (!editText.trim()) return;
    setFormatting(true);
    try {
      const res = await formatSnippet(sessionId, editText);
      if (res.data.ok) {
        setEditText(res.data.html);
        sendToIframe({ type: 'ept-update', idx: selected?.idx, html: res.data.html });
      }
    } catch {
      // silently ignore — keep current text
    } finally {
      setFormatting(false);
    }
  };

  const handleVideoReplace = async (e) => {
    const file = e.target.files[0];
    if (!file || !selected?._video) return;
    setVideoReplacing(true);
    try {
      const poster = await generatePoster(file);
      await replaceVideo(sessionId, selected.src, file, poster);
      setSavedCount(c => c + 1);
      sendToIframe({ type: 'ept-video-update', name: selected.name });
      setSelected(s => ({ ...s, posterGenerated: true }));
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to replace video');
    } finally {
      setVideoReplacing(false);
      e.target.value = '';
    }
  };

  const drawerOpen = Boolean(pendingDelete || selected);

  const closeEditorDrawer = () => {
    if (pendingDelete) {
      setPendingDelete(null);
      return;
    }
    handleDeselect();
  };

  let drawerTitle = 'Edit';
  if (pendingDelete) drawerTitle = 'Delete block';
  else if (selected?._img) drawerTitle = 'Image';
  else if (selected?._video) drawerTitle = 'Video';
  else if (selected) drawerTitle = `Text · <${selected.tag}>`;

  return (
    <>
    <div className={`text-editor-layout text-editor-layout--dashboard${drawerOpen ? ' text-editor-layout--drawer-open' : ''}`}>
      <div className="text-editor-preview text-editor-preview--solo">
        <div className="text-editor-preview__bar">
          <div className="text-editor-preview__bar-main">
            {deletePickMode ? (
              <span className="text-editor-preview__hint" style={{ color: '#ef4444' }}>
                🗑 Click → block · Dbl-click → exact element · Hidden = orange outline
              </span>
            ) : (
              <span className="text-editor-preview__hint">Click text, image, or video in the preview</span>
            )}
            {!drawerOpen && !deletePickMode && (
              <span className="text-editor-preview__subhint">— editor slides in from the right when you select something</span>
            )}
            {!drawerOpen && deletePickMode && (
              <span className="text-editor-preview__subhint">— pick an element in the preview; the delete panel opens here</span>
            )}
          </div>
          <div className="text-editor-preview__bar-actions">
            {savedCount > 0 && (
              <span className="badge badge--green" style={{ marginRight: 4 }} title="Saves in this session">✓ {savedCount}</span>
            )}
            {canUndo && (
              <button className="btn btn--sm" onClick={handleUndo} title="Undo last delete">↩ Undo</button>
            )}
            <button
              className={`btn btn--sm${deletePickMode ? ' btn--danger' : ''}`}
              onClick={() => togglePickMode()}
            >{deletePickMode ? '✕ Cancel' : '🗑 Delete'}</button>
            <span style={{ width: 1, height: 18, background: 'var(--border)', display: 'inline-block', margin: '0 2px' }} />
            <button
              className={`btn btn--sm${previewMode === 'mobile' ? ' btn--primary' : ''}`}
              onClick={() => setPreviewMode(m => m === 'mobile' ? 'responsive' : 'mobile')}
            >📱 Mobile</button>
            <button
              className={`btn btn--sm${previewMode === 'desktop' ? ' btn--primary' : ''}`}
              onClick={() => setPreviewMode(m => m === 'desktop' ? 'responsive' : 'desktop')}
            >🖥 Desktop</button>
            <span style={{ width: 1, height: 18, background: 'var(--border)', display: 'inline-block', margin: '0 2px' }} />
            <button className="btn btn--sm" onClick={handleReload}>↺ Reload</button>
          </div>
        </div>
        <div ref={iframeWrapRef} style={{ flex: 1, position: 'relative', overflow: 'hidden', minHeight: 0 }}>
          <iframe
            key={iframeKey}
            ref={iframeRef}
            src={`/api/content/${sessionId}/preview-iframe?v=${iframeKey}`}
            className="text-editor-iframe"
            title="Offer Preview"
            sandbox="allow-scripts allow-same-origin"
            onLoad={handleIframeLoad}
            style={{
              ...(previewMode === 'desktop' && previewSize.w > 0 ? {
                position: 'absolute', top: 0, left: 0,
                width: `${DESKTOP_W}px`,
                height: `${Math.ceil(previewSize.h / (previewSize.w / DESKTOP_W))}px`,
                transformOrigin: 'top left',
                transform: `scale(${previewSize.w / DESKTOP_W})`,
                border: 'none',
              } : previewMode === 'mobile' ? {
                width: `${MOBILE_W}px`,
                height: '100%',
                margin: '0 auto',
                display: 'block',
                border: 'none',
                boxShadow: '0 0 0 1px var(--border)',
              } : { width: '100%', height: '100%' }),
              ...(deletePickMode ? { outline: '2px solid #ef4444', outlineOffset: '-2px' } : {}),
            }}
          />
        </div>
      </div>

      {drawerOpen && (
        <>
          <button type="button" className="text-editor-drawer-backdrop" aria-label="Close panel" onClick={closeEditorDrawer} />
          <aside className="text-editor-drawer" role="dialog" aria-modal="true" aria-labelledby="text-editor-drawer-title">
            <div className="text-editor-drawer__header">
              <h3 id="text-editor-drawer-title" className="text-editor-drawer__title">{drawerTitle}</h3>
              <button type="button" className="btn btn--sm" onClick={closeEditorDrawer} aria-label="Close">✕</button>
            </div>
            <div className="text-editor-drawer__body">
        {pendingDelete ? (
          <div className="text-editor-form">
            <div className="text-editor-tag">
              <span className="badge badge--red">Target</span>
              <code style={{ fontSize: 11, color: 'var(--text-muted)' }}>{pendingDelete.label}</code>
            </div>
            {pendingDelete.ancestors && pendingDelete.ancestors.length > 0 && (
              <div style={{ margin: '8px 0 4px' }}>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 5px' }}>Select parent to delete instead:</p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {pendingDelete.ancestors.map((a, i) => (
                    <button
                      key={i}
                      className="btn btn--sm"
                      style={{ fontSize: 11, padding: '2px 8px', opacity: pendingDelete.selector === a.selector ? 1 : 0.65 }}
                      onClick={() => {
                        setPendingDelete(pd => ({ ...pd, selector: a.selector, label: a.label, preview: a.preview || pd.preview }));
                        sendToIframe({ type: 'ept-pick-highlight', selector: a.selector });
                      }}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <pre style={{
              fontSize: 11, background: '#0d0f18', color: '#f87171', padding: '8px 10px',
              borderRadius: 6, overflowX: 'auto', maxHeight: 130, whiteSpace: 'pre-wrap',
              wordBreak: 'break-all', border: '1px solid rgba(239,68,68,0.25)', margin: '8px 0 12px',
            }}>{pendingDelete.preview}{pendingDelete.preview?.length >= 400 ? '…' : ''}</pre>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn--danger btn--lg" onClick={handleDeleteBySelector} disabled={deleting} style={{ flex: 1 }}>
                {deleting ? 'Deleting…' : '🗑 Delete'}
              </button>
              <button className="btn btn--lg" onClick={() => setPendingDelete(null)} style={{ flex: 1 }}>
                Cancel
              </button>
            </div>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
              Click another element in the preview to change selection.
            </p>
          </div>
        ) : selected._img ? (
          <div className="text-editor-form">
            <div className="text-editor-tag">
              <span className="badge" style={{ background: 'var(--warning)', color: '#fff' }}>img</span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={selected.name}>{selected.name}</span>
            </div>
            <div className="text-editor-img-preview">
              <img
                src={selected.src?.startsWith('http') ? selected.src : `/session-files/${sessionId}/${selected.src?.replace(/^\//, '')}`}
                alt={selected.name}
                style={{ maxWidth: '100%', maxHeight: 160, borderRadius: 6, objectFit: 'contain', background: '#1a1d27' }}
              />
              {selected.width > 0 && (
                <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>{selected.width} × {selected.height}px</span>
              )}
            </div>
            <input ref={imgReplaceRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleImgReplace} />
            <button className="btn btn--primary btn--lg" onClick={() => imgReplaceRef.current?.click()} disabled={imgReplacing}>
              {imgReplacing ? 'Replacing…' : '↑ Replace Image'}
            </button>
            <div className="text-editor-actions" style={{ marginTop: 8 }}>
              <button className="btn btn--sm btn--clone" onClick={() => openPicker('elements')} disabled={inserting} title="Insert a new element after this image">
                {inserting ? '…' : '⊕ Add element'}
              </button>
              <button className="btn btn--sm btn--clone" onClick={() => openPicker('widgets')} disabled={inserting} title="Insert a widget after this image">
                ⊞ Add widget
              </button>
              {!imgDeleteConfirm ? (
                <button className="btn btn--sm btn--danger" onClick={() => setImgDeleteConfirm(true)} title="Remove this image from the page">
                  ✕ Delete
                </button>
              ) : (
                <span className="text-editor-confirm-delete">
                  <span style={{ fontSize: 12, color: 'var(--danger)' }}>Sure?</span>
                  <button className="btn btn--sm btn--danger" onClick={handleDeleteSelected} disabled={deleting}>
                    {deleting ? '…' : 'Yes, delete'}
                  </button>
                  <button className="btn btn--sm" onClick={() => setImgDeleteConfirm(false)}>Cancel</button>
                </span>
              )}
            </div>
          </div>
        ) : selected._video ? (
          <div className="text-editor-form">
            <div className="text-editor-tag">
              <span className="badge" style={{ background: '#16a34a', color: '#fff' }}>video</span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={selected.name}>{selected.name}</span>
            </div>
            <div className="text-editor-img-preview" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 80, background: '#0d0f18', borderRadius: 6 }}>
              {selected.poster ? (
                <img
                  src={selected.poster?.startsWith('http') ? selected.poster : `/session-files/${sessionId}/${selected.poster?.replace(/^\//, '')}`}
                  alt="poster"
                  style={{ maxWidth: '100%', maxHeight: 140, objectFit: 'contain' }}
                />
              ) : (
                <span style={{ fontSize: 28 }}>🎬</span>
              )}
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '6px 0' }}>
              Upload a new video file. A WebP poster will be auto-generated from the first frame and <code>controls</code> will be added automatically.
            </p>
            {selected.posterGenerated && (
              <div className="badge badge--green" style={{ marginBottom: 6 }}>✓ Poster generated &amp; saved</div>
            )}
            <input ref={videoReplaceRef} type="file" accept="video/*" style={{ display: 'none' }} onChange={handleVideoReplace} />
            <button className="btn btn--primary btn--lg" onClick={() => videoReplaceRef.current?.click()} disabled={videoReplacing}>
              {videoReplacing ? 'Generating poster…' : '↑ Replace Video'}
            </button>
            <div className="text-editor-actions" style={{ marginTop: 8 }}>
              <button className="btn btn--sm btn--clone" onClick={() => openPicker('elements')} disabled={inserting} title="Insert a new element after this video">
                {inserting ? '…' : '⊕ Add element'}
              </button>
              <button className="btn btn--sm btn--clone" onClick={() => openPicker('widgets')} disabled={inserting} title="Insert a widget after this video">
                ⊞ Add widget
              </button>
              {!videoDeleteConfirm ? (
                <button className="btn btn--sm btn--danger" onClick={() => setVideoDeleteConfirm(true)} title="Remove this video from the page">
                  ✕ Delete
                </button>
              ) : (
                <span className="text-editor-confirm-delete">
                  <span style={{ fontSize: 12, color: 'var(--danger)' }}>Sure?</span>
                  <button className="btn btn--sm btn--danger" onClick={handleDeleteSelected} disabled={deleting}>
                    {deleting ? '…' : 'Yes, delete'}
                  </button>
                  <button className="btn btn--sm" onClick={() => setVideoDeleteConfirm(false)}>Cancel</button>
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="text-editor-form">
            <div className="text-editor-tag">
              <span className="badge badge--blue">&lt;{selected.tag}&gt;</span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>#{selected.idx}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Inner HTML — tags preserved</span>
              <button
                className="btn btn--sm"
                onClick={handleFormat}
                disabled={formatting || !editText.trim()}
                title="Format with Prettier"
              >
                {formatting ? '…' : '✦ Format'}
              </button>
            </div>
            <textarea
              className="text-editor-textarea"
              value={editText}
              onChange={e => handleTextChange(e.target.value)}
              rows={5}
              placeholder="Edit HTML here…"
              autoFocus
            />
            <button className="btn btn--primary btn--lg" onClick={handleSave} disabled={saving || editText === selected.text}>
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
            {editText !== selected.text && (
              <button className="btn btn--sm" onClick={() => { setEditText(selected.text); sendToIframe({ type: 'ept-update', idx: selected.idx, html: selected.text }); }}>
                Discard
              </button>
            )}

            {spacing && (
              <div className="spacing-panel">
                <div className="spacing-panel__title">Spacing</div>
                {[['margin', 'Margin'], ['padding', 'Padding']].map(([type, label]) => (
                  <div key={type} className="spacing-panel__row">
                    <span className="spacing-panel__label">{label}</span>
                    <div className="spacing-panel__inputs">
                      {['top', 'right', 'bottom', 'left'].map(side => (
                        <label key={side} className="spacing-panel__field">
                          <span>{side[0].toUpperCase()}</span>
                          <input
                            type="number"
                            min="0"
                            value={spacing[type][side]}
                            onChange={e => handleSpacingChange(type, side, e.target.value)}
                            className="spacing-panel__input"
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
                <button
                  className="btn btn--sm btn--primary"
                  style={{ marginTop: 8, width: '100%' }}
                  onClick={handleApplySpacing}
                  disabled={spacingSaving}
                >
                  {spacingSaving ? 'Saving…' : 'Apply Spacing'}
                </button>
              </div>
            )}

            <div className="text-editor-actions">
              <button
                className="btn btn--sm btn--clone"
                onClick={() => openPicker('elements')}
                disabled={inserting}
                title="Insert a new element after this one"
              >
                {inserting ? '…' : '⊕ Add element'}
              </button>
              <button
                className="btn btn--sm btn--clone"
                onClick={() => openPicker('widgets')}
                disabled={inserting}
                title="Insert a widget after this element"
              >
                ⊞ Add widget
              </button>
              {!confirmDelete ? (
                <button
                  className="btn btn--sm btn--danger"
                  onClick={() => setConfirmDelete(true)}
                  title="Delete this element from the page"
                >
                  ✕ Delete
                </button>
              ) : (
                <span className="text-editor-confirm-delete">
                  <span style={{ fontSize: 12, color: 'var(--danger)' }}>Sure?</span>
                  <button className="btn btn--sm btn--danger" onClick={handleDelete} disabled={deleting}>
                    {deleting ? '…' : 'Yes, delete'}
                  </button>
                  <button className="btn btn--sm" onClick={() => setConfirmDelete(false)}>Cancel</button>
                </span>
              )}
            </div>
          </div>
        )}
            </div>
          </aside>
        </>
      )}
    </div>

    {/* Element / Widget picker modal */}
    {showPicker && (
      <div className="picker-overlay" onClick={() => setShowPicker(false)}>
        <div className="picker-modal" onClick={e => e.stopPropagation()}>
          <div className="picker-modal__header">
            <span>Insert after <code>{selected?._img ? '<img>' : selected?._video ? '<video>' : `<${selected?.tag}>`}</code></span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <div className="picker-modal__tabs">
                <button className={`picker-modal__tab ${pickerTab === 'elements' ? 'active' : ''}`} onClick={() => setPickerTab('elements')}>Elements</button>
                <button className={`picker-modal__tab ${pickerTab === 'widgets' ? 'active' : ''}`} onClick={() => { setPickerTab('widgets'); if (widgets === null) getWidgets().then(r => setWidgets(r.data.widgets)).catch(() => setWidgets([])); }}>Widgets</button>
              </div>
              <button className="btn btn--sm" onClick={() => setShowPicker(false)}>✕</button>
            </div>
          </div>

          {pickerTab === 'elements' && (
            <div className="element-card-grid">
              {catalog.map((item) => (
                <ElementCard
                  key={item.idx ?? item.selectorPath}
                  item={item}
                  sessionId={sessionId}
                  cssLinks={cssLinks}
                  inlineStyles={inlineStyles}
                  onClick={() => handleInsertAfter(item)}
                />
              ))}
            </div>
          )}

          {pickerTab === 'widgets' && (
            widgets === null ? (
              <div className="loading-state" style={{ padding: 32 }}><div className="spinner" /> Loading widgets…</div>
            ) : widgets.length === 0 ? (
              <div className="empty-state" style={{ padding: 32 }}>No widgets found in <code>/widgets/</code> folder.</div>
            ) : (
              <div className="picker-widgets-layout">
                {/* Left: widget list */}
                <div className="picker-widgets-list">
                  {widgets.map(w => (
                    <button
                      key={w.id}
                      className={`picker-modal__widget-row ${previewWidget?.id === w.id ? 'picker-modal__widget-row--active' : ''}`}
                      onClick={() => { setPreviewWidget(w); setWidgetPreviewTab('preview'); }}
                    >
                      <div className="picker-modal__widget-name">{w.name}</div>
                      {w.description && <div className="picker-modal__widget-desc">{w.description}</div>}
                      <div className="picker-modal__widget-badges">
                        {w.files.html && <span className="badge">HTML</span>}
                        {w.files.js && <span className="badge">JS</span>}
                        {w.files.css && <span className="badge">CSS</span>}
                      </div>
                    </button>
                  ))}
                </div>

                {/* Right: preview panel */}
                <div className="picker-widgets-preview">
                  {!previewWidget ? (
                    <div className="picker-widgets-preview__empty">← Select a widget to preview</div>
                  ) : (
                    <>
                      <div className="picker-widgets-preview__header">
                        <div className="tab-bar">
                          <button className={`tab-bar__btn ${widgetPreviewTab === 'preview' ? 'active' : ''}`} onClick={() => setWidgetPreviewTab('preview')}>Preview</button>
                          {previewWidget.content.html && <button className={`tab-bar__btn ${widgetPreviewTab === 'html' ? 'active' : ''}`} onClick={() => setWidgetPreviewTab('html')}>HTML</button>}
                          {previewWidget.content.js && <button className={`tab-bar__btn ${widgetPreviewTab === 'js' ? 'active' : ''}`} onClick={() => setWidgetPreviewTab('js')}>JS</button>}
                          {previewWidget.content.css && <button className={`tab-bar__btn ${widgetPreviewTab === 'css' ? 'active' : ''}`} onClick={() => setWidgetPreviewTab('css')}>CSS</button>}
                        </div>
                        <button
                          className="btn btn--primary btn--sm"
                          onClick={() => handleInsertWidget(previewWidget.id)}
                          disabled={inserting}
                        >
                          {inserting ? '…' : '⊕ Insert here'}
                        </button>
                      </div>
                      {widgetPreviewTab === 'preview' ? (
                        <iframe
                          className="picker-widgets-preview__iframe"
                          title="Widget preview"
                          sandbox="allow-scripts"
                          srcDoc={`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;padding:16px;font-family:sans-serif;background:#fff;color:#111}${previewWidget.content.css || ''}</style></head><body>${previewWidget.content.html || '<em style="color:#999">No HTML content</em>'}<script>${previewWidget.content.js || ''}<\/script></body></html>`}
                        />
                      ) : (
                        <pre className="picker-widgets-preview__code">
                          {widgetPreviewTab === 'html' && previewWidget.content.html}
                          {widgetPreviewTab === 'js'   && previewWidget.content.js}
                          {widgetPreviewTab === 'css'  && previewWidget.content.css}
                        </pre>
                      )}
                    </>
                  )}
                </div>
              </div>
            )
          )}
        </div>
      </div>
    )}
    </>
  );
}

// ─── Paste-and-replace content rewrite (deterministic 1:1, no AI) ────────────

function XaiContentTab({ sessionId, onError }) {
  const [brief, setBrief] = useState('');
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [scopeLabel, setScopeLabel] = useState('');
  const [scopedCount, setScopedCount] = useState(0);
  const [scopeSelectorPath, setScopeSelectorPath] = useState('');
  const [scopeUsedCustom, setScopeUsedCustom] = useState(false);
  const [customScope, setCustomScope] = useState('');
  const [scopePreview, setScopePreview] = useState(null);
  const [scopeBusy, setScopeBusy] = useState(false);
  const [scopePickerOpen, setScopePickerOpen] = useState(false);
  const [rows, setRows] = useState([]);
  const [applied, setApplied] = useState(null);
  const [removed, setRemoved] = useState(0);
  const [photoMarkers, setPhotoMarkers] = useState([]);
  const [videoMarkers, setVideoMarkers] = useState([]);
  const [scopedImageCount, setScopedImageCount] = useState(0);
  const [scopedImagesPreview, setScopedImagesPreview] = useState([]);
  const [scopedVideoCount, setScopedVideoCount] = useState(0);
  const [scopedVideosPreview, setScopedVideosPreview] = useState([]);
  const [mediaModalOpen, setMediaModalOpen] = useState(false);
  const [photoFiles, setPhotoFiles] = useState([]);
  const [videoFiles, setVideoFiles] = useState([]);
  const [pendingReplacements, setPendingReplacements] = useState(null);
  const [progressMessage, setProgressMessage] = useState('');
  const [placeholderInfo, setPlaceholderInfo] = useState(null);
  const [blocksCount, setBlocksCount] = useState(0);
  const [slotsCloned, setSlotsCloned] = useState(0);
  const [slotExtensionPlan, setSlotExtensionPlan] = useState([]);
  const [photoMoves, setPhotoMoves] = useState([]);
  const [videoMoves, setVideoMoves] = useState([]);
  const [mediaTrim, setMediaTrim] = useState(null);
  const [deletedCount, setDeletedCount] = useState(0);
  const [tagSwapsCount, setTagSwapsCount] = useState(0);
  const [aiUsage, setAiUsage] = useState(null);
  const [aiModel, setAiModel] = useState('');

  const clearProgress = () => setProgressMessage('');

  const handleSuggest = async () => {
    const b = brief.trim();
    if (!b) {
      onError('Paste the new article (or additions) into the box above.');
      return;
    }
    setLoading(true);
    setApplied(null);
    setRemoved(0);
    setRows([]);
    setPhotoMarkers([]);
    setVideoMarkers([]);
    setScopedImageCount(0);
    setScopedImagesPreview([]);
    setScopedVideoCount(0);
    setScopedVideosPreview([]);
    setPhotoFiles([]);
    setVideoFiles([]);
    setMediaModalOpen(false);
    setPendingReplacements(null);
    setPlaceholderInfo(null);
    setBlocksCount(0);
    setSlotsCloned(0);
    setSlotExtensionPlan([]);
    setPhotoMoves([]);
    setVideoMoves([]);
    setMediaTrim(null);
    setDeletedCount(0);
    setProgressMessage('Sending to Grok → it places paragraphs, photos and tags…');
    try {
      const res = await xaiSuggest(sessionId, {
        brief: b,
        scopeSelector: customScope.trim() || undefined,
      });
      setScopeLabel(res.data.scopeLabel || '');
      setScopeSelectorPath(res.data.scopeSelectorPath || '');
      setScopeUsedCustom(!!res.data.scopeUsedCustom);
      setScopedCount(res.data.scopedBlockCount ?? 0);
      const pr = res.data.previewRows || [];
      // Strict-pour: every row is either filled with a brief paragraph OR
      // marked for deletion (text===''). Both are checked by default — the
      // operator's brief is the only source of truth in the picked zone.
      setRows(pr.map((r) => ({ ...r, checked: true })));
      const pm = res.data.photoMarkers || [];
      const vm = res.data.videoMarkers || [];
      setPhotoMarkers(pm);
      setVideoMarkers(vm);
      setScopedImageCount(res.data.scopedImageCount ?? 0);
      setScopedImagesPreview(res.data.scopedImagesPreview || []);
      setScopedVideoCount(res.data.scopedVideoCount ?? 0);
      setScopedVideosPreview(res.data.scopedVideosPreview || []);
      setPlaceholderInfo(res.data.placeholderInfo || null);
      setBlocksCount(res.data.blocksCount || 0);
      setSlotsCloned(res.data.slotsCloned || 0);
      setSlotExtensionPlan(res.data.slotExtensionPlan || []);
      setPhotoMoves(res.data.photoMoves || []);
      setVideoMoves(res.data.videoMoves || []);
      setMediaTrim(res.data.mediaTrim || null);
      setDeletedCount(res.data.deletedCount || 0);
      setTagSwapsCount(res.data.tagSwaps || 0);
      setAiUsage(res.data.aiUsage || null);
      setAiModel(res.data.aiModel || '');
      const sortedPm = [...pm].sort((a, b) => a.num - b.num);
      const sortedVm = [...vm].sort((a, b) => a.num - b.num);
      setPhotoFiles(sortedPm.length ? Array(sortedPm.length).fill(null) : []);
      setVideoFiles(sortedVm.length ? Array(sortedVm.length).fill(null) : []);
    } catch (err) {
      onError(err.response?.data?.error || err.response?.data?.detail || err.message || 'Rewrite failed');
    } finally {
      setLoading(false);
      clearProgress();
    }
  };

  const applyTextOnly = async (replacements) => {
    const insertions = placeholderInfo && placeholderInfo.needsFormParagraph
      ? {
          needsFormParagraph: true,
          formText: placeholderInfo.formText,
        }
      : undefined;
    const res = await xaiApply(
      sessionId,
      replacements,
      null,
      customScope.trim() || undefined,
      insertions,
      slotExtensionPlan && slotExtensionPlan.length ? slotExtensionPlan : undefined,
      mediaTrim || undefined,
    );
    setApplied(res.data.applied);
    setRemoved(res.data.removed || 0);
  };

  const handleDetectScope = async () => {
    setScopeBusy(true);
    setScopePreview(null);
    try {
      const res = await detectScope(sessionId, customScope.trim() || undefined);
      setScopePreview(res.data);
    } catch (err) {
      onError(err.response?.data?.error || err.message || 'Scope detect failed');
    } finally {
      setScopeBusy(false);
    }
  };

  const handleResetScope = () => {
    setCustomScope('');
    setScopePreview(null);
  };

  const handleApply = async () => {
    const replacements = rows.filter((r) => r.checked).map((r) => ({
      idx: r.idx,
      text: r.newText,
      ...(r.slot ? { slot: r.slot } : {}),
      ...(r.replaceTag ? { replaceTag: r.replaceTag } : {}),
    }));
    if (!replacements.length) {
      onError('Select at least one replacement to apply.');
      return;
    }
    const sortedPm = [...photoMarkers].sort((a, b) => a.num - b.num);
    const sortedVm = [...videoMarkers].sort((a, b) => a.num - b.num);
    // No hard cap on ФОТО N / VIDEO N versus existing media count — when the
    // brief asks for more than the scope contains, the server clones the last
    // <img> / <video> in scope as many times as needed (see extendMediaInScope).
    // We only need the scope to have AT LEAST ONE element to clone from.
    if (sortedPm.length > 0 && scopedImageCount === 0) {
      onError('Brief contains ФОТО markers but no <img> exists in the picked zone — pick a zone that contains at least one image.');
      return;
    }
    if (sortedVm.length > 0 && scopedVideoCount === 0) {
      onError('Brief contains VIDEO markers but no <video> exists in the picked zone — pick a zone that contains at least one video.');
      return;
    }
    if (sortedPm.length > 0 || sortedVm.length > 0) {
      setPendingReplacements(replacements);
      setMediaModalOpen(true);
      return;
    }
    setProgressMessage('Writing text to page (index)…');
    setApplying(true);
    try {
      await applyTextOnly(replacements);
    } catch (err) {
      onError(err.response?.data?.error || 'xAI apply failed');
    } finally {
      setApplying(false);
      clearProgress();
    }
  };

  const confirmMediaModal = async () => {
    const sortedPm = [...photoMarkers].sort((a, b) => a.num - b.num);
    const sortedVm = [...videoMarkers].sort((a, b) => a.num - b.num);
    if (sortedPm.length > 0) {
      const missingPhoto = sortedPm
        .map((m, i) => (photoFiles[i] ? null : m.num))
        .filter((n) => n != null);
      if (photoFiles.length < sortedPm.length || missingPhoto.length) {
        onError(`Photos: pick a file for ФОТО ${missingPhoto.join(', ФОТО ')}.`);
        return;
      }
    }
    if (sortedVm.length > 0) {
      const missingVideo = sortedVm
        .map((m, i) => (videoFiles[i] ? null : m.num))
        .filter((n) => n != null);
      if (videoFiles.length < sortedVm.length || missingVideo.length) {
        onError(`Videos: pick a file for VIDEO ${missingVideo.join(', VIDEO ')}.`);
        return;
      }
    }
    setApplying(true);
    const scopeArg = customScope.trim() || undefined;
    try {
      // Apply text FIRST — it clones any extra slots, deletes leftover ones,
      // and trims media counts. Photos / videos are then placed onto the
      // post-trim DOM with stable nth-child selector paths from photoMoves /
      // videoMoves (computed against the same in-memory clone state).
      setProgressMessage('Writing text to page…');
      await applyTextOnly(pendingReplacements || rows.filter((r) => r.checked).map((r) => ({
        idx: r.idx,
        text: r.newText,
        ...(r.replaceTag ? { replaceTag: r.replaceTag } : {}),
      })));
      if (sortedPm.length > 0) {
        setProgressMessage('Photos → WebP, updating <img>, ordering by brief…');
        await applyPhotoMarkers(sessionId, sortedPm.map((m) => m.num), photoFiles, scopeArg, photoMoves);
      }
      if (sortedVm.length > 0) {
        setProgressMessage('Videos → file replace, ordering by brief…');
        await applyVideoMarkers(sessionId, sortedVm.map((m) => m.num), videoFiles, scopeArg, videoMoves);
      }
      setMediaModalOpen(false);
      setPendingReplacements(null);
    } catch (err) {
      onError(err.response?.data?.error || err.message || 'Media / text apply failed');
    } finally {
      setApplying(false);
      clearProgress();
    }
  };

  const skipMediaOnlyText = async () => {
    const replacements = pendingReplacements
      || rows.filter((r) => r.checked).map((r) => ({
        idx: r.idx,
        text: r.newText,
        ...(r.replaceTag ? { replaceTag: r.replaceTag } : {}),
      }));
    setProgressMessage('Writing text (media skipped)…');
    setApplying(true);
    setMediaModalOpen(false);
    setPendingReplacements(null);
    try {
      await applyTextOnly(replacements);
    } catch (err) {
      onError(err.response?.data?.error || 'xAI apply failed');
    } finally {
      setApplying(false);
      clearProgress();
    }
  };

  const sortedPhotoMarkers = [...photoMarkers].sort((a, b) => a.num - b.num);
  const sortedVideoMarkers = [...videoMarkers].sort((a, b) => a.num - b.num);
  const showProgressOverlay = (loading || applying) && Boolean(progressMessage);

  return (
    <div className="xai-panel">
      <div className="xai-panel__form">
        <div className="xai-panel__title-row">
          <h3 className="xai-panel__title">Paste &amp; place (Grok)</h3>
          <span className="panel__desc" style={{ fontSize: 12 }}>
            Paste your article — Grok places it into the picked zone: paragraphs, headings, dialogue, ФОТО N positions, tag swaps and overflow are decided by the model in one call. Your wording is preserved verbatim.
          </span>
        </div>
        <textarea
          className="code-editor xai-panel__brief"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder={`Встав текст статті. Абзаци розділяй порожнім рядком. Grok сам розкладе по слотах — текст НЕ переписується, лише розподіляється; теги <h2>/<button>, що отримали діалог, він поміняє на <p>; зайве — видалить, недостатньо — клонує.\n\nФОТО 1, ФОТО 2 … окремим рядком — де стоять у тексті, туди й сядуть фото після Apply.`}
        />
        <div className="xai-scope-pick">
          <div className="xai-scope-pick__header">
            <label className="xai-panel__label" style={{ margin: 0 }}>Edit zone (CSS selector)</label>
            <span className="xai-scope-pick__hint">Pick the article zone on the live preview, or type a CSS selector. Leaving empty falls back to &lt;body&gt;.</span>
          </div>
          <div className="xai-scope-pick__row">
            <input
              className="xai-panel__input"
              value={customScope}
              onChange={(e) => { setCustomScope(e.target.value); setScopePreview(null); }}
              placeholder="e.g. main, article, .story-content, #post-123"
            />
            <button type="button" className="btn btn--sm" onClick={() => setScopePickerOpen(true)}>
              Pick on preview
            </button>
            <button type="button" className="btn btn--sm" disabled={scopeBusy} onClick={handleDetectScope}>
              {scopeBusy ? 'Checking…' : 'Check zone'}
            </button>
            {customScope ? (
              <button type="button" className="btn btn--sm" disabled={scopeBusy} onClick={handleResetScope}>
                Reset
              </button>
            ) : null}
          </div>
          {scopePreview ? (
            <div className={`xai-scope-pick__preview ${scopePreview.editableCount ? '' : 'xai-scope-pick__preview--warn'}`}>
              <div>
                <strong>{scopePreview.scopeUsedCustom ? 'Custom' : 'Auto'}:</strong> <code>{scopePreview.scopeLabel}</code>
                <span className="xai-scope-pick__counts">
                  {' '}— {scopePreview.editableCount} text block(s) · {scopePreview.imageCount} img · {scopePreview.videoCount} video
                </span>
              </div>
              {scopePreview.sampleTexts?.length ? (
                <ul className="xai-scope-pick__samples">
                  {scopePreview.sampleTexts.map((s, i) => (
                    <li key={i}>
                      <span className="badge badge--blue">&lt;{s.tag}&gt;</span> {s.text}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="xai-scope-pick__warn">No editable blocks found in this zone.</p>
              )}
            </div>
          ) : null}
        </div>
        <div className="xai-panel__row xai-panel__row--wrap">
          <button type="button" className="btn btn--primary btn--lg" disabled={loading} onClick={handleSuggest}>
            {loading ? 'Mapping…' : 'Generate preview'}
          </button>
        </div>
      </div>

      {scopeLabel && rows.length > 0 && (
        <div className="xai-usage-card">
          <p className="xai-scope-hint" style={{ margin: 0 }}>
            Zone: <strong>{scopeLabel}</strong>{scopeUsedCustom ? ' (custom)' : ' (auto)'}
            {' · '}{blocksCount} paragraph(s) → {scopedCount} slot(s)
            {slotsCloned > 0 ? <> · <span style={{ color: '#22c55e' }}>+{slotsCloned} new slot(s) cloned</span></> : null}
            {deletedCount > 0 ? <> · <span style={{ color: '#f87171' }}>−{deletedCount} leftover slot(s) deleted</span></> : null}
            {tagSwapsCount > 0 ? <> · <span style={{ color: '#fcd34d' }}>{tagSwapsCount} tag swap(s)</span></> : null}
            {scopeSelectorPath ? <> · path <code>{scopeSelectorPath.split('>').slice(-3).join('>')}</code></> : null}
          </p>
          {aiUsage && (
            <p className="xai-scope-hint" style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--text-muted)' }}>
              <span className="badge" style={{ background: '#1e3a8a', color: '#bfdbfe' }}>Grok</span>
              {' '}{aiModel || aiUsage.model || 'grok'}
              {' · '}prompt {aiUsage.prompt_tokens ?? 0} + completion {aiUsage.completion_tokens ?? 0} = <strong>{aiUsage.total_tokens ?? 0}</strong> tok
              {typeof aiUsage.cost_usd === 'number' ? <> · <strong>${aiUsage.cost_usd.toFixed(5)}</strong></> : null}
            </p>
          )}
        </div>
      )}

      {rows.length > 0 && (
        <div className="xai-preview">
          <div className="xai-preview__toolbar">
            <span className="xai-preview__count">{rows.filter((r) => r.checked).length} / {rows.length} selected</span>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => setRows((rs) => rs.map((r) => ({ ...r, checked: true })))}
            >
              Select all
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => setRows((rs) => rs.map((r) => ({ ...r, checked: false })))}
            >
              Clear selection
            </button>
            <button type="button" className="btn btn--primary btn--lg" disabled={applying} onClick={handleApply}>
              {applying ? 'Applying…' : 'Apply to page'}
            </button>
          </div>
          {applied != null && (
            <p className="xai-preview__done">
              Applied <strong>{applied}</strong> block(s)
              {removed > 0 && <> · removed <strong>{removed}</strong> stale slot(s)</>}
              . Reload Live Text preview to see changes.
            </p>
          )}
          {slotsCloned > 0 && (
            <ul className="xai-preview__notes">
              <li>
                <span className="badge" style={{ background: '#064e3b', color: '#a7f3d0' }}>+{slotsCloned}</span>
                Pasted text was longer than the zone — {slotsCloned} extra slot{slotsCloned === 1 ? '' : 's'} cloned at the end (marked <em>NEW</em>) so every paragraph fits.
              </li>
            </ul>
          )}
          {deletedCount > 0 && (
            <ul className="xai-preview__notes">
              <li>
                <span className="badge" style={{ background: '#7f1d1d', color: '#fecaca' }}>−{deletedCount}</span>
                {deletedCount} leftover slot{deletedCount === 1 ? '' : 's'} (heading / button / link / paragraph) {deletedCount === 1 ? 'will be removed' : 'will be removed'} because your pasted text didn't reach {deletedCount === 1 ? 'it' : 'them'}. Untick a row to keep it.
              </li>
            </ul>
          )}
          {mediaTrim && (mediaTrim.photoCount < scopedImageCount || mediaTrim.videoCount < scopedVideoCount) && (
            <ul className="xai-preview__notes">
              <li>
                <span className="badge" style={{ background: '#7f1d1d', color: '#fecaca' }}>media</span>
                Brief carries {mediaTrim.photoCount} ФОТО / {mediaTrim.videoCount} VIDEO marker(s); the zone has {scopedImageCount} image(s) / {scopedVideoCount} video(s). Extras{' '}
                {Math.max(0, scopedImageCount - mediaTrim.photoCount) + Math.max(0, scopedVideoCount - mediaTrim.videoCount)}
                {' '}will be removed on Apply.
              </li>
            </ul>
          )}
          {(photoMoves.length > 0 || videoMoves.length > 0) && (
            <ul className="xai-preview__notes">
              <li>
                <span className="badge" style={{ background: '#1e3a8a', color: '#bfdbfe' }}>order</span>
                Photos / videos will be re-ordered in the DOM to match the position of ФОТО N / VIDEO N in your brief.
              </li>
            </ul>
          )}
          {placeholderInfo && placeholderInfo.formInBrief && (
            <ul className="xai-preview__notes">
              {placeholderInfo.hasForm ? (
                <li>
                  <span className="badge badge--green">form</span> ФОРМА РЕГИСТРАЦИИ → page already has a form/lead-capture in scope — kept as-is, marker line skipped.
                </li>
              ) : (
                <li>
                  <span className="badge badge--blue">form</span> ФОРМА РЕГИСТРАЦИИ → no form found in scope, will be appended as <code>&lt;p&gt;{placeholderInfo.formText}&lt;/p&gt;</code> at the end.
                </li>
              )}
            </ul>
          )}
          <div className="xai-preview__table">
            {rows.map((m, i) => (
              <div key={i} className="xai-preview__row">
                <label className="xai-preview__check">
                  <input
                    type="checkbox"
                    checked={m.checked}
                    onChange={(e) => {
                      const on = e.target.checked;
                      setRows((rs) => rs.map((x, j) => (j === i ? { ...x, checked: on } : x)));
                    }}
                  />
                </label>
                <span className="badge badge--blue">&lt;{m.tag}&gt;</span>
                {m.cloned && <span className="badge badge--green">NEW</span>}
                {m.deleting && <span className="badge" style={{ background: '#7f1d1d', color: '#fecaca' }}>DELETE</span>}
                {m.kept && <span className="badge" style={{ background: '#1e3a8a', color: '#bfdbfe' }}>KEEP</span>}
                <code className="xai-preview__idx">#{m.idx}</code>
                <div className="xai-preview__old">{m.cloned ? <em style={{ color: 'var(--text-muted)' }}>(cloned slot)</em> : (m.oldText || <em style={{ color: 'var(--text-muted)' }}>(empty)</em>)}</div>
                <span className="xai-preview__arrow">→</span>
                <div className="xai-preview__new">
                  {m.deleting ? (
                    <em style={{ color: '#fca5a5' }}>(slot removed from page)</em>
                  ) : m.kept ? (
                    <em style={{ color: 'var(--text-muted)' }}>(kept — original text untouched)</em>
                  ) : (
                    m.newText
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {mediaModalOpen && (
        <div
          className="picker-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="media-marker-modal-title"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !applying) setMediaModalOpen(false);
          }}
        >
          <div className="photo-marker-modal photo-marker-modal--wide" onMouseDown={(e) => e.stopPropagation()}>
            <div className="photo-marker-modal__header">
              <h2 id="media-marker-modal-title" className="photo-marker-modal__title">Photos &amp; videos — upload</h2>
              <button type="button" className="btn btn--sm" disabled={applying} onClick={() => setMediaModalOpen(false)}>
                Close
              </button>
            </div>
            <p className="photo-marker-modal__hint">
              On confirm: images → WebP in <code>img/</code>, videos → file in <code>video/</code>; then text replacements apply. ФОТО N / VIDEO N = N-th element in scope.
            </p>
            {sortedPhotoMarkers.length > 0 && (() => {
              const photosPicked = photoFiles.filter(Boolean).length;
              const photosTotal = sortedPhotoMarkers.length;
              const photosComplete = photosPicked === photosTotal;
              return (
                <>
                  <h3 className="photo-marker-modal__section-title">
                    Photos ({sortedPhotoMarkers.length} slot{sortedPhotoMarkers.length === 1 ? '' : 's'} → {scopedImageCount} img in scope)
                    <span
                      className="photo-marker-modal__counter"
                      style={{
                        marginLeft: 12,
                        padding: '2px 10px',
                        borderRadius: 999,
                        fontSize: 12,
                        fontWeight: 600,
                        background: photosComplete ? '#064e3b' : '#7f1d1d',
                        color: photosComplete ? '#a7f3d0' : '#fecaca',
                      }}
                    >
                      {photosPicked} / {photosTotal} picked
                    </span>
                  </h3>
                  {scopedImagesPreview.length > 0 && (
                    <div className="photo-marker-modal__preview-strip">
                      {scopedImagesPreview.slice(0, 12).map((im) => (
                        <div key={im.index} className="photo-marker-modal__thumb-wrap" title={im.name || im.src}>
                          <span className="photo-marker-modal__thumb-idx">{im.index + 1}</span>
                          <img className="photo-marker-modal__thumb" src={im.url} alt="" />
                        </div>
                      ))}
                      {scopedImageCount > 12 ? (
                        <span className="photo-marker-modal__more">+{scopedImageCount - 12} more</span>
                      ) : null}
                    </div>
                  )}
                  {/* Bulk pick: pick all photos at once. Files go into slots
                      in selection order — file 1 → ФОТО 1, file 2 → ФОТО 2.
                      Any extras beyond slot count are dropped silently. */}
                  <label
                    className="photo-marker-modal__bulk"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '12px 14px',
                      margin: '8px 0 12px',
                      borderRadius: 8,
                      border: '1px dashed var(--border-color, #475569)',
                      background: 'var(--surface-2, rgba(148,163,184,0.08))',
                      cursor: applying ? 'not-allowed' : 'pointer',
                      opacity: applying ? 0.6 : 1,
                    }}
                  >
                    <strong style={{ flex: '0 0 auto' }}>Pick all {photosTotal} at once →</strong>
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      disabled={applying}
                      onChange={(e) => {
                        const picked = Array.from(e.target.files || []);
                        if (!picked.length) return;
                        setPhotoFiles((prev) => {
                          const next = [...prev];
                          for (let k = 0; k < photosTotal && k < picked.length; k++) {
                            next[k] = picked[k];
                          }
                          return next;
                        });
                        // Reset input so picking the same files again still
                        // fires onChange (browsers skip onChange when value is
                        // unchanged, which traps people who try to "redo" the pick).
                        e.target.value = '';
                      }}
                      style={{ flex: 1 }}
                    />
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      maps file 1 → ФОТО 1, file 2 → ФОТО 2…
                    </span>
                  </label>
                  <ul className="photo-marker-modal__slots">
                    {sortedPhotoMarkers.map((m, i) => {
                      const file = photoFiles[i];
                      return (
                        <li
                          key={m.num}
                          className="photo-marker-modal__slot"
                          style={!file ? { borderLeft: '3px solid #ef4444', paddingLeft: 8 } : undefined}
                        >
                          <label className="photo-marker-modal__slot-label">
                            <span className="photo-marker-modal__slot-name">{m.label || `ФОТО ${m.num}`}</span>
                            <input
                              type="file"
                              accept="image/*"
                              disabled={applying}
                              onChange={(e) => {
                                const f = e.target.files?.[0] || null;
                                // Cancelled picker (no file) MUST NOT clear an
                                // already-chosen file — otherwise the slot looks
                                // valid in the modal but the upload silently
                                // arrives with one fewer file and the server
                                // rejects the whole batch with "Expected N got M".
                                if (!f) return;
                                setPhotoFiles((prev) => {
                                  const next = [...prev];
                                  next[i] = f;
                                  return next;
                                });
                                e.target.value = '';
                              }}
                            />
                          </label>
                          {file ? (
                            <span className="photo-marker-modal__file-name">{file.name}</span>
                          ) : (
                            <span
                              className="photo-marker-modal__file-name photo-marker-modal__file-name--empty"
                              style={{ color: '#fca5a5', fontWeight: 600 }}
                            >
                              ⚠ MISSING
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </>
              );
            })()}
            {sortedVideoMarkers.length > 0 && (() => {
              const videosPicked = videoFiles.filter(Boolean).length;
              const videosTotal = sortedVideoMarkers.length;
              const videosComplete = videosPicked === videosTotal;
              return (
                <>
                  <h3 className="photo-marker-modal__section-title">
                    Videos ({sortedVideoMarkers.length} slot{sortedVideoMarkers.length === 1 ? '' : 's'} → {scopedVideoCount} &lt;video&gt; in scope)
                    <span
                      style={{
                        marginLeft: 12,
                        padding: '2px 10px',
                        borderRadius: 999,
                        fontSize: 12,
                        fontWeight: 600,
                        background: videosComplete ? '#064e3b' : '#7f1d1d',
                        color: videosComplete ? '#a7f3d0' : '#fecaca',
                      }}
                    >
                      {videosPicked} / {videosTotal} picked
                    </span>
                  </h3>
                  {scopedVideosPreview.length > 0 && (
                    <div className="photo-marker-modal__preview-strip">
                      {scopedVideosPreview.slice(0, 8).map((v) => (
                        <div key={v.index} className="photo-marker-modal__thumb-wrap photo-marker-modal__thumb-wrap--video" title={v.srcLabel}>
                          <span className="photo-marker-modal__thumb-idx">{v.index + 1}</span>
                          {v.posterUrl ? (
                            <img className="photo-marker-modal__thumb" src={v.posterUrl} alt="" />
                          ) : (
                            <span className="photo-marker-modal__video-fallback">▶</span>
                          )}
                        </div>
                      ))}
                      {scopedVideoCount > 8 ? (
                        <span className="photo-marker-modal__more">+{scopedVideoCount - 8}</span>
                      ) : null}
                    </div>
                  )}
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '12px 14px',
                      margin: '8px 0 12px',
                      borderRadius: 8,
                      border: '1px dashed var(--border-color, #475569)',
                      background: 'var(--surface-2, rgba(148,163,184,0.08))',
                      cursor: applying ? 'not-allowed' : 'pointer',
                      opacity: applying ? 0.6 : 1,
                    }}
                  >
                    <strong style={{ flex: '0 0 auto' }}>Pick all {videosTotal} at once →</strong>
                    <input
                      type="file"
                      accept="video/*,.mp4,.webm,.mov"
                      multiple
                      disabled={applying}
                      onChange={(e) => {
                        const picked = Array.from(e.target.files || []);
                        if (!picked.length) return;
                        setVideoFiles((prev) => {
                          const next = [...prev];
                          for (let k = 0; k < videosTotal && k < picked.length; k++) {
                            next[k] = picked[k];
                          }
                          return next;
                        });
                        e.target.value = '';
                      }}
                      style={{ flex: 1 }}
                    />
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      maps file 1 → VIDEO 1…
                    </span>
                  </label>
                  <ul className="photo-marker-modal__slots">
                    {sortedVideoMarkers.map((m, i) => {
                      const file = videoFiles[i];
                      return (
                        <li
                          key={`v-${m.num}`}
                          className="photo-marker-modal__slot"
                          style={!file ? { borderLeft: '3px solid #ef4444', paddingLeft: 8 } : undefined}
                        >
                          <label className="photo-marker-modal__slot-label">
                            <span className="photo-marker-modal__slot-name">{m.label || `VIDEO ${m.num}`}</span>
                            <input
                              type="file"
                              accept="video/*,.mp4,.webm,.mov"
                              disabled={applying}
                              onChange={(e) => {
                                const f = e.target.files?.[0] || null;
                                if (!f) return;
                                setVideoFiles((prev) => {
                                  const next = [...prev];
                                  next[i] = f;
                                  return next;
                                });
                                e.target.value = '';
                              }}
                            />
                          </label>
                          {file ? (
                            <span className="photo-marker-modal__file-name">{file.name}</span>
                          ) : (
                            <span
                              className="photo-marker-modal__file-name photo-marker-modal__file-name--empty"
                              style={{ color: '#fca5a5', fontWeight: 600 }}
                            >
                              ⚠ MISSING
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </>
              );
            })()}
            <div className="photo-marker-modal__actions">
              <button type="button" className="btn btn--sm" disabled={applying} onClick={skipMediaOnlyText}>
                Skip media — text only
              </button>
              <button type="button" className="btn btn--primary" disabled={applying} onClick={confirmMediaModal}>
                {applying ? 'Saving…' : 'Apply media + text'}
              </button>
            </div>
          </div>
        </div>
      )}

      {scopePickerOpen && (
        <ScopePickerModal
          sessionId={sessionId}
          onClose={() => setScopePickerOpen(false)}
          onSelect={(sel) => {
            setCustomScope(sel);
            setScopePreview(null);
            setScopePickerOpen(false);
          }}
        />
      )}

      {showProgressOverlay && (
        <div className="xai-progress-overlay" role="status" aria-live="polite" aria-busy="true">
          <div className="xai-progress-card">
            <span className="spinner" aria-hidden="true" />
            <p className="xai-progress-card__title">{loading ? 'Mapping paragraphs' : 'Applying'}</p>
            <p className="xai-progress-card__step">{progressMessage}</p>
            <div className="xai-progress-bar" aria-hidden="true">
              <span className="xai-progress-bar__strip" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Scope picker modal: live preview iframe + click-to-select ────────────────
function ScopePickerModal({ sessionId, onClose, onSelect }) {
  const iframeRef = useRef(null);
  const [picked, setPicked] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const handler = (e) => {
      const data = e.data;
      if (!data || typeof data !== 'object') return;
      if (data.type !== 'ept-scope-pick') return;
      setPicked({
        selector: data.selector,
        label: data.label,
        ancestors: Array.isArray(data.ancestors) ? data.ancestors : [],
      });
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const sendToFrame = (msg) => {
    iframeRef.current?.contentWindow?.postMessage(msg, '*');
  };

  const enablePick = () => sendToFrame({ type: 'ept-pick-mode', active: true, purpose: 'scope' });
  const highlightInFrame = (sel) => sendToFrame({ type: 'ept-pick-highlight', selector: sel });

  const handleIframeLoad = () => {
    setReady(true);
    setTimeout(enablePick, 150);
  };

  const pickAncestor = (a, i) => {
    setPicked((prev) => ({ selector: a.selector, label: a.label, ancestors: prev?.ancestors?.slice(i + 1) || [] }));
    highlightInFrame(a.selector);
  };

  return (
    <div
      className="picker-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Pick edit zone on preview"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="scope-picker-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="scope-picker-modal__header">
          <h2 className="scope-picker-modal__title">Pick edit zone</h2>
          <span className="scope-picker-modal__hint">
            Single-click — nearest semantic / class block · Double-click — exact element under the cursor.
          </span>
          <button type="button" className="btn btn--sm" onClick={onClose}>Close</button>
        </div>
        <div className="scope-picker-modal__body">
          <div className="scope-picker-modal__frame">
            <iframe
              ref={iframeRef}
              src={`/api/content/${sessionId}/preview-iframe`}
              className="scope-picker-modal__iframe"
              title="Pick zone"
              onLoad={handleIframeLoad}
            />
            {!ready ? (
              <div className="scope-picker-modal__loading"><span className="spinner" /> Loading preview…</div>
            ) : null}
          </div>
          {picked ? (
            <div className="scope-picker-modal__bar">
              <div className="scope-picker-modal__bar-info">
                <span className="badge badge--blue">picked</span>
                <code className="scope-picker-modal__sel">{picked.label}</code>
                {picked.ancestors?.length ? (
                  <div className="scope-picker-modal__ancestors-row">
                    <span className="scope-picker-modal__ancestors-label">parents:</span>
                    {picked.ancestors.slice(0, 6).map((a, i) => (
                      <button
                        key={i}
                        type="button"
                        className="btn btn--sm scope-picker-modal__ancestor-btn"
                        onClick={() => pickAncestor(a, i)}
                        title={a.selector}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="scope-picker-modal__bar-actions">
                <button type="button" className="btn btn--sm" onClick={enablePick}>Pick again</button>
                <button type="button" className="btn btn--primary" onClick={() => onSelect(picked.selector)}>
                  Use this zone
                </button>
              </div>
            </div>
          ) : (
            <div className="scope-picker-modal__bar scope-picker-modal__bar--placeholder">
              Hover and click any element on the preview above.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Image Manager ────────────────────────────────────────────────────────────
function ImageManagerTab({ sessionId, onError }) {
  const [images, setImages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null); // image name
  const [quality, setQuality] = useState(80);
  const [format, setFormat] = useState('');
  const [compressing, setCompressing] = useState(false);
  const [compressingAll, setCompressingAll] = useState(false);
  const [batchQuality, setBatchQuality] = useState(80);
  const [batchFormat, setBatchFormat] = useState('webp');
  const [results, setResults] = useState({});
  const replaceRef = useRef(null);

  const loadImages = useCallback(() => {
    setLoading(true);
    getImages(sessionId)
      .then(res => setImages(res.data.images))
      .catch(err => onError(err.response?.data?.error || 'Failed to load images'))
      .finally(() => setLoading(false));
  }, [sessionId]);

  useEffect(() => { loadImages(); }, [loadImages]);

  const fmt = b => b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;

  const handleReplace = async (e) => {
    const file = e.target.files[0];
    if (!file || !selected) return;
    try {
      await replaceImage(sessionId, selected, file);
      loadImages();
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to replace image');
    }
  };

  const handleCompress = async (name) => {
    setCompressing(true);
    try {
      const res = await compressImage(sessionId, name, quality, format || undefined);
      setResults(prev => ({ ...prev, [name]: res.data }));
      loadImages();
    } catch (err) {
      onError(err.response?.data?.error || 'Compression failed');
    } finally {
      setCompressing(false);
    }
  };

  const handleCompressAll = async () => {
    setCompressingAll(true);
    try {
      const res = await compressAll(sessionId, batchQuality, batchFormat || undefined);
      const resultMap = {};
      for (const r of res.data.results) resultMap[r.name] = r;
      setResults(resultMap);
      loadImages();
    } catch (err) {
      onError(err.response?.data?.error || 'Batch compression failed');
    } finally {
      setCompressingAll(false);
    }
  };

  if (loading) return <div className="loading-state"><div className="spinner" /> Loading images…</div>;

  const totalSize = images.reduce((s, img) => s + img.size, 0);

  return (
    <div className="image-manager">
      {/* Batch compress bar */}
      <div className="image-manager__batch">
        <span style={{ fontWeight: 600, fontSize: 13 }}>Batch Compress</span>
        <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Quality</label>
        <input
          type="range" min={30} max={100} value={batchQuality}
          onChange={e => setBatchQuality(Number(e.target.value))}
          style={{ width: 100 }}
        />
        <span style={{ fontSize: 12, minWidth: 32 }}>{batchQuality}%</span>
        <select className="input input--sm" value={batchFormat} onChange={e => setBatchFormat(e.target.value)}>
          <option value="webp">→ WebP</option>
          <option value="jpg">→ JPEG</option>
          <option value="png">→ PNG</option>
          <option value="">Keep format</option>
        </select>
        <button className="btn btn--primary" onClick={handleCompressAll} disabled={compressingAll || !images.length}>
          {compressingAll ? 'Processing…' : `Compress All (${images.length})`}
        </button>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 'auto' }}>
          Total: {fmt(totalSize)}
        </span>
      </div>

      {/* Image grid */}
      <div className="image-grid">
        {images.length === 0 && <div className="empty-state">No images found in img/ folder.</div>}
        {images.map(img => {
          const result = results[img.name];
          const isSel = selected === img.name;
          return (
            <div
              key={img.name}
              className={`image-card ${isSel ? 'image-card--selected' : ''}`}
              onClick={() => setSelected(isSel ? null : img.name)}
            >
              <div className="image-card__thumb">
                <img src={img.url} alt={img.name} loading="lazy" />
              </div>
              <div className="image-card__info">
                <span className="image-card__name" title={img.name}>{img.name}</span>
                <span className="image-card__size">{fmt(img.size)}</span>
                {result && result.savedBytes > 0 && (
                  <span className="badge badge--green" style={{ fontSize: 10 }}>
                    -{result.savedPercent}%
                  </span>
                )}
                {result?.error && <span className="badge badge--red" style={{ fontSize: 10 }}>Error</span>}
              </div>

              {isSel && (
                <div className="image-card__actions" onClick={e => e.stopPropagation()}>
                  <div className="image-card__compress-row">
                    <label style={{ fontSize: 11 }}>Q:</label>
                    <input type="range" min={30} max={100} value={quality} onChange={e => setQuality(Number(e.target.value))} style={{ width: 70 }} />
                    <span style={{ fontSize: 11, minWidth: 28 }}>{quality}%</span>
                    <select className="input" style={{ fontSize: 11, padding: '2px 4px' }} value={format} onChange={e => setFormat(e.target.value)}>
                      <option value="">Same</option>
                      <option value="webp">WebP</option>
                      <option value="jpg">JPEG</option>
                      <option value="png">PNG</option>
                    </select>
                    <button className="btn btn--sm btn--primary" onClick={() => handleCompress(img.name)} disabled={compressing}>
                      {compressing ? '…' : 'Compress'}
                    </button>
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    <input ref={replaceRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleReplace} />
                    <button className="btn btn--sm" onClick={() => replaceRef.current?.click()}>↑ Replace</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Code Editor Tab (dev mode) ───────────────────────────────────────────────
const TEXT_EXTS = new Set(['html', 'htm', 'css', 'js', 'php', 'json', 'txt', 'svg', 'xml', 'md']);

function CodeFileTree({ nodes, onSelect, selectedPath, depth }) {
  if (!nodes?.length) return null;
  depth = depth || 0;
  return (
    <ul className="file-tree" style={depth > 0 ? { paddingLeft: 12 } : {}}>
      {nodes.map(node => (
        <li key={node.path}>
          {node.type === 'dir' ? (
            <>
              <div className="file-tree__item file-tree__item--dir">
                <span className="file-tree__icon">📁</span>
                <span className="file-tree__name">{node.name}/</span>
              </div>
              <CodeFileTree nodes={node.children} onSelect={onSelect} selectedPath={selectedPath} depth={depth + 1} />
            </>
          ) : TEXT_EXTS.has(node.name.split('.').pop().toLowerCase()) ? (
            <div
              className={`file-tree__item ${selectedPath === node.path ? 'file-tree__item--active' : ''}`}
              style={{ cursor: 'pointer' }}
              onClick={() => onSelect(node.path)}
            >
              <span className="file-tree__icon">📄</span>
              <span className="file-tree__name">{node.name}</span>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

const LANG_MAP = { html: 'html', htm: 'html', css: 'css', js: 'javascript', php: 'php', json: 'json', svg: 'xml', xml: 'xml', md: 'markdown' };

function getEditorLang(filePath) {
  const ext = (filePath || '').split('.').pop().toLowerCase();
  return LANG_MAP[ext] || 'plaintext';
}

function setupEmmet(monaco) {
  try { emmetHTML(monaco); } catch {}
  try { emmetCSS(monaco); } catch {}
}

function CodeEditorTab({ sessionId, onError }) {
  const [tree, setTree] = useState([]);
  const [file, setFile] = useState('index.html');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const emmetSetupRef = useRef(false);
  const previewWinRef = useRef(null);

  // Load file tree
  useEffect(() => {
    getDevState(sessionId)
      .then(res => setTree(res.data.tree || []))
      .catch(() => {});
  }, [sessionId]);

  // Load file content when selection changes
  useEffect(() => {
    setLoading(true);
    setSaveMsg('');
    getDevFile(sessionId, file)
      .then(res => setContent(res.data.content))
      .catch(err => { setContent(''); onError(err.response?.data?.error || 'Cannot read file'); })
      .finally(() => setLoading(false));
  }, [sessionId, file]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveDevFile(sessionId, file, content);
      setSaveMsg('Saved ✓');
      // Signal preview window to reload
      try {
        const ch = new BroadcastChannel('ept-preview-' + sessionId);
        ch.postMessage({ reload: true });
        ch.close();
      } catch {}
      setTimeout(() => setSaveMsg(''), 3000);
    } catch (err) {
      onError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleOpenPreview = () => {
    const url = `/dev?preview=${sessionId}`;
    if (previewWinRef.current && !previewWinRef.current.closed) {
      previewWinRef.current.focus();
    } else {
      previewWinRef.current = window.open(url, 'ept-preview-' + sessionId);
    }
  };

  const handleEditorMount = (editor, monaco) => {
    if (!emmetSetupRef.current) {
      setupEmmet(monaco);
      emmetSetupRef.current = true;
    }
  };

  return (
    <div className="code-editor-tab">
      <div className="code-editor-tab__bar">
        <span className="code-editor-tab__filename">{file}</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {saveMsg && <span style={{ fontSize: 12, color: 'var(--success)' }}>{saveMsg}</span>}
          <button className="btn btn--sm" onClick={handleOpenPreview} title="Opens preview in a new tab — reloads automatically on save">
            Open Preview ↗
          </button>
          <button className="btn btn--sm btn--primary" onClick={handleSave} disabled={saving || loading}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      <div className="code-editor-tab__layout">
        <div className="code-editor-tab__tree">
          <CodeFileTree nodes={tree} onSelect={setFile} selectedPath={file} />
        </div>
        <div className="code-editor-tab__editor">
          {loading ? (
            <div className="loading-state"><div className="spinner" /></div>
          ) : (
            <MonacoEditor
              height="100%"
              language={getEditorLang(file)}
              value={content}
              onChange={val => setContent(val || '')}
              theme="vs-dark"
              onMount={handleEditorMount}
              options={{
                fontSize: 13,
                minimap: { enabled: false },
                wordWrap: 'off',
                scrollBeyondLastLine: false,
                automaticLayout: true,
                tabSize: 2,
                quickSuggestions: true,
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main ContentEditor ───────────────────────────────────────────────────────
export default function ContentEditor({ sessionId, mode, onDone, onSkip, onError, externalReloadKey }) {
  const [tab, setTab] = useState('text');

  const tabs = [
    ['text', '✏️ Live Text Editor'],
    ['xai', '✨ Paste & replace'],
    ['images', '🖼 Image Manager'],
    ...(mode === 'dev' ? [['code', '💻 Code Editor']] : []),
  ];

  return (
    <div className="panel content-editor-panel">
      <div className="panel__header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2>Content Editor</h2>
            <p className="panel__desc">Edit texts, replace images, and paste new content into a working zone.</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn--primary btn--lg" onClick={onDone}>Continue →</button>
            <button className="btn btn--lg" onClick={onSkip}>Skip →</button>
          </div>
        </div>
      </div>

      <div className="clean-tabs">
        {tabs.map(([id, label]) => (
          <button key={id} className={`clean-tab-btn ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {tab === 'text'   && <TextEditorTab sessionId={sessionId} onError={onError} externalReloadKey={externalReloadKey} />}
      {tab === 'xai'    && <XaiContentTab sessionId={sessionId} onError={onError} />}
      {tab === 'images' && <ImageManagerTab sessionId={sessionId} onError={onError} />}
      {tab === 'code'   && <CodeEditorTab sessionId={sessionId} onError={onError} />}
    </div>
  );
}
