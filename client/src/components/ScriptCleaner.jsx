import { useState, useEffect } from 'react';
import { getScripts, cleanScripts } from '../api.js';

export default function ScriptCleaner({ sessionId, onDone, onSkip, onError }) {
  const [scripts, setScripts] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [cleaning, setCleaning] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await getScripts(sessionId);
      const s = res.data.scripts;
      setScripts(s);
      // Auto-select all tracking scripts
      setSelected(new Set(s.filter((sc) => sc.suggestion === 'remove').map((sc) => sc.index)));
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to load scripts');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [sessionId]);

  const toggle = (index) =>
    setSelected((prev) => { const n = new Set(prev); n.has(index) ? n.delete(index) : n.add(index); return n; });

  const selectAll = () => setSelected(new Set(scripts.map((s) => s.index)));
  const selectTracking = () => setSelected(new Set(scripts.filter((s) => s.suggestion === 'remove').map((s) => s.index)));
  const clearAll = () => setSelected(new Set());

  const handleClean = async () => {
    if (selected.size === 0) return;
    setCleaning(true);
    try {
      await cleanScripts(sessionId, Array.from(selected));
      onDone(); // advances to next step
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to clean scripts');
      setCleaning(false);
    }
  };

  const trackingCount = scripts.filter((s) => s.suggestion === 'remove').length;
  const criticalCount = scripts.filter((s) => s.suggestion === 'keep').length;
  const otherCount = scripts.length - trackingCount - criticalCount;

  const badgeFor = (s) => {
    if (s.suggestion === 'remove') return <span className="badge badge--red">Tracking</span>;
    if (s.suggestion === 'keep') return <span className="badge badge--green">Critical</span>;
    return <span className="badge">Unknown</span>;
  };

  return (
    <div className="panel panel--wide">
      <div className="panel__header">
        <h2>Script Cleaner</h2>
        <p className="panel__desc">
          Review all <code>&lt;script&gt;</code> tags. Tracking scripts are pre-selected.
          Tick what you want to remove, then confirm.
        </p>
      </div>

      {loading ? (
        <div className="loading-state"><div className="spinner" /> Scanning scripts…</div>
      ) : (
        <>
          <div className="script-stats">
            <div className="stat stat--red">
              <span className="stat__num">{trackingCount}</span>
              <span className="stat__label">Tracking</span>
            </div>
            <div className="stat">
              <span className="stat__num">{otherCount}</span>
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
            <button className="btn btn--sm btn--danger" onClick={selectTracking}>
              Select Tracking
            </button>
            <button className="btn btn--sm" onClick={selectAll}>
              Select All
            </button>
            <button className="btn btn--sm" onClick={clearAll}>
              Clear
            </button>
            <span className="toolbar__count">{selected.size} selected for removal</span>
          </div>

          <div className="script-list">
            {scripts.length === 0 && (
              <div className="empty-state">No scripts found in index.html.</div>
            )}
            {scripts.map((script) => {
              const isSelected = selected.has(script.index);
              return (
                <div
                  key={script.id}
                  className={`script-item ${isSelected ? 'script-item--selected' : ''} ${script.suggestion === 'keep' ? 'script-item--critical' : ''}`}
                  onClick={() => toggle(script.index)}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggle(script.index)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <div className="script-item__body">
                    {script.src
                      ? <code>{script.src}</code>
                      : <code className="script-item__inline">(inline) {script.inline?.slice(0, 100)}{script.inline?.length > 100 ? '…' : ''}</code>
                    }
                  </div>
                  {badgeFor(script)}
                </div>
              );
            })}
          </div>

          <div className="panel__footer">
            <button
              className="btn btn--danger btn--lg"
              onClick={handleClean}
              disabled={selected.size === 0 || cleaning}
            >
              {cleaning ? 'Removing…' : `Remove ${selected.size} Script${selected.size !== 1 ? 's' : ''} & Continue →`}
            </button>
            <button className="btn btn--lg" onClick={onSkip}>
              Skip →
            </button>
          </div>
        </>
      )}
    </div>
  );
}
