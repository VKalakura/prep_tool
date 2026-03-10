import { useState, useEffect } from 'react';
import { getHtml, saveHtml } from '../api.js';

export default function HtmlPreview({ sessionId }) {
  const [content, setContent] = useState('');
  const [editContent, setEditContent] = useState('');
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await getHtml(sessionId);
      setContent(res.data.content);
      setEditContent(res.data.content);
      setMeta({ size: res.data.size, lines: res.data.lines });
    } catch {
      setContent('// Could not load HTML');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [sessionId]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveHtml(sessionId, editContent);
      setContent(editContent);
      setSaved(true);
      setEditing(false);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="panel panel--preview">
      <div className="panel__header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2>HTML Preview</h2>
          {meta && (
            <span className="badge">
              {meta.lines.toLocaleString()} lines / {Math.round(meta.size / 1024)} KB
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {editing ? (
            <>
              <button className="btn btn--sm" onClick={() => setEditing(false)}>Cancel</button>
              <button className="btn btn--sm btn--primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          ) : (
            <>
              <button className="btn btn--sm" onClick={load}>Refresh</button>
              <button className="btn btn--sm btn--primary" onClick={() => setEditing(true)}>
                Edit HTML
              </button>
            </>
          )}
          {saved && <span className="badge badge--green">Saved!</span>}
        </div>
      </div>

      {loading ? (
        <div className="loading-state">
          <div className="spinner" /> Loading HTML…
        </div>
      ) : editing ? (
        <textarea
          className="code-editor"
          value={editContent}
          onChange={(e) => setEditContent(e.target.value)}
          spellCheck={false}
        />
      ) : (
        <pre className="code-preview">{content}</pre>
      )}
    </div>
  );
}
