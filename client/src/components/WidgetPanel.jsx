import { useState, useEffect } from 'react';
import { getWidgets, getInsertionPoints, injectWidget } from '../api.js';

export default function WidgetPanel({ sessionId, onDone, onSkip, onError }) {
  const [widgets, setWidgets] = useState([]);
  const [points, setPoints] = useState([]);
  const [selectedWidget, setSelectedWidget] = useState(null);
  const [selectedPoint, setSelectedPoint] = useState(null);
  const [previewTab, setPreviewTab] = useState('html');
  const [loading, setLoading] = useState(true);
  const [injecting, setInjecting] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [wRes, pRes] = await Promise.all([getWidgets(), getInsertionPoints(sessionId)]);
        setWidgets(wRes.data.widgets);
        setPoints(pRes.data.points);
        if (wRes.data.widgets.length) setSelectedWidget(wRes.data.widgets[0]);
        const rec = pRes.data.points.find((p) => p.recommended) || pRes.data.points[0];
        if (rec) setSelectedPoint(rec);
      } catch (err) {
        onError(err.response?.data?.error || 'Failed to load widgets');
      } finally {
        setLoading(false);
      }
    })();
  }, [sessionId]);

  const handleInject = async () => {
    if (!selectedWidget || !selectedPoint) return;
    setInjecting(true);
    try {
      await injectWidget(sessionId, selectedWidget.id, selectedPoint.id);
      onDone();
    } catch (err) {
      onError(err.response?.data?.error || 'Injection failed');
      setInjecting(false);
    }
  };

  if (loading) return <div className="panel"><div className="loading-state"><div className="spinner" /> Loading…</div></div>;

  return (
    <div className="two-col">
      {/* Left: Widget selection */}
      <div className="panel">
        <div className="panel__header">
          <h2>Widget Library</h2>
          <p className="panel__desc">
            Pick a widget to inject into the landing page. This step is optional.
          </p>
        </div>

        <div className="widget-list">
          {widgets.map((w) => (
            <div
              key={w.id}
              className={`widget-card ${selectedWidget?.id === w.id ? 'widget-card--selected' : ''}`}
              onClick={() => { setSelectedWidget(w); setPreviewTab('html'); }}
            >
              <div className="widget-card__header">
                <strong>{w.name}</strong>
                <div className="widget-card__files">
                  {w.files.html && <span className="badge">HTML</span>}
                  {w.files.js && <span className="badge">JS</span>}
                  {w.files.css && <span className="badge">CSS</span>}
                </div>
              </div>
              {w.description && <p className="widget-card__desc">{w.description}</p>}
            </div>
          ))}
          {widgets.length === 0 && (
            <div className="empty-state">No widgets. Add folders to <code>/widgets/</code>.</div>
          )}
        </div>

        {selectedWidget && (
          <>
            <div className="panel__subheader">
              <h3>Preview — {selectedWidget.name}</h3>
              <div className="tab-bar">
                {selectedWidget.content.html && <button className={`tab-bar__btn ${previewTab === 'html' ? 'active' : ''}`} onClick={() => setPreviewTab('html')}>HTML</button>}
                {selectedWidget.content.js && <button className={`tab-bar__btn ${previewTab === 'js' ? 'active' : ''}`} onClick={() => setPreviewTab('js')}>JS</button>}
                {selectedWidget.content.css && <button className={`tab-bar__btn ${previewTab === 'css' ? 'active' : ''}`} onClick={() => setPreviewTab('css')}>CSS</button>}
              </div>
            </div>
            <pre className="code-preview code-preview--sm">
              {previewTab === 'html' && selectedWidget.content.html}
              {previewTab === 'js' && selectedWidget.content.js}
              {previewTab === 'css' && selectedWidget.content.css}
            </pre>
          </>
        )}
      </div>

      {/* Right: Insertion point */}
      <div className="panel">
        <div className="panel__header">
          <h2>Insertion Point</h2>
          <p className="panel__desc">Where should the widget be placed in the HTML?</p>
        </div>

        <div className="insertion-list">
          {points.map((p) => (
            <div
              key={p.id}
              className={`insertion-item ${selectedPoint?.id === p.id ? 'insertion-item--selected' : ''} ${p.recommended ? 'insertion-item--recommended' : ''}`}
              onClick={() => setSelectedPoint(p)}
            >
              <div className="insertion-item__header">
                <input type="radio" readOnly checked={selectedPoint?.id === p.id} />
                <strong>{p.label}</strong>
                {p.recommended && <span className="badge badge--green">Recommended</span>}
              </div>
              <p className="insertion-item__desc">{p.description}</p>
            </div>
          ))}
          {points.length === 0 && <div className="empty-state">No insertion points detected.</div>}
        </div>

        <div className="panel__footer">
          <button
            className="btn btn--primary btn--lg"
            onClick={handleInject}
            disabled={!selectedWidget || !selectedPoint || injecting}
          >
            {injecting ? 'Injecting…' : `Inject "${selectedWidget?.name}" & Continue →`}
          </button>
          <button className="btn btn--lg" onClick={onSkip}>
            Skip →
          </button>
        </div>
      </div>
    </div>
  );
}
