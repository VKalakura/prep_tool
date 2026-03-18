import { useState, useEffect, useCallback } from 'react';
import { getScripts, cleanScripts, getIframes, cleanIframes, getUnusedFiles, cleanUnusedFiles } from '../api.js';

// ─── Scripts tab ──────────────────────────────────────────────────────────────
function ScriptsTab({ sessionId, onDone, onSkip, onError }) {
  const [scripts, setScripts] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [cleaning, setCleaning] = useState(false);

  useEffect(() => {
    setLoading(true);
    getScripts(sessionId)
      .then(res => {
        const s = res.data.scripts;
        setScripts(s);
        setSelected(new Set(s.filter(sc => sc.suggestion === 'remove').map(sc => sc.index)));
      })
      .catch(err => onError(err.response?.data?.error || 'Failed to load scripts'))
      .finally(() => setLoading(false));
  }, [sessionId]);

  const toggle = (idx) => setSelected(prev => {
    const n = new Set(prev); n.has(idx) ? n.delete(idx) : n.add(idx); return n;
  });

  const handleClean = async () => {
    if (!selected.size) return;
    setCleaning(true);
    try {
      await cleanScripts(sessionId, Array.from(selected));
      onDone();
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to clean scripts');
      setCleaning(false);
    }
  };

  const trackingCount = scripts.filter(s => s.suggestion === 'remove').length;
  const criticalCount = scripts.filter(s => s.suggestion === 'keep').length;

  if (loading) return <div className="loading-state"><div className="spinner" /> Scanning scripts…</div>;

  return (
    <>
      <div className="script-stats">
        <div className="stat stat--red" title="Click to select all" onClick={() => setSelected(new Set(scripts.filter(s => s.suggestion === 'remove').map(s => s.index)))}>
          <span className="stat__num">{trackingCount}</span>
          <span className="stat__label">Tracking</span>
        </div>
        <div className="stat">
          <span className="stat__num">{scripts.length - trackingCount - criticalCount}</span>
          <span className="stat__label">Unknown</span>
        </div>
        <div className="stat stat--green">
          <span className="stat__num">{criticalCount}</span>
          <span className="stat__label">Critical</span>
        </div>
        <div className="stat">
          <span className="stat__num">{scripts.length}</span>
          <span className="stat__label">Total</span>
        </div>
      </div>

      <div className="toolbar">
        <button className="btn btn--sm btn--danger" onClick={() => setSelected(new Set(scripts.filter(s => s.suggestion === 'remove').map(s => s.index)))}>Select Tracking</button>
        <button className="btn btn--sm" onClick={() => setSelected(new Set(scripts.map(s => s.index)))}>Select All</button>
        <button className="btn btn--sm" onClick={() => setSelected(new Set())}>Clear</button>
        <span className="toolbar__count">{selected.size} selected for removal</span>
      </div>

      <div className="script-list">
        {scripts.length === 0 && <div className="empty-state">No scripts found in index.html.</div>}
        {scripts.map(script => {
          const isSelected = selected.has(script.index);
          return (
            <div
              key={script.id}
              className={`script-item ${isSelected ? 'script-item--selected' : ''} ${script.suggestion === 'keep' ? 'script-item--critical' : ''}`}
              onClick={() => toggle(script.index)}
            >
              <input type="checkbox" checked={isSelected} onChange={() => toggle(script.index)} onClick={e => e.stopPropagation()} />
              <div className="script-item__body">
                {script.src
                  ? <code>{script.src}</code>
                  : <code className="script-item__inline">(inline) {script.inline?.slice(0, 120)}{script.inline?.length > 120 ? '…' : ''}</code>
                }
              </div>
              {script.suggestion === 'remove' && <span className="badge badge--red">Tracking</span>}
              {script.suggestion === 'keep' && <span className="badge badge--green">Critical</span>}
              {script.suggestion === 'review' && <span className="badge">Unknown</span>}
            </div>
          );
        })}
      </div>

      <div className="panel__footer">
        <button className="btn btn--danger btn--lg" onClick={handleClean} disabled={!selected.size || cleaning}>
          {cleaning ? 'Removing…' : `Remove ${selected.size} Script${selected.size !== 1 ? 's' : ''} →`}
        </button>
        <button className="btn btn--lg" onClick={onSkip}>Skip →</button>
      </div>
    </>
  );
}

// ─── iFrames tab ──────────────────────────────────────────────────────────────
function IframesTab({ sessionId, onError }) {
  const [iframes, setIframes] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [cleaning, setCleaning] = useState(false);
  const [removedCount, setRemovedCount] = useState(0);

  const load = useCallback(() => {
    setLoading(true);
    getIframes(sessionId)
      .then(res => {
        setIframes(res.data.iframes);
        setSelected(new Set(res.data.iframes.map(f => f.index)));
      })
      .catch(err => onError(err.response?.data?.error || 'Failed to load iframes'))
      .finally(() => setLoading(false));
  }, [sessionId]);

  useEffect(() => { load(); }, [load]);

  const toggle = (idx) => setSelected(prev => {
    const n = new Set(prev); n.has(idx) ? n.delete(idx) : n.add(idx); return n;
  });

  const handleClean = async () => {
    if (!selected.size) return;
    setCleaning(true);
    try {
      const res = await cleanIframes(sessionId, Array.from(selected));
      setRemovedCount(prev => prev + res.data.removed);
      load();
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to remove iframes');
    } finally {
      setCleaning(false);
    }
  };

  if (loading) return <div className="loading-state"><div className="spinner" /> Scanning iframes…</div>;

  return (
    <>
      <div className="script-stats">
        <div className="stat"><span className="stat__num">{iframes.length}</span><span className="stat__label">Found</span></div>
        <div className="stat stat--green"><span className="stat__num">{removedCount}</span><span className="stat__label">Removed</span></div>
      </div>

      <div className="toolbar">
        <button className="btn btn--sm" onClick={() => setSelected(new Set(iframes.map(f => f.index)))}>Select All</button>
        <button className="btn btn--sm" onClick={() => setSelected(new Set())}>Clear</button>
        <span className="toolbar__count">{selected.size} selected</span>
      </div>

      <div className="script-list">
        {iframes.length === 0 && <div className="empty-state">No iframes found. {removedCount > 0 ? `${removedCount} removed earlier.` : 'Nothing to clean.'}</div>}
        {iframes.map(frame => (
          <div key={frame.index} className={`script-item ${selected.has(frame.index) ? 'script-item--selected' : ''}`} onClick={() => toggle(frame.index)}>
            <input type="checkbox" checked={selected.has(frame.index)} onChange={() => toggle(frame.index)} onClick={e => e.stopPropagation()} />
            <div className="script-item__body">
              {frame.src ? <code>{frame.src}</code> : <code className="script-item__inline">(no src — inline iframe)</code>}
              {(frame.width || frame.height) && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  {[frame.width && `w:${frame.width}`, frame.height && `h:${frame.height}`].filter(Boolean).join(', ')}
                </div>
              )}
            </div>
            <span className="badge badge--yellow">iframe</span>
          </div>
        ))}
      </div>

      <div className="panel__footer">
        <button className="btn btn--danger btn--lg" onClick={handleClean} disabled={!selected.size || cleaning || !iframes.length}>
          {cleaning ? 'Removing…' : `Remove ${selected.size} iFrame${selected.size !== 1 ? 's' : ''}`}
        </button>
      </div>
    </>
  );
}

// ─── Unused Files tab ─────────────────────────────────────────────────────────
function UnusedFilesTab({ sessionId, onError }) {
  const [files, setFiles] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [cleaning, setCleaning] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    getUnusedFiles(sessionId)
      .then(res => {
        setFiles(res.data.files);
        setSelected(new Set(res.data.files.map(f => f.path)));
      })
      .catch(err => onError(err.response?.data?.error || 'Failed to scan files'))
      .finally(() => setLoading(false));
  }, [sessionId]);

  useEffect(() => { load(); }, [load]);

  const toggle = (p) => setSelected(prev => {
    const n = new Set(prev); n.has(p) ? n.delete(p) : n.add(p); return n;
  });

  const handleClean = async () => {
    if (!selected.size) return;
    setCleaning(true);
    try {
      await cleanUnusedFiles(sessionId, Array.from(selected));
      load();
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to delete files');
    } finally {
      setCleaning(false);
    }
  };

  const fmt = b => b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;
  const totalSelected = files.filter(f => selected.has(f.path)).reduce((s, f) => s + f.size, 0);

  if (loading) return <div className="loading-state"><div className="spinner" /> Scanning for unused files…</div>;

  return (
    <>
      <div className="script-stats">
        <div className="stat stat--yellow"><span className="stat__num">{files.length}</span><span className="stat__label">Unused</span></div>
        <div className="stat"><span className="stat__num">{fmt(files.reduce((s, f) => s + f.size, 0))}</span><span className="stat__label">Total size</span></div>
      </div>

      <div className="toolbar">
        <button className="btn btn--sm" onClick={() => setSelected(new Set(files.map(f => f.path)))}>Select All</button>
        <button className="btn btn--sm" onClick={() => setSelected(new Set())}>Clear</button>
        <span className="toolbar__count">{selected.size} selected · {fmt(totalSelected)} to free</span>
      </div>

      <div className="script-list">
        {files.length === 0 && <div className="empty-state">No unused files found. Everything is referenced.</div>}
        {files.map(file => (
          <div key={file.path} className={`script-item ${selected.has(file.path) ? 'script-item--selected' : ''}`} onClick={() => toggle(file.path)}>
            <input type="checkbox" checked={selected.has(file.path)} onChange={() => toggle(file.path)} onClick={e => e.stopPropagation()} />
            <div className="script-item__body"><code>{file.path}</code></div>
            <span className="badge badge--yellow">{fmt(file.size)}</span>
          </div>
        ))}
      </div>

      <div className="panel__footer">
        <button className="btn btn--danger btn--lg" onClick={handleClean} disabled={!selected.size || cleaning || !files.length}>
          {cleaning ? 'Deleting…' : `Delete ${selected.size} File${selected.size !== 1 ? 's' : ''} (${fmt(totalSelected)})`}
        </button>
      </div>
    </>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function ScriptCleaner({ sessionId, onDone, onSkip, onError }) {
  const [tab, setTab] = useState('scripts');

  return (
    <div className="panel panel--wide">
      <div className="panel__header">
        <h2>Deep Clean</h2>
        <p className="panel__desc">Remove tracking scripts, iFrames, and unused files from the offer.</p>
      </div>

      <div className="clean-tabs">
        {[['scripts', '📜 Scripts'], ['iframes', '🖼 iFrames'], ['unused', '🗑 Unused Files']].map(([id, label]) => (
          <button key={id} className={`clean-tab-btn ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {tab === 'scripts' && <ScriptsTab sessionId={sessionId} onDone={onDone} onSkip={onSkip} onError={onError} />}
      {tab === 'iframes' && <IframesTab sessionId={sessionId} onError={onError} />}
      {tab === 'unused'  && <UnusedFilesTab sessionId={sessionId} onError={onError} />}
    </div>
  );
}
