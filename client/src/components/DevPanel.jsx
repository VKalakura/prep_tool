import { useState, useEffect, useRef, useCallback } from 'react';
import MonacoEditor from '@monaco-editor/react';
import { getDevState, getDevFile, saveDevFile, buildOffer, cloneOriginals, getRemovedScripts, restoreScript } from '../api.js';

function FileTree({ nodes, onSelect, selectedPath }) {
  if (!nodes?.length) return null;
  return (
    <ul className="file-tree">
      {nodes.map(node => (
        <li key={node.path}>
          {node.type === 'dir' ? (
            <>
              <div className="file-tree__item file-tree__item--dir">
                <span className="file-tree__icon">📁</span>
                <span className="file-tree__name">{node.name}/</span>
              </div>
              <FileTree nodes={node.children} onSelect={onSelect} selectedPath={selectedPath} />
            </>
          ) : (
            <div
              className={`file-tree__item ${selectedPath === node.path ? 'file-tree__item--active' : ''}`}
              style={{ cursor: 'pointer' }}
              onClick={() => onSelect(node)}
            >
              <span className="file-tree__icon">📄</span>
              <span className="file-tree__name">{node.name}</span>
              <span className="file-tree__size">{node.size > 1024 ? `${(node.size/1024).toFixed(1)}KB` : `${node.size}B`}</span>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

// ─── Removed Scripts tab ──────────────────────────────────────────────────────
function RemovedScriptsTab({ sessionId }) {
  const [scripts, setScripts] = useState(null);
  const [restoring, setRestoring] = useState(null); // scriptId being restored
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    getRemovedScripts(sessionId)
      .then(res => setScripts(res.data.scripts))
      .catch(() => setScripts([]));
  }, [sessionId]);

  useEffect(() => { load(); }, [load]);

  const handleRestore = async (script) => {
    setRestoring(script.id);
    setMsg('');
    try {
      const res = await restoreScript(sessionId, script.id);
      setMsg(res.data.fileRestored
        ? `✓ Restored ${script.src || '(inline)'} and its JS file`
        : `✓ Restored ${script.src || '(inline)'} (no JS file to restore)`
      );
      load();
    } catch (err) {
      setMsg('Error: ' + (err.response?.data?.error || 'Restore failed'));
    } finally {
      setRestoring(null);
    }
  };

  if (scripts === null) return <div className="loading-state"><div className="spinner" /> Loading…</div>;

  return (
    <div style={{ padding: 20 }}>
      {msg && (
        <div style={{ marginBottom: 12, padding: '8px 12px', background: 'var(--bg-panel-2)', borderRadius: 6, fontSize: 13, color: 'var(--success)' }}>
          {msg}
        </div>
      )}
      {scripts.length === 0 ? (
        <div className="empty-state">No removed scripts recorded for this session.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {scripts.map(script => (
            <div key={script.id} style={{ background: 'var(--bg-panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                {script.isInteractive && (
                  <span className="badge badge--yellow" title="This script referenced DOM elements — it may be needed for interactive functionality">⚡ Interactive</span>
                )}
                {script.src
                  ? <code style={{ fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{script.src}</code>
                  : <code style={{ fontSize: 12, color: 'var(--text-muted)' }}>(inline script)</code>
                }
                {script.deletedFile && (
                  <span className="badge" title={`JS file deleted: ${script.deletedFile}`}>🗑 file</span>
                )}
                <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                  {new Date(script.removedAt).toLocaleTimeString()}
                </span>
                <button
                  className="btn btn--sm btn--primary"
                  onClick={() => handleRestore(script)}
                  disabled={restoring === script.id}
                  title="Restore this script to the current HTML (and its JS file if available)"
                >
                  {restoring === script.id ? '…' : '↩ Restore'}
                </button>
              </div>
              {(script.inlineContent) && (
                <pre style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 80, overflow: 'hidden' }}>
                  {script.inlineContent.slice(0, 300)}{script.inlineContent.length > 300 ? '…' : ''}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function DevPanel({ sessionId }) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileContent, setFileContent] = useState('');
  const [fileLoading, setFileLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [tab, setTab] = useState('files');
  const [cloning, setCloning] = useState(false);
  const [cloneError, setCloneError] = useState('');
  const [removedScriptsCount, setRemovedScriptsCount] = useState(null);
  const previewWinRef = useRef(null);

  useEffect(() => {
    setLoading(true);
    getDevState(sessionId)
      .then(res => setState(res.data))
      .catch(err => setError(err.response?.data?.error || 'Session not found'))
      .finally(() => setLoading(false));
    // Load removed scripts count for tab badge
    getRemovedScripts(sessionId)
      .then(res => setRemovedScriptsCount(res.data.scripts.length))
      .catch(() => setRemovedScriptsCount(0));
  }, [sessionId]);

  const handleSelectFile = async (node) => {
    setSelectedFile(node);
    setFileContent('');
    setFileLoading(true);
    setSaveMsg('');
    try {
      const res = await getDevFile(sessionId, node.path);
      setFileContent(res.data.content);
    } catch (err) {
      setFileContent(`// Error: ${err.response?.data?.error || 'Cannot read file'}`);
    } finally {
      setFileLoading(false);
    }
  };

  const handleSave = async () => {
    if (!selectedFile) return;
    setSaving(true);
    try {
      await saveDevFile(sessionId, selectedFile.path, fileContent);
      setSaveMsg('Saved ✓');
      setTimeout(() => setSaveMsg(''), 3000);
    } catch (err) {
      setSaveMsg('Error: ' + (err.response?.data?.error || 'Failed'));
    } finally {
      setSaving(false);
    }
  };

  const handleStartPipeline = async () => {
    setCloning(true);
    setCloneError('');
    try {
      const res = await cloneOriginals(sessionId);
      const newSid = res.data.sessionId;
      window.location.href = `/dev?clone=${newSid}&buyer=${sessionId}`;
    } catch (err) {
      setCloneError(err.response?.data?.error || 'Failed to clone originals');
      setCloning(false);
    }
  };

  const handleDownload = async () => {
    try {
      const res = await buildOffer(sessionId);
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `offer-${sessionId}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {}
  };

  const handleOpenPreview = () => {
    const url = `/dev?preview=${sessionId}`;
    if (previewWinRef.current && !previewWinRef.current.closed) {
      previewWinRef.current.focus();
    } else {
      previewWinRef.current = window.open(url, 'ept-preview-' + sessionId);
    }
  };

  const fmtTime = (ts) => {
    if (!ts) return '—';
    return new Date(ts).toLocaleString();
  };

  if (loading) {
    return (
      <div className="dev-panel">
        <div className="dev-panel__header"><h1>Dev Access</h1></div>
        <div className="loading-state"><div className="spinner" /> Loading session…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dev-panel">
        <div className="dev-panel__header"><h1>Dev Access</h1></div>
        <div className="dev-panel__error">
          <p>Session <code>{sessionId}</code> not found or has expired.</p>
          <p style={{ marginTop: 8, color: 'var(--text-muted)', fontSize: 12 }}>{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="dev-panel">
      <div className="dev-panel__header">
        <div>
          <h1>Dev Access — <code>{sessionId}</code></h1>
          <div className="dev-panel__meta">
            <span>Created: {fmtTime(state.createdAt)}</span>
            <span>Last active: {fmtTime(state.lastActivity)}</span>
            {state.config?.offerName && <span>Offer: <strong>{state.config.offerName}</strong></span>}
            {state.config?.countryCode && <span>Country: <strong>{state.config.countryCode}</strong></span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexDirection: 'column', alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn--primary" onClick={handleStartPipeline} disabled={cloning} title="Start full dev pipeline from the original uploaded files (before any cleaning)">
              {cloning ? 'Cloning…' : '▶ Start full pipeline'}
            </button>
            <button className="btn" onClick={handleOpenPreview} title="Open live preview in a new tab">👁 Preview</button>
            <button className="btn" onClick={handleDownload}>⬇ Download ZIP</button>
          </div>
          {cloneError && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{cloneError}</span>}
        </div>
      </div>

      <div className="clean-tabs" style={{ borderTop: '1px solid var(--border)' }}>
        {[
          ['files', '📁 Files'],
          ['removed', removedScriptsCount ? `🗑 Removed Scripts (${removedScriptsCount})` : '🗑 Removed Scripts'],
          ['log', '📋 Activity Log'],
          ['config', '⚙️ Config'],
        ].map(([id, label]) => (
          <button
            key={id}
            className={`clean-tab-btn ${tab === id ? 'active' : ''} ${id === 'removed' && removedScriptsCount > 0 ? 'clean-tab-btn--warn' : ''}`}
            onClick={() => setTab(id)}
          >{label}</button>
        ))}
      </div>

      {tab === 'files' && (
        <div className="dev-panel__files">
          <div className="dev-panel__tree">
            <FileTree nodes={state.tree} onSelect={handleSelectFile} selectedPath={selectedFile?.path} />
          </div>
          <div className="dev-panel__editor">
            {!selectedFile ? (
              <div className="dev-panel__editor-empty">Select a file to view and edit</div>
            ) : (
              <>
                <div className="dev-panel__editor-bar">
                  <code style={{ fontSize: 12 }}>{selectedFile.path}</code>
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--success)' }}>{saveMsg}</span>
                  <button className="btn btn--sm btn--primary" onClick={handleSave} disabled={saving || fileLoading}>
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
                {fileLoading ? (
                  <div className="loading-state"><div className="spinner" /></div>
                ) : (
                  <MonacoEditor
                    height="100%"
                    language={(() => {
                      const ext = selectedFile.path.split('.').pop().toLowerCase();
                      return { html: 'html', css: 'css', js: 'javascript', php: 'php', json: 'json' }[ext] || 'plaintext';
                    })()}
                    value={fileContent}
                    onChange={val => setFileContent(val || '')}
                    theme="vs-dark"
                    options={{
                      fontSize: 13,
                      minimap: { enabled: false },
                      wordWrap: 'off',
                      scrollBeyondLastLine: false,
                      automaticLayout: true,
                      tabSize: 2,
                    }}
                  />
                )}
              </>
            )}
          </div>
        </div>
      )}

      {tab === 'removed' && <RemovedScriptsTab sessionId={sessionId} />}

      {tab === 'log' && (
        <div style={{ padding: 20 }}>
          {!state.log?.length ? (
            <div className="empty-state">No activity recorded yet.</div>
          ) : (
            <div className="dev-log">
              {[...state.log].reverse().map((entry, i) => (
                <div key={i} className="dev-log__entry">
                  <span className="dev-log__time">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                  <span className="badge">{entry.action}</span>
                  <span className="dev-log__details">
                    {Object.entries(entry)
                      .filter(([k]) => !['timestamp', 'action'].includes(k))
                      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
                      .join(' · ')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'config' && (
        <div style={{ padding: 20 }}>
          {!state.config || !Object.keys(state.config).length ? (
            <div className="empty-state">No config saved yet (PHP step not completed).</div>
          ) : (
            <div className="dev-config">
              {Object.entries(state.config).map(([k, v]) => (
                <div key={k} className="build-summary__row">
                  <span>{k}</span>
                  <code>{String(v)}</code>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
