import { useState, useEffect } from 'react';
import { getDevSessions } from '../api.js';

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function SessionList() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getDevSessions()
      .then(r => setSessions(r.data.sessions))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const openSession = (sid) => {
    window.location.href = `/dev?dev=${sid}`;
  };

  return (
    <div className="session-list-page">
      <div className="session-list-page__header">
        <a href="/dev" className="btn btn--sm">← New offer</a>
        <h2>Active Sessions</h2>
        <button className="btn btn--sm" onClick={() => {
          setLoading(true);
          getDevSessions().then(r => setSessions(r.data.sessions)).finally(() => setLoading(false));
        }}>↺ Refresh</button>
      </div>

      {loading ? (
        <div className="loading-state"><div className="spinner" /> Loading sessions…</div>
      ) : sessions.length === 0 ? (
        <div className="empty-state" style={{ marginTop: 60 }}>No active sessions found.</div>
      ) : (
        <div className="session-table">
          <div className="session-table__head">
            <span>Session ID</span>
            <span>Offer</span>
            <span>Country</span>
            <span>Files</span>
            <span>Last active</span>
            <span></span>
          </div>
          {sessions.map(s => (
            <div key={s.sessionId} className="session-table__row" onClick={() => openSession(s.sessionId)}>
              <span><code style={{ fontSize: 12 }}>{s.sessionId}</code></span>
              <span>{s.offerName || <span style={{ color: 'var(--text-muted)' }}>—</span>}</span>
              <span>{s.countryCode ? <span className="badge">{s.countryCode}</span> : <span style={{ color: 'var(--text-muted)' }}>—</span>}</span>
              <span><span className="badge">{s.fileCount} files</span></span>
              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{timeAgo(s.lastActivity)}</span>
              <span><button className="btn btn--sm btn--primary" onClick={e => { e.stopPropagation(); openSession(s.sessionId); }}>Open →</button></span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
