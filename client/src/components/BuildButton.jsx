import { useState, useEffect } from 'react';
import { buildOffer, getFileTree } from '../api.js';

function FileTree({ nodes, depth = 0 }) {
  if (!nodes?.length) return null;
  return (
    <ul className={`file-tree ${depth === 0 ? 'file-tree--root' : ''}`}>
      {nodes.map((n) => (
        <li key={n.path} className={`file-tree__item file-tree__item--${n.type}`}>
          <span className="file-tree__icon">{n.type === 'dir' ? '📁' : '📄'}</span>
          <span className="file-tree__name">{n.name}</span>
          {n.size != null && <span className="file-tree__size">{Math.round(n.size / 1024)} KB</span>}
          {n.children && <FileTree nodes={n.children} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

export default function BuildButton({ sessionId, uploadInfo, onError }) {
  const [building, setBuilding] = useState(false);
  const [built, setBuilt] = useState(false);
  const [fileTree, setFileTree] = useState(null);

  const refreshTree = () =>
    getFileTree(sessionId).then((r) => setFileTree(r.data.tree)).catch(() => {});

  useEffect(() => { if (sessionId) refreshTree(); }, [sessionId]);

  const handleBuild = async () => {
    setBuilding(true);
    try {
      const res = await buildOffer(sessionId);
      const url = window.URL.createObjectURL(new Blob([res.data], { type: 'application/zip' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `offer-${sessionId.slice(0, 8)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      setBuilt(true);
      refreshTree();
    } catch (err) {
      onError(err.response?.data?.error || 'Build failed');
    } finally {
      setBuilding(false);
    }
  };

  return (
    <div className="two-col">
      <div className="panel">
        <div className="panel__header">
          <h2>Build Offer</h2>
          <p className="panel__desc">
            Package all files into a ready-to-deploy ZIP archive.
          </p>
        </div>

        <div className="build-summary">
          {uploadInfo && (
            <>
              <div className="build-summary__row">
                <span>Files uploaded</span>
                <strong>{uploadInfo.filesUploaded}</strong>
              </div>
              <div className="build-summary__row">
                <span>Original HTML size</span>
                <strong>{uploadInfo.indexSizeKb} KB</strong>
              </div>
              <div className="build-summary__row">
                <span>Moved to normalized dirs</span>
                <strong>{uploadInfo.normalization?.moved ?? '—'}</strong>
              </div>
              <div className="build-summary__row">
                <span>Unused files removed</span>
                <strong>{uploadInfo.normalization?.removed ?? '—'}</strong>
              </div>
            </>
          )}
        </div>

        <div className="build-checklist">
          <h3>ZIP contents:</h3>
          <ul>
            <li>✅ index.php (with all PHP includes injected)</li>
            <li>✅ send.php (Keitaro format, auto-generated)</li>
            <li>✅ js/ — all JavaScript files</li>
            <li>✅ css/ — all stylesheets (paths updated)</li>
            <li>✅ fonts/ — all font files</li>
            <li>✅ img/ — all images</li>
          </ul>
        </div>

        <div className="panel__footer" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          {built && (
            <div className="success-banner">
              ZIP downloaded. Your offer is ready to deploy.
            </div>
          )}
          <button
            className="btn btn--primary btn--xl"
            onClick={handleBuild}
            disabled={building}
          >
            {building ? <><span className="spinner spinner--sm" /> Building…</> : 'Build & Download ZIP'}
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="panel__header">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h2>File Tree</h2>
            <button className="btn btn--sm" onClick={refreshTree}>Refresh</button>
          </div>
          <p className="panel__desc">Current normalized structure in this session.</p>
        </div>
        {fileTree
          ? <FileTree nodes={fileTree} />
          : <div className="loading-state"><div className="spinner" /> Loading…</div>
        }
      </div>
    </div>
  );
}
