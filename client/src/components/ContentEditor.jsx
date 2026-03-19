import { useState, useEffect, useRef, useCallback } from 'react';
import MonacoEditor from '@monaco-editor/react';
import { emmetHTML, emmetCSS, emmetJSX } from 'emmet-monaco-es';
import {
  getEditableElements, saveText, bulkReplace,
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
        <span className="element-card__label">{label}</span>
        {item.className && (
          <span className="element-card__class" title={item.className}>
            .{item.className.split(' ')[0]}
          </span>
        )}
      </div>
    </button>
  );
}

// ─── Live Text Editor ─────────────────────────────────────────────────────────
function TextEditorTab({ sessionId, onError }) {
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
  const [previewMode, setPreviewMode] = useState('desktop'); // 'responsive' | 'desktop' | 'mobile'
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

  const handleInsertAfter = async (templateIdx) => {
    if (!selected) return;
    setInserting(true);
    setShowPicker(false);
    try {
      const isMedia = selected._img || selected._video;
      const afterSelector = isMedia ? selected.selectorPath : undefined;
      const afterIdx = isMedia ? undefined : selected.idx;
      const res = await insertAfter(sessionId, afterIdx, templateIdx, afterSelector);
      const { newIdx, tag, isImgLink } = res.data;
      if (!isMedia) {
        pendingSelectRef.current = isImgLink
          ? { idx: newIdx, tag, text: null }
          : { idx: newIdx, tag, text: 'Новий текст' };
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
      await replaceImage(sessionId, selected.name, file);
      setSavedCount(c => c + 1);
      sendToIframe({ type: 'ept-img-update', name: selected.name });
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to replace image');
    } finally {
      setImgReplacing(false);
      e.target.value = '';
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

  return (
    <>
    <div className="text-editor-layout">
      {/* Left: iframe preview */}
      <div className="text-editor-preview">
        <div className="text-editor-preview__bar">
          {deletePickMode
            ? <span className="text-editor-preview__hint" style={{ color: '#ef4444' }}>🗑 Click → selects block · Dbl-click → exact element · Hidden shown in orange</span>
            : <span className="text-editor-preview__hint">Click text to edit · Click image or video to replace</span>
          }
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
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
            src={`/api/content/${sessionId}/preview-iframe`}
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

      {/* Right: edit panel */}
      <div className="text-editor-panel">
        <div className="text-editor-panel__header">
          <h3>Edit Element</h3>
          {savedCount > 0 && <span className="badge badge--green">✓ {savedCount} saved</span>}
        </div>

        {pendingDelete ? (
          <div className="text-editor-form">
            <div className="text-editor-tag">
              <span className="badge badge--red">Delete</span>
              <code style={{ fontSize: 11, color: 'var(--text-muted)' }}>{pendingDelete.label}</code>
              <button className="btn btn--sm" style={{ marginLeft: 'auto' }} onClick={() => { setPendingDelete(null); }}>✕</button>
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
        ) : !selected ? (
          <div className="text-editor-empty">
            {deletePickMode ? (
              <>
                <div className="text-editor-empty__icon">🗑</div>
                <p style={{ color: '#ef4444' }}>Hover over any element and click to delete it.</p>
                <p style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                  Works on any DOM element — sections, divs, images, buttons…
                </p>
              </>
            ) : (
              <>
                <div className="text-editor-empty__icon">👆</div>
                <p>Click on any text or image in the preview.</p>
                <p style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                  Headings, paragraphs, buttons, links are editable. Images can be replaced.
                </p>
              </>
            )}
          </div>
        ) : selected._img ? (
          <div className="text-editor-form">
            <div className="text-editor-tag">
              <span className="badge" style={{ background: 'var(--warning)', color: '#fff' }}>img</span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={selected.name}>{selected.name}</span>
              <button className="btn btn--sm" style={{ marginLeft: 'auto' }} onClick={handleDeselect}>✕</button>
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
              <span style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={selected.name}>{selected.name}</span>
              <button className="btn btn--sm" style={{ marginLeft: 'auto' }} onClick={handleDeselect}>✕</button>
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
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>element #{selected.idx}</span>
              <button className="btn btn--sm" style={{ marginLeft: 'auto' }} onClick={handleDeselect}>✕</button>
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
                  key={item.idx}
                  item={item}
                  sessionId={sessionId}
                  cssLinks={cssLinks}
                  inlineStyles={inlineStyles}
                  onClick={() => handleInsertAfter(item.idx)}
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

// ─── Bulk Text Replace ────────────────────────────────────────────────────────
function BulkReplaceTab({ sessionId, onError }) {
  const [elements, setElements] = useState([]);
  const [rawText, setRawText] = useState('');
  const [blocks, setBlocks] = useState([]);
  const [mappings, setMappings] = useState([]); // [{idx, oldText, newText}]
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(0);
  const fileRef = useRef(null);

  useEffect(() => {
    setLoading(true);
    getEditableElements(sessionId)
      .then(res => setElements(res.data.elements))
      .catch(err => onError(err.response?.data?.error || 'Failed to load elements'))
      .finally(() => setLoading(false));
  }, [sessionId]);

  const parseBlocks = useCallback((text) => {
    return text.split(/\n{2,}/).map(b => b.replace(/\n/g, ' ').trim()).filter(Boolean);
  }, []);

  const handleTextChange = (val) => {
    setRawText(val);
    const parsed = parseBlocks(val);
    setBlocks(parsed);
    // Build mappings: block[i] → element[i]
    const maps = parsed.map((block, i) => ({
      idx: elements[i]?.idx,
      tag: elements[i]?.tag,
      oldText: elements[i]?.text || '',
      newText: block,
    })).filter(m => m.idx !== undefined);
    setMappings(maps);
  };

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => handleTextChange(ev.target.result);
    reader.readAsText(file);
  };

  const handleApply = async () => {
    if (!mappings.length) return;
    setApplying(true);
    try {
      const res = await bulkReplace(sessionId, mappings.map(m => ({ idx: m.idx, text: m.newText })));
      setApplied(res.data.applied);
    } catch (err) {
      onError(err.response?.data?.error || 'Bulk replace failed');
    } finally {
      setApplying(false);
    }
  };

  if (loading) return <div className="loading-state"><div className="spinner" /> Loading elements…</div>;

  return (
    <div className="bulk-replace">
      <div className="bulk-replace__header">
        <p className="panel__desc">
          Paste or upload your text. Each paragraph (blank line between) maps to the next editable element sequentially.
          Offer has <strong>{elements.length}</strong> editable elements.
        </p>
      </div>

      <div className="bulk-replace__input-area">
        <div className="bulk-replace__toolbar">
          <span style={{ fontSize: 13, fontWeight: 600 }}>Your text</span>
          <input ref={fileRef} type="file" accept=".txt" style={{ display: 'none' }} onChange={handleFile} />
          <button className="btn btn--sm" onClick={() => fileRef.current?.click()}>📄 Upload .txt</button>
          <button className="btn btn--sm" onClick={() => { setRawText(''); setBlocks([]); setMappings([]); }}>Clear</button>
        </div>
        <textarea
          className="code-editor"
          style={{ minHeight: 180 }}
          value={rawText}
          onChange={e => handleTextChange(e.target.value)}
          placeholder={'Paragraph 1 (→ 1st editable element)\n\nParagraph 2 (→ 2nd editable element)\n\nParagraph 3 (→ 3rd editable element)'}
        />
      </div>

      {mappings.length > 0 && (
        <>
          <div className="bulk-replace__preview-header">
            <span style={{ fontSize: 13, fontWeight: 600 }}>Preview — {mappings.length} replacements</span>
          </div>
          <div className="bulk-replace__table">
            {mappings.map((m, i) => (
              <div key={i} className="bulk-replace__row">
                <span className="badge badge--blue">&lt;{m.tag}&gt;</span>
                <div className="bulk-replace__old">{m.oldText || <em style={{ color: 'var(--text-muted)' }}>(empty)</em>}</div>
                <span className="bulk-replace__arrow">→</span>
                <div className="bulk-replace__new">{m.newText}</div>
              </div>
            ))}
          </div>

          <div className="panel__footer">
            <button className="btn btn--primary btn--lg" onClick={handleApply} disabled={applying}>
              {applying ? 'Applying…' : `Apply ${mappings.length} Replacements`}
            </button>
            {applied > 0 && <span className="badge badge--green">✓ {applied} replaced</span>}
          </div>
        </>
      )}
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
export default function ContentEditor({ sessionId, mode, onDone, onSkip, onError }) {
  const [tab, setTab] = useState('text');

  const tabs = [
    ['text', '✏️ Live Text Editor'],
    ['bulk', '📋 Bulk Replace'],
    ['images', '🖼 Image Manager'],
    ...(mode === 'dev' ? [['code', '💻 Code Editor']] : []),
  ];

  return (
    <div className="panel content-editor-panel">
      <div className="panel__header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2>Content Editor</h2>
            <p className="panel__desc">Edit texts, replace images, and do bulk content updates.</p>
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

      {tab === 'text'   && <TextEditorTab sessionId={sessionId} onError={onError} />}
      {tab === 'bulk'   && <BulkReplaceTab sessionId={sessionId} onError={onError} />}
      {tab === 'images' && <ImageManagerTab sessionId={sessionId} onError={onError} />}
      {tab === 'code'   && <CodeEditorTab sessionId={sessionId} onError={onError} />}
    </div>
  );
}
