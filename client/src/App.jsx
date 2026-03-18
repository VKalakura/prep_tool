import { useState, useCallback } from 'react';
import FolderUpload from './components/FolderUpload.jsx';
import ScriptCleaner from './components/ScriptCleaner.jsx';
import ContentEditor from './components/ContentEditor.jsx';
import WidgetPanel from './components/WidgetPanel.jsx';
import PhpIntegration from './components/PhpIntegration.jsx';
import BuildButton from './components/BuildButton.jsx';
import DevPanel from './components/DevPanel.jsx';

function generateId() {
  return Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
}

const STEPS = [
  { id: 'upload',  label: '1. Upload' },
  { id: 'clean',   label: '2. Clean' },
  { id: 'content', label: '3. Content' },
  { id: 'widgets', label: '4. Widgets' },
  { id: 'php',     label: '5. PHP' },
  { id: 'build',   label: '6. Build' },
];

// Check for dev mode: ?dev=SESSION_ID
const devSession = new URLSearchParams(window.location.search).get('dev');

export default function App() {
  const [sessionId] = useState(() => generateId());
  const [step, setStep] = useState('upload');
  const [uploadInfo, setUploadInfo] = useState(null);
  const [notification, setNotification] = useState(null);

  const notify = useCallback((msg, type = 'success') => {
    setNotification({ msg, type });
    setTimeout(() => setNotification(null), 5000);
  }, []);

  const goTo = useCallback((s) => setStep(s), []);

  // Dev mode — bypass normal UI
  if (devSession) return <DevPanel sessionId={devSession} />;

  const handleUploadComplete = (info) => {
    setUploadInfo(info);
    setStep('clean');
    const n = info.normalization;
    notify(
      `Found index.html · Moved ${n.moved} files` +
      (n.warnings?.length ? ` · ⚠ ${n.warnings.length} warnings` : '') +
      (info.formatted ? ' · Formatted ✓' : '')
    );
  };

  const isEnabled = (stepId) => stepId === 'upload' || !!uploadInfo;

  const handleShare = () => {
    const url = `${window.location.origin}/?dev=${sessionId}`;
    navigator.clipboard?.writeText(url).then(() => notify(`Dev link copied: ${sessionId}`));
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header__inner">
          <h1 className="app-header__title">
            <span>🛠</span> Offer Prep Tool
          </h1>
          {uploadInfo ? (
            <div className="app-header__session">
              <span>Session: <code>{sessionId}</code></span>
              <span className="badge">{uploadInfo.filesUploaded} files</span>
              <span className="badge badge--blue">{uploadInfo.indexSizeKb} KB</span>
              <button className="btn btn--sm" onClick={handleShare} title="Copy dev access link">Share Session</button>
            </div>
          ) : null}
        </div>
      </header>

      <nav className="step-nav">
        {STEPS.map((s) => (
          <button
            key={s.id}
            className={`step-nav__btn ${step === s.id ? 'active' : ''} ${!isEnabled(s.id) ? 'disabled' : ''}`}
            onClick={() => isEnabled(s.id) && setStep(s.id)}
            disabled={!isEnabled(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>

      {notification && (
        <div className={`notification notification--${notification.type}`}>{notification.msg}</div>
      )}

      <main className="app-main">
        {step === 'upload' && (
          <FolderUpload sessionId={sessionId} onComplete={handleUploadComplete} onError={e => notify(e, 'error')} />
        )}
        {step === 'clean' && (
          <ScriptCleaner
            sessionId={sessionId}
            onDone={() => { notify('Clean complete'); goTo('content'); }}
            onSkip={() => goTo('content')}
            onError={e => notify(e, 'error')}
          />
        )}
        {step === 'content' && (
          <ContentEditor
            sessionId={sessionId}
            onDone={() => { notify('Content saved'); goTo('widgets'); }}
            onSkip={() => goTo('widgets')}
            onError={e => notify(e, 'error')}
          />
        )}
        {step === 'widgets' && (
          <WidgetPanel
            sessionId={sessionId}
            onDone={() => { notify('Widget injected'); goTo('php'); }}
            onSkip={() => goTo('php')}
            onError={e => notify(e, 'error')}
          />
        )}
        {step === 'php' && (
          <PhpIntegration
            sessionId={sessionId}
            onDone={msg => { notify(msg); goTo('build'); }}
            onError={e => notify(e, 'error')}
          />
        )}
        {step === 'build' && (
          <BuildButton sessionId={sessionId} uploadInfo={uploadInfo} onError={e => notify(e, 'error')} />
        )}
      </main>
    </div>
  );
}
