import { useState, useEffect } from 'react';
import { getSendPhpTemplate, previewSendPhp } from '../api.js';

export default function SendPhpEditor({ sessionId, onDone, onError }) {
  const [template, setTemplate] = useState('');
  const [preview, setPreview] = useState('');
  const [activeTab, setActiveTab] = useState('template');
  const [loading, setLoading] = useState(true);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const res = await getSendPhpTemplate(sessionId);
        setTemplate(res.data.template);
      } catch (err) {
        onError(err.response?.data?.error || 'Failed to load template');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [sessionId]);

  const handlePreview = async () => {
    setPreviewing(true);
    try {
      const res = await previewSendPhp(sessionId, template);
      setPreview(res.data.content);
      setActiveTab('preview');
    } catch (err) {
      onError(err.response?.data?.error || 'Preview failed');
    } finally {
      setPreviewing(false);
    }
  };

  if (loading) return <div className="panel"><div className="loading-state"><div className="spinner" /> Loading…</div></div>;

  return (
    <div className="panel panel--wide">
      <div className="panel__header">
        <h2>send.php Template</h2>
        <p className="panel__desc">
          This template is used to generate <code>send.php</code> when you build your
          offer. The <code>%%GEO_CONFIG%%</code> placeholder is automatically replaced
          with the PHP array from your Geo Config.
        </p>
        <div className="tab-bar" style={{ marginTop: 12 }}>
          <button
            className={`tab-bar__btn ${activeTab === 'template' ? 'active' : ''}`}
            onClick={() => setActiveTab('template')}
          >
            Template
          </button>
          <button
            className={`tab-bar__btn ${activeTab === 'preview' ? 'active' : ''}`}
            onClick={preview ? () => setActiveTab('preview') : handlePreview}
          >
            {previewing ? 'Generating…' : 'Preview Generated'}
          </button>
        </div>
      </div>

      {activeTab === 'template' ? (
        <textarea
          className="code-editor code-editor--lg"
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          spellCheck={false}
        />
      ) : (
        <pre className="code-preview code-preview--lg">
          {preview || 'Click "Preview Generated" to see the output.'}
        </pre>
      )}

      <div className="panel__footer">
        <button
          className="btn btn--primary"
          onClick={handlePreview}
          disabled={previewing}
        >
          {previewing ? 'Generating…' : 'Preview with Current Geo Config'}
        </button>
        <p className="panel__hint">
          The final send.php is generated when you click <strong>Build Offer</strong>.
          Changes to this template are used in that build step.
        </p>
      </div>
    </div>
  );
}
