import { useState, useEffect, useCallback } from 'react';
import { getScripts, cleanScripts, getIframes, cleanIframes, getUnusedFiles, cleanUnusedFiles, getHeadItems, cleanHeadItemsApi, getForms, replaceForms } from '../api.js';

// ─── Scripts tab ──────────────────────────────────────────────────────────────
function ScriptsTab({ sessionId, onDone, onSkip, onError }) {
  const [scripts, setScripts] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [expanded, setExpanded] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [cleaning, setCleaning] = useState(false);

  useEffect(() => {
    setLoading(true);
    getScripts(sessionId)
      .then(res => {
        const s = res.data.scripts;
        setScripts(s);
        setSelected(new Set(s.filter(sc => sc.suggestion === 'remove').map(sc => sc.id)));
      })
      .catch(err => onError(err.response?.data?.error || 'Failed to load scripts'))
      .finally(() => setLoading(false));
  }, [sessionId]);

  const toggle = (id) => setSelected(prev => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n;
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

  const toggleExpand = (id) => setExpanded(prev => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n;
  });

  const trackingCount = scripts.filter(s => s.isTracking).length;
  const formHandlerCount = scripts.filter(s => s.isFormHandler).length;
  const interactiveCount = scripts.filter(s => s.isInteractive).length;
  const criticalCount = scripts.filter(s => s.suggestion === 'keep').length;
  const unknownCount = scripts.filter(s => s.suggestion === 'review').length;

  if (loading) return <div className="loading-state"><div className="spinner" /> Scanning scripts…</div>;

  return (
    <>
      <div className="script-stats">
        <div className="stat">
          <span className="stat__num">{scripts.length}</span>
          <span className="stat__label">Total</span>
        </div>
        <div className="stat stat--red" title="Click to select tracking" onClick={() => setSelected(new Set(scripts.filter(s => s.isTracking).map(s => s.id)))}>
          <span className="stat__num">{trackingCount}</span>
          <span className="stat__label">Tracking</span>
        </div>
        <div className="stat stat--yellow" title="Click to select form handlers" onClick={() => setSelected(new Set(scripts.filter(s => s.isFormHandler).map(s => s.id)))}>
          <span className="stat__num">{formHandlerCount}</span>
          <span className="stat__label">Form Handlers</span>
        </div>
        <div className="stat stat--green">
          <span className="stat__num">{interactiveCount}</span>
          <span className="stat__label">Interactive</span>
        </div>
        <div className="stat">
          <span className="stat__num">{criticalCount - interactiveCount}</span>
          <span className="stat__label">Critical</span>
        </div>
        {unknownCount > 0 && (
          <div className="stat stat--yellow" title="Click to select unknown scripts" onClick={() => setSelected(new Set(scripts.filter(s => s.suggestion === 'review').map(s => s.id)))}>
            <span className="stat__num">{unknownCount}</span>
            <span className="stat__label">Unknown</span>
          </div>
        )}
      </div>

      <div className="toolbar">
        <button className="btn btn--sm btn--danger" onClick={() => setSelected(new Set(scripts.filter(s => s.suggestion === 'remove').map(s => s.id)))}>Select Tracking + Form Handlers</button>
        <button className="btn btn--sm" onClick={() => setSelected(new Set(scripts.map(s => s.id)))}>Select All</button>
        <button className="btn btn--sm" onClick={() => setSelected(new Set())}>Clear</button>
        <span className="toolbar__count">{selected.size} selected for removal</span>
      </div>

      <div className="script-list">
        {scripts.length === 0 && <div className="empty-state">No scripts found in index.html.</div>}
        {scripts.map(script => {
          const isSelected = selected.has(script.id);
          const isExpanded = expanded.has(script.id);
          const hasContent = !!script.content;
          return (
            <div
              key={script.id}
              className={`script-item ${isSelected ? 'script-item--selected' : ''} ${script.suggestion === 'keep' ? 'script-item--critical' : ''} ${isExpanded ? 'script-item--expanded' : ''}`}
            >
              <div className="script-item__row" onClick={() => toggle(script.id)}>
                <input type="checkbox" checked={isSelected} onChange={() => toggle(script.id)} onClick={e => e.stopPropagation()} />
                <div className="script-item__body">
                  {script.src
                    ? <code>{script.src}</code>
                    : <code className="script-item__inline">(inline) {script.inline?.slice(0, 120)}{script.inline?.length > 120 ? '…' : ''}</code>
                  }
                </div>
                {script.isNoscript && <span className="badge badge--yellow">noscript</span>}
                {script.isExternalUnknown && <span className="badge badge--red">Ext Script</span>}
                {script.isTracking && !script.isExternalUnknown && <span className="badge badge--red">Tracking</span>}
                {script.isFormHandler && <span className="badge badge--yellow">Form Handler</span>}
                {script.isOrphanDependency && <span className="badge badge--yellow" title="Library with no surviving scripts that use it">Orphan Dep</span>}
                {script.isInteractive && <span className="badge badge--green" title="Controls UI elements (menu, slider, etc.) — safe to keep">⚡ Interactive</span>}
                {script.isCritical && !script.isInteractive && !script.isOrphanDependency && <span className="badge badge--green">Critical</span>}
                {script.suggestion === 'review' && !script.isNoscript && <span className="badge">Unknown</span>}
                {hasContent && (
                  <button
                    className="script-expand-btn"
                    title={isExpanded ? 'Collapse' : 'Expand source'}
                    onClick={e => { e.stopPropagation(); toggleExpand(script.id); }}
                  >{isExpanded ? '▲' : '▼'}</button>
                )}
              </div>
              {isExpanded && hasContent && (
                <pre className="script-item__source">{script.content}</pre>
              )}
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
          <div key={frame.index} className={`script-item ${selected.has(frame.index) ? 'script-item--selected' : ''}`}>
            <div className="script-item__row" onClick={() => toggle(frame.index)}>
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
          <div key={file.path} className={`script-item ${selected.has(file.path) ? 'script-item--selected' : ''}`}>
            <div className="script-item__row" onClick={() => toggle(file.path)}>
              <input type="checkbox" checked={selected.has(file.path)} onChange={() => toggle(file.path)} onClick={e => e.stopPropagation()} />
              <div className="script-item__body"><code>{file.path}</code></div>
              <span className="badge badge--yellow">{fmt(file.size)}</span>
            </div>
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

// ─── Head tab ─────────────────────────────────────────────────────────────────
const SUBTYPE_LABELS = {
  jsonld:            { badge: 'schema.org',  cls: 'badge--red' },
  'external-script': { badge: 'Ext Script',  cls: 'badge--red' },
  'external-link':   { badge: 'Ext Link',    cls: 'badge--yellow' },
  manifest:          { badge: 'manifest',    cls: 'badge--yellow' },
  meta:              { badge: 'Meta',        cls: '' },
};

function HeadTab({ sessionId, onError }) {
  const [items, setItems]     = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading]   = useState(true);
  const [cleaning, setCleaning] = useState(false);
  const [removed, setRemoved]   = useState(0);

  const load = useCallback(() => {
    setLoading(true);
    getHeadItems(sessionId)
      .then(res => {
        const list = res.data.items;
        setItems(list);
        setSelected(new Set(list.filter(i => i.suggestion === 'remove').map(i => i.index)));
      })
      .catch(err => onError(err.response?.data?.error || 'Failed to load head items'))
      .finally(() => setLoading(false));
  }, [sessionId]);

  useEffect(() => { load(); }, [load]);

  const toggle = idx => setSelected(prev => {
    const n = new Set(prev); n.has(idx) ? n.delete(idx) : n.add(idx); return n;
  });

  const handleClean = async () => {
    if (!selected.size) return;
    setCleaning(true);
    try {
      const res = await cleanHeadItemsApi(sessionId, Array.from(selected));
      setRemoved(prev => prev + res.data.total);
      load();
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to clean head');
    } finally {
      setCleaning(false);
    }
  };

  if (loading) return <div className="loading-state"><div className="spinner" /> Scanning head…</div>;

  const counts = { jsonld: 0, 'external-link': 0, meta: 0 };
  items.forEach(i => counts[i.subtype] != null && counts[i.subtype]++);

  return (
    <>
      <div className="script-stats">
        <div className="stat stat--red"><span className="stat__num">{counts.jsonld}</span><span className="stat__label">Schema.org</span></div>
        <div className="stat stat--yellow"><span className="stat__num">{counts['external-link']}</span><span className="stat__label">Ext Links</span></div>
        <div className="stat"><span className="stat__num">{counts.meta}</span><span className="stat__label">Meta Tags</span></div>
        <div className="stat stat--green"><span className="stat__num">{removed}</span><span className="stat__label">Removed</span></div>
      </div>

      <div className="toolbar">
        <button className="btn btn--sm btn--danger" onClick={() => setSelected(new Set(items.filter(i => i.suggestion === 'remove').map(i => i.index)))}>Select All Removable</button>
        <button className="btn btn--sm" onClick={() => setSelected(new Set(items.map(i => i.index)))}>Select All</button>
        <button className="btn btn--sm" onClick={() => setSelected(new Set())}>Clear</button>
        <span className="toolbar__count">{selected.size} selected</span>
      </div>

      <div className="script-list">
        {items.length === 0 && <div className="empty-state">Head is already clean. {removed > 0 ? `${removed} items removed earlier.` : ''}</div>}
        {items.map(item => {
          const isSelected = selected.has(item.index);
          const { badge, cls } = SUBTYPE_LABELS[item.subtype] || { badge: item.subtype, cls: '' };
          return (
            <div key={item.index} className={`script-item ${isSelected ? 'script-item--selected' : ''}`}>
              <div className="script-item__row" onClick={() => toggle(item.index)}>
                <input type="checkbox" checked={isSelected} onChange={() => toggle(item.index)} onClick={e => e.stopPropagation()} />
                <div className="script-item__body">
                  <code className="script-item__inline">{item.label}</code>
                  {item.rel && <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6 }}>rel={item.rel}</span>}
                </div>
                <span className={`badge ${cls}`}>{badge}</span>
                {item.isFont && <span className="badge badge--green">Font</span>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="panel__footer">
        <button className="btn btn--danger btn--lg" onClick={handleClean} disabled={!selected.size || cleaning || !items.length}>
          {cleaning ? 'Cleaning…' : `Remove ${selected.size} Item${selected.size !== 1 ? 's' : ''}`}
        </button>
      </div>
    </>
  );
}

// ─── Forms tab ────────────────────────────────────────────────────────────────
function FormsTab({ sessionId, onError }) {
  const [forms, setForms] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [expanded, setExpanded] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [replacing, setReplacing] = useState(false);
  const [replacedCount, setReplacedCount] = useState(0);

  const load = useCallback(() => {
    setLoading(true);
    getForms(sessionId)
      .then(res => {
        setForms(res.data.forms);
        setSelected(new Set(res.data.forms.map(f => f.index)));
      })
      .catch(err => onError(err.response?.data?.error || 'Failed to load forms'))
      .finally(() => setLoading(false));
  }, [sessionId]);

  useEffect(() => { load(); }, [load]);

  const toggle = (idx) => setSelected(prev => {
    const n = new Set(prev); n.has(idx) ? n.delete(idx) : n.add(idx); return n;
  });

  const toggleExpand = (idx) => setExpanded(prev => {
    const n = new Set(prev); n.has(idx) ? n.delete(idx) : n.add(idx); return n;
  });

  const handleReplace = async () => {
    if (!selected.size) return;
    setReplacing(true);
    try {
      const res = await replaceForms(sessionId, Array.from(selected));
      setReplacedCount(prev => prev + res.data.replaced);
      load();
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to replace forms');
    } finally {
      setReplacing(false);
    }
  };

  if (loading) return <div className="loading-state"><div className="spinner" /> Scanning forms…</div>;

  return (
    <>
      <div className="script-stats">
        <div className="stat stat--yellow"><span className="stat__num">{forms.length}</span><span className="stat__label">Found</span></div>
        <div className="stat stat--green"><span className="stat__num">{replacedCount}</span><span className="stat__label">Replaced</span></div>
      </div>

      <div className="toolbar">
        <button className="btn btn--sm" onClick={() => setSelected(new Set(forms.map(f => f.index)))}>Select All</button>
        <button className="btn btn--sm" onClick={() => setSelected(new Set())}>Clear</button>
        <span className="toolbar__count">{selected.size} selected</span>
      </div>

      <div className="script-list">
        {forms.length === 0 && (
          <div className="empty-state">
            {replacedCount > 0 ? `All ${replacedCount} form${replacedCount !== 1 ? 's' : ''} replaced with divs.` : 'No forms found.'}
          </div>
        )}
        {forms.map(form => {
          const isSelected = selected.has(form.index);
          const isExpanded = expanded.has(form.index);
          return (
            <div key={form.index} className={`script-item ${isSelected ? 'script-item--selected' : ''} ${isExpanded ? 'script-item--expanded' : ''}`}>
              <div className="script-item__row" onClick={() => toggle(form.index)}>
                <input type="checkbox" checked={isSelected} onChange={() => toggle(form.index)} onClick={e => e.stopPropagation()} />
                <div className="script-item__body">
                  <code>
                    {[form.id && `#${form.id}`, form.cls && `.${form.cls.split(' ')[0]}`].filter(Boolean).join(' ') || '(no id/class)'}
                  </code>
                  {form.action && <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6 }}>action={form.action}</span>}
                  {form.text && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{form.text}</div>}
                </div>
                {form.method && <span className="badge">{form.method.toUpperCase()}</span>}
                <span className="badge badge--yellow">form</span>
                <button
                  className="script-expand-btn"
                  title={isExpanded ? 'Collapse' : 'Expand markup'}
                  onClick={e => { e.stopPropagation(); toggleExpand(form.index); }}
                >{isExpanded ? '▲' : '▼'}</button>
              </div>
              {isExpanded && (
                <pre className="script-item__source">{form.outerHtml}</pre>
              )}
            </div>
          );
        })}
      </div>

      <div className="panel__footer">
        <button className="btn btn--danger btn--lg" onClick={handleReplace} disabled={!selected.size || replacing || !forms.length}>
          {replacing ? 'Replacing…' : `Replace ${selected.size} Form${selected.size !== 1 ? 's' : ''} with Div`}
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
        {[['scripts', '📜 Scripts'], ['head', '🔖 Head'], ['iframes', '🖼 iFrames'], ['forms', '📋 Forms'], ['unused', '🗑 Unused Files']].map(([id, label]) => (
          <button key={id} className={`clean-tab-btn ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {tab === 'scripts' && <ScriptsTab sessionId={sessionId} onDone={onDone} onSkip={onSkip} onError={onError} />}
      {tab === 'head'    && <HeadTab sessionId={sessionId} onError={onError} />}
      {tab === 'iframes' && <IframesTab sessionId={sessionId} onError={onError} />}
      {tab === 'forms'   && <FormsTab sessionId={sessionId} onError={onError} />}
      {tab === 'unused'  && <UnusedFilesTab sessionId={sessionId} onError={onError} />}
    </div>
  );
}
