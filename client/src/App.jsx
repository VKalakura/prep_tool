import { useState, useCallback } from 'react';
import FolderUpload from './components/FolderUpload.jsx';
import ScriptCleaner from './components/ScriptCleaner.jsx';
import WidgetPanel from './components/WidgetPanel.jsx';
import PhpIntegration from './components/PhpIntegration.jsx';
import BuildButton from './components/BuildButton.jsx';

function generateId() {
  return Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
}

const STEPS = [
  { id: 'upload',  label: '1. Upload' },
  { id: 'scripts', label: '2. Script Cleaner' },
  { id: 'widgets', label: '3. Widgets' },
  { id: 'php',     label: '4. PHP Integration' },
  { id: 'build',   label: '5. Build Offer' },
];

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

  const handleUploadComplete = (info) => {
    setUploadInfo(info);
    setStep('scripts');
    const n = info.normalization;
    const fmtMsg = info.formatted === true
      ? ' · Auto-formatting successful'
      : ' · Auto-formatting failed';
    notify(
      `Found index.html · Moved ${n.moved} files · Removed ${n.removed} unused files` +
      (n.warnings?.length ? ` · ⚠ ${n.warnings.length} warnings` : '') +
      fmtMsg
    );
  };

  const isEnabled = (stepId) => {
    if (!uploadInfo && stepId !== 'upload') return false;
    return true;
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header__inner">
          <h1 className="app-header__title">
            <span>🛠</span> Offer Prep Tool
          </h1>
          {uploadInfo && (
            <div className="app-header__session">
              <span>Session: <code>{sessionId}</code></span>
              <span className="badge">{uploadInfo.filesUploaded} files</span>
              <span className="badge badge--blue">{uploadInfo.indexSizeKb} KB</span>
            </div>
          )}
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
        <div className={`notification notification--${notification.type}`}>
          {notification.msg}
        </div>
      )}

      <main className="app-main">
        {step === 'upload' && (
          <FolderUpload
            sessionId={sessionId}
            onComplete={handleUploadComplete}
            onError={(e) => notify(e, 'error')}
          />
        )}

        {step === 'scripts' && (
          <ScriptCleaner
            sessionId={sessionId}
            onDone={() => { notify('Scripts cleaned'); goTo('widgets'); }}
            onSkip={() => goTo('widgets')}
            onError={(e) => notify(e, 'error')}
          />
        )}

        {step === 'widgets' && (
          <WidgetPanel
            sessionId={sessionId}
            onDone={() => { notify('Widget injected'); goTo('php'); }}
            onSkip={() => goTo('php')}
            onError={(e) => notify(e, 'error')}
          />
        )}

        {step === 'php' && (
          <PhpIntegration
            sessionId={sessionId}
            onDone={(msg) => { notify(msg); goTo('build'); }}
            onError={(e) => notify(e, 'error')}
          />
        )}

        {step === 'build' && (
          <BuildButton
            sessionId={sessionId}
            uploadInfo={uploadInfo}
            onError={(e) => notify(e, 'error')}
          />
        )}
      </main>
    </div>
  );
}
