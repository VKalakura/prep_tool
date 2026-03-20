import { useState, useEffect } from 'react';
import { buildOffer, getSessionStats } from '../api.js';
import axios from 'axios';

export default function BuildButton({ sessionId, uploadInfo, onError, externalReloadKey }) {
  const [building, setBuilding] = useState(false);
  const [built, setBuilt] = useState(false);
  const [stats, setStats] = useState(null);
  const [iframeKey, setIframeKey] = useState(0);

  useEffect(() => {
    if (externalReloadKey > 0) setIframeKey(k => k + 1);
  }, [externalReloadKey]);

  const refreshStats = () =>
    getSessionStats(sessionId).then((r) => setStats(r.data)).catch(() => {});

  useEffect(() => {
    if (sessionId) refreshStats();
  }, [sessionId]);

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
      // Clean up session from disk after download — no longer needed
      axios.delete(`/api/upload/${sessionId}`).catch(() => {});
    } catch (err) {
      onError(err.response?.data?.error || 'Build failed');
    } finally {
      setBuilding(false);
    }
  };

  const previewUrl = `/api/content/${sessionId}/preview-iframe?v=${iframeKey}`;

  return (
    <div className="build-page">
      <div className="build-topbar">
        <div className="build-stats">
          {uploadInfo && (
            <>
              <span className="badge">{uploadInfo.filesUploaded} uploaded</span>
              <span className="badge">{uploadInfo.indexSizeKb} KB HTML</span>
            </>
          )}
          {stats ? (
            <>
              {stats.scriptsRemoved > 0 && <span className="badge badge--green">{stats.scriptsRemoved} scripts removed</span>}
              {stats.iframesRemoved > 0 && <span className="badge badge--green">{stats.iframesRemoved} iframes removed</span>}
              {stats.unusedDeleted > 0 && <span className="badge badge--green">{stats.unusedDeleted} unused deleted</span>}
              {stats.imagesCompressed > 0 && <span className="badge badge--green">{stats.imagesCompressed} images compressed</span>}
              {stats.textSaved > 0 && <span className="badge badge--green">{stats.textSaved} edits saved</span>}
              <span className="badge">{stats.totalFiles} files · {stats.totalSizeKb} KB</span>
            </>
          ) : (
            <span className="build-stats__loading"><span className="spinner spinner--sm" /></span>
          )}
        </div>
        <div className="build-topbar__actions">
          {built && <span className="badge badge--green">ZIP downloaded ✓</span>}
          <button
            className="btn btn--primary btn--xl"
            onClick={handleBuild}
            disabled={building}
          >
            {building ? <><span className="spinner spinner--sm" /> Building…</> : 'Build & Download ZIP'}
          </button>
        </div>
      </div>

      <div className="build-previews">
        <div className="build-preview build-preview--desktop">
          <div className="build-preview__label">Desktop</div>
          <iframe
            src={previewUrl}
            className="build-preview__iframe build-preview__iframe--desktop"
            title="Desktop Preview"
          />
        </div>
        <div className="build-preview build-preview--mobile">
          <div className="build-preview__label">Mobile · 375px</div>
          <div className="build-preview__mobile-wrap">
            <iframe
              src={previewUrl}
              className="build-preview__iframe build-preview__iframe--mobile"
              title="Mobile Preview"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
