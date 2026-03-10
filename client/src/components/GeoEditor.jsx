import { useState, useEffect } from 'react';
import { getGeoConfig, saveGeoConfig, addGeoEntry, deleteGeoEntry } from '../api.js';

export default function GeoEditor({ onDone, onError }) {
  const [config, setConfig] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newCode, setNewCode] = useState('');
  const [newEndpoint, setNewEndpoint] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [addMode, setAddMode] = useState(false);
  const [editRaw, setEditRaw] = useState(false);
  const [rawJson, setRawJson] = useState('');
  const [rawError, setRawError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const res = await getGeoConfig();
      setConfig(res.data.config);
      setRawJson(JSON.stringify(res.data.config, null, 2));
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to load geo config');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveGeoConfig(config);
      onDone();
    } catch (err) {
      onError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveRaw = async () => {
    setRawError('');
    let parsed;
    try {
      parsed = JSON.parse(rawJson);
    } catch (e) {
      setRawError('Invalid JSON: ' + e.message);
      return;
    }
    setSaving(true);
    try {
      const res = await saveGeoConfig(parsed);
      setConfig(res.data.config);
      onDone();
      setEditRaw(false);
    } catch (err) {
      onError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleAdd = async () => {
    if (!newCode.trim() || !newEndpoint.trim()) return;
    try {
      const res = await addGeoEntry(newCode.trim(), newEndpoint.trim(), newLabel.trim());
      setConfig(res.data.config);
      setRawJson(JSON.stringify(res.data.config, null, 2));
      setNewCode(''); setNewEndpoint(''); setNewLabel('');
      setAddMode(false);
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to add entry');
    }
  };

  const handleDelete = async (code) => {
    if (!confirm(`Delete GEO entry "${code}"?`)) return;
    try {
      const res = await deleteGeoEntry(code);
      setConfig(res.data.config);
      setRawJson(JSON.stringify(res.data.config, null, 2));
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to delete entry');
    }
  };

  const updateEntry = (code, field, value) => {
    setConfig((prev) => ({
      ...prev,
      [code]: { ...prev[code], [field]: value },
    }));
  };

  if (loading) return <div className="panel"><div className="loading-state"><div className="spinner" /> Loading…</div></div>;

  return (
    <div className="panel panel--wide">
      <div className="panel__header">
        <h2>Geo Configuration</h2>
        <p className="panel__desc">
          Map country codes to their respective endpoints. The generated{' '}
          <code>send.php</code> will route form submissions based on the visitor's geo.
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="btn btn--sm" onClick={() => setEditRaw(!editRaw)}>
            {editRaw ? 'Table View' : 'Edit JSON'}
          </button>
          <button className="btn btn--sm btn--primary" onClick={() => setAddMode(!addMode)}>
            + Add Entry
          </button>
        </div>
      </div>

      {addMode && (
        <div className="add-entry-form">
          <input
            className="input"
            placeholder="Country code (e.g. AU)"
            value={newCode}
            onChange={(e) => setNewCode(e.target.value.toUpperCase())}
            maxLength={10}
          />
          <input
            className="input input--wide"
            placeholder="Endpoint URL"
            value={newEndpoint}
            onChange={(e) => setNewEndpoint(e.target.value)}
          />
          <input
            className="input"
            placeholder="Label (optional)"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
          />
          <button className="btn btn--primary" onClick={handleAdd}>Add</button>
          <button className="btn" onClick={() => setAddMode(false)}>Cancel</button>
        </div>
      )}

      {editRaw ? (
        <div className="raw-editor">
          <textarea
            className="code-editor"
            value={rawJson}
            onChange={(e) => setRawJson(e.target.value)}
            spellCheck={false}
          />
          {rawError && <div className="error-msg">{rawError}</div>}
          <div className="panel__footer">
            <button className="btn btn--primary btn--lg" onClick={handleSaveRaw} disabled={saving}>
              {saving ? 'Saving…' : 'Save JSON'}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="geo-table">
            <div className="geo-table__header">
              <span>Code</span>
              <span>Label</span>
              <span>Endpoint</span>
              <span>Actions</span>
            </div>
            {Object.entries(config).map(([code, entry]) => (
              <div key={code} className="geo-table__row">
                <code className="geo-code">{code}</code>
                <input
                  className="input input--sm"
                  value={entry.label || ''}
                  onChange={(e) => updateEntry(code, 'label', e.target.value)}
                  placeholder="Label"
                />
                <input
                  className="input input--wide"
                  value={entry.endpoint || ''}
                  onChange={(e) => updateEntry(code, 'endpoint', e.target.value)}
                  placeholder="https://..."
                />
                <button
                  className="btn btn--sm btn--danger"
                  onClick={() => handleDelete(code)}
                >
                  Delete
                </button>
              </div>
            ))}
            {Object.keys(config).length === 0 && (
              <div className="empty-state">No geo entries. Click "+ Add Entry" to start.</div>
            )}
          </div>

          <div className="panel__footer">
            <button
              className="btn btn--primary btn--lg"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save Geo Config'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
