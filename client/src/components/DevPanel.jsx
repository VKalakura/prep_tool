import { useState, useEffect } from 'react';
import { getDevState, getDevFile, saveDevFile, buildOffer } from '../api.js';

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

  useEffect(() => {
    setLoading(true);
    getDevState(sessionId)
      .then(res => setState(res.data))
      .catch(err => setError(err.response?.data?.error || 'Session not found'))
      .finally(() => setLoading(false));
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
        <button className="btn btn--primary" onClick={handleDownload}>⬇ Download ZIP</button>
      </div>

      <div className="clean-tabs" style={{ borderTop: '1px solid var(--border)' }}>
        {[['files', '📁 Files'], ['log', '📋 Activity Log'], ['config', '⚙️ Config']].map(([id, label]) => (
          <button key={id} className={`clean-tab-btn ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>{label}</button>
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
                  <textarea
                    className="code-editor code-editor--lg"
                    value={fileContent}
                    onChange={e => setFileContent(e.target.value)}
                    spellCheck={false}
                  />
                )}
              </>
            )}
          </div>
        </div>
      )}

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
