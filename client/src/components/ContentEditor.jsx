import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getEditableElements, saveText, bulkReplace,
  getImages, replaceImage, compressImage, compressAll,
} from '../api.js';

// ─── Live Text Editor ─────────────────────────────────────────────────────────
function TextEditorTab({ sessionId, onError }) {
  const iframeRef = useRef(null);
  const [selected, setSelected] = useState(null); // { idx, tag, text } | { _img: true, name, src, width, height }
  const [editText, setEditText] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  const [iframeKey, setIframeKey] = useState(0); // reload iframe key
  const imgReplaceRef = useRef(null);
  const [imgReplacing, setImgReplacing] = useState(false);

  // Listen for messages from iframe
  useEffect(() => {
    const handler = (e) => {
      if (!e.data) return;
      if (e.data.type === 'ept-select') {
        setSelected({ idx: e.data.idx, tag: e.data.tag, text: e.data.text });
        setEditText(e.data.text);
      }
      if (e.data.type === 'ept-img-select') {
        setSelected({ _img: true, name: e.data.name, src: e.data.src, width: e.data.width, height: e.data.height });
        setEditText('');
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
      sendToIframe({ type: 'ept-update', idx: selected.idx, text: val });
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
    sendToIframe({ type: 'ept-deselect' });
  };

  const handleReload = () => {
    setSelected(null);
    setEditText('');
    setIframeKey(k => k + 1);
  };

  const handleImgReplace = async (e) => {
    const file = e.target.files[0];
    if (!file || !selected?._img) return;
    setImgReplacing(true);
    try {
      await replaceImage(sessionId, selected.name, file);
      setSavedCount(c => c + 1);
      // Tell iframe to refresh this image
      sendToIframe({ type: 'ept-img-update', name: selected.name });
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to replace image');
    } finally {
      setImgReplacing(false);
      e.target.value = '';
    }
  };

  return (
    <div className="text-editor-layout">
      {/* Left: iframe preview */}
      <div className="text-editor-preview">
        <div className="text-editor-preview__bar">
          <span className="text-editor-preview__hint">Click text to edit · Click image to replace</span>
          <button className="btn btn--sm" onClick={handleReload}>↺ Reload</button>
        </div>
        <iframe
          key={iframeKey}
          ref={iframeRef}
          src={`/api/content/${sessionId}/preview-iframe`}
          className="text-editor-iframe"
          title="Offer Preview"
          sandbox="allow-scripts allow-same-origin"
        />
      </div>

      {/* Right: edit panel */}
      <div className="text-editor-panel">
        <div className="text-editor-panel__header">
          <h3>Edit Element</h3>
          {savedCount > 0 && <span className="badge badge--green">✓ {savedCount} saved</span>}
        </div>

        {!selected ? (
          <div className="text-editor-empty">
            <div className="text-editor-empty__icon">👆</div>
            <p>Click on any text or image in the preview.</p>
            <p style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
              Headings, paragraphs, buttons, links are editable. Images can be replaced.
            </p>
          </div>
        ) : selected._img ? (
          <div className="text-editor-form">
            <div className="text-editor-tag">
              <span className="badge" style={{ background: 'var(--warning)', color: '#fff' }}>img</span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={selected.name}>{selected.name}</span>
              <button className="btn btn--sm" style={{ marginLeft: 'auto' }} onClick={handleDeselect}>✕</button>
            </div>
            {selected.src && (
              <div className="text-editor-img-preview">
                <img src={selected.src} alt={selected.name} style={{ maxWidth: '100%', maxHeight: 160, borderRadius: 6, objectFit: 'contain', background: '#1a1d27' }} />
                {selected.width > 0 && (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>{selected.width} × {selected.height}px</span>
                )}
              </div>
            )}
            <input ref={imgReplaceRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleImgReplace} />
            <button
              className="btn btn--primary btn--lg"
              onClick={() => imgReplaceRef.current?.click()}
              disabled={imgReplacing}
            >
              {imgReplacing ? 'Replacing…' : '↑ Replace Image'}
            </button>
          </div>
        ) : (
          <div className="text-editor-form">
            <div className="text-editor-tag">
              <span className="badge badge--blue">&lt;{selected.tag}&gt;</span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>element #{selected.idx}</span>
              <button className="btn btn--sm" style={{ marginLeft: 'auto' }} onClick={handleDeselect}>✕</button>
            </div>
            <textarea
              className="text-editor-textarea"
              value={editText}
              onChange={e => handleTextChange(e.target.value)}
              rows={5}
              placeholder="Edit text here…"
              autoFocus
            />
            <button className="btn btn--primary btn--lg" onClick={handleSave} disabled={saving || editText === selected.text}>
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
            {editText !== selected.text && (
              <button className="btn btn--sm" onClick={() => { setEditText(selected.text); sendToIframe({ type: 'ept-update', idx: selected.idx, text: selected.text }); }}>
                Discard
              </button>
            )}
          </div>
        )}
      </div>
    </div>
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

// ─── Main ContentEditor ───────────────────────────────────────────────────────
export default function ContentEditor({ sessionId, onDone, onSkip, onError }) {
  const [tab, setTab] = useState('text');

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
        {[['text', '✏️ Live Text Editor'], ['bulk', '📋 Bulk Replace'], ['images', '🖼 Image Manager']].map(([id, label]) => (
          <button key={id} className={`clean-tab-btn ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {tab === 'text'   && <TextEditorTab sessionId={sessionId} onError={onError} />}
      {tab === 'bulk'   && <BulkReplaceTab sessionId={sessionId} onError={onError} />}
      {tab === 'images' && <ImageManagerTab sessionId={sessionId} onError={onError} />}
    </div>
  );
}
