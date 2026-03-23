import { useState, useCallback, useEffect, useRef } from 'react';
import FolderUpload from './components/FolderUpload.jsx';
import ScriptCleaner from './components/ScriptCleaner.jsx';
import ContentEditor from './components/ContentEditor.jsx';
import WidgetPanel from './components/WidgetPanel.jsx';
import PhpIntegration from './components/PhpIntegration.jsx';
import BuildButton from './components/BuildButton.jsx';
import DevPanel from './components/DevPanel.jsx';
import SessionList from './components/SessionList.jsx';
import { autoClean, pingSession, pushToSession } from './api.js';

function generateId() {
  return Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
}

function getMode() {
  const p = window.location.pathname;
  if (p.startsWith('/dev')) return 'dev';
  if (p.startsWith('/standard')) return 'standard';
  return 'select';
}

const DEV_STEPS = [
  { id: 'upload',  label: '1. Upload' },
  { id: 'clean',   label: '2. Clean' },
  { id: 'content', label: '3. Content' },
  { id: 'php',     label: '4. PHP' },
  { id: 'build',   label: '5. Build' },
];

const STANDARD_STEPS = [
  { id: 'upload',  label: '1. Upload' },
  { id: 'content', label: '2. Content' },
  { id: 'php',     label: '3. PHP' },
  { id: 'build',   label: '4. Build' },
];

// ─── Preview window (opened in new tab from Code Editor) ─────────────────────
function PreviewWindow({ sessionId }) {
  const [key, setKey] = useState(0);

  useEffect(() => {
    let ch;
    try {
      ch = new BroadcastChannel('ept-preview-' + sessionId);
      ch.onmessage = () => setKey(k => k + 1);
    } catch {}
    return () => ch?.close();
  }, [sessionId]);

  return (
    <iframe
      key={key}
      src={`/api/content/${sessionId}/preview-iframe`}
      style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', border: 'none' }}
      sandbox="allow-scripts allow-same-origin"
      title="Preview"
    />
  );
}

// ─── Landing page ─────────────────────────────────────────────────────────────
function ModeSelect() {
  return (
    <div className="mode-select">
      <div className="mode-select__inner">
        <div className="mode-select__logo">🛠</div>
        <h1 className="mode-select__title">Offer Prep Tool</h1>
        <p className="mode-select__sub">Select your workflow to get started</p>
        <div className="mode-select__cards">
          <a href="/standard" className="mode-card">
            <div className="mode-card__icon">📦</div>
            <div className="mode-card__title">Standard</div>
            <div className="mode-card__desc">
              Upload, edit content, configure and build.
              Clean and simple — for buyers and copywriters.
            </div>
            <div className="mode-card__steps">Upload → Content → Widgets → PHP → Build</div>
          </a>
          <a href="/dev" className="mode-card mode-card--dev">
            <div className="mode-card__icon">⚙️</div>
            <div className="mode-card__title">Developer</div>
            <div className="mode-card__desc">
              Full pipeline with deep clean, script control,
              PHP snippets preview and session sharing.
            </div>
            <div className="mode-card__steps">Upload → Clean → Content → Widgets → PHP → Build</div>
          </a>
        </div>
      </div>
    </div>
  );
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────
function PipelineApp({ mode, initialSession, startStep, buyerSession }) {
  const STEPS = mode === 'dev' ? DEV_STEPS : STANDARD_STEPS;

  const [sessionId] = useState(() => initialSession || generateId());
  const [step, setStep] = useState(() => startStep || 'upload');
  // When starting from a clone, files are already in place
  const [uploadInfo, setUploadInfo] = useState(() => initialSession ? { filesUploaded: '…', indexSizeKb: '…', _cloned: true } : null);
  const [notifications, setNotifications] = useState([]);
  const [autoCleaning, setAutoCleaning] = useState(false);
  const notifIdRef    = useRef(0);
  const notifTimers   = useRef({});
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const lastActivityRef = useRef(undefined); // undefined = not yet initialized (sentinel)
  const [devUpdated, setDevUpdated] = useState(false);
  const [contentReloadKey, setContentReloadKey] = useState(0);

  const dismissNotif = useCallback((id) => {
    clearTimeout(notifTimers.current[id]);
    delete notifTimers.current[id];
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, exiting: true } : n));
    setTimeout(() => setNotifications(prev => prev.filter(n => n.id !== id)), 340);
  }, []);

  const notify = useCallback((msg, type = 'success', action = null) => {
    const id = ++notifIdRef.current;
    setNotifications(prev => [{ id, msg, type, action, exiting: false }, ...prev]);
    notifTimers.current[id] = setTimeout(() => dismissNotif(id), 10000);
    return id;
  }, [dismissNotif]);

  const goTo = useCallback((s) => setStep(s), []);

  const handleDevReload = useCallback(() => {
    setDevUpdated(false);
    setContentReloadKey(k => k + 1);
  }, []);

  // Polling for Standard mode — show persistent banner when dev saves
  useEffect(() => {
    if (mode !== 'standard' || !uploadInfo) return;
    const interval = setInterval(async () => {
      try {
        const res = await pingSession(sessionId);
        const ts = res.data.lastDevActivity ?? null;
        if (lastActivityRef.current === undefined) {
          // First successful poll — record baseline silently, don't notify
          lastActivityRef.current = ts;
          return;
        }
        if (ts && ts !== lastActivityRef.current) {
          lastActivityRef.current = ts;
          setDevUpdated(true);
        }
      } catch {}
    }, 3000);
    return () => clearInterval(interval);
  }, [mode, uploadInfo, sessionId]);

  // Protect against accidental page refresh / tab close after upload
  useEffect(() => {
    if (!uploadInfo) return;
    const handler = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [uploadInfo]);

  const handleUploadComplete = async (info) => {
    setUploadInfo(info);
    const n = info.normalization;
    notify(
      `Found index.html · Moved ${n.moved} files` +
      (n.warnings?.length ? ` · ⚠ ${n.warnings.length} warnings` : '') +
      (info.formatted ? ' · Formatted ✓' : '')
    );

    if (mode === 'standard') {
      if (info.hasPhpIncludes) {
        // Archive already has our PHP includes — it's pre-processed, skip auto-clean
        notify('Pre-processed offer detected — cleaning skipped ✓', 'info');
      } else {
        // Auto-clean silently before entering content step
        setAutoCleaning(true);
        try {
          const res = await autoClean(sessionId);
          const { scriptsRemoved, scriptsPreserved, formsReplaced, iframesRemoved, unusedDeleted, headCleaned } = res.data;
          const parts = [];
          if (headCleaned) parts.push(`${headCleaned} head item${headCleaned !== 1 ? 's' : ''} cleaned`);
          if (scriptsRemoved) parts.push(`${scriptsRemoved} script${scriptsRemoved !== 1 ? 's' : ''} removed`);
          if (scriptsPreserved) parts.push(`${scriptsPreserved} interactive script${scriptsPreserved !== 1 ? 's' : ''} kept`);
          if (formsReplaced) parts.push(`${formsReplaced} form${formsReplaced !== 1 ? 's' : ''} → div`);
          if (iframesRemoved) parts.push(`${iframesRemoved} iframe${iframesRemoved !== 1 ? 's' : ''}`);
          if (unusedDeleted) parts.push(`${unusedDeleted} unused file${unusedDeleted !== 1 ? 's' : ''}`);
          if (parts.length) notify(`Auto-cleaned: ${parts.join(', ')}`);
        } catch {
          notify('Auto-clean skipped', 'info');
        } finally {
          setAutoCleaning(false);
        }
      }
      setStep('content');
    } else {
      setStep('clean');
    }
  };

  const isEnabled = (stepId) => stepId === 'upload' || (!!uploadInfo && !autoCleaning);

  const handleShare = () => {
    const url = `${window.location.origin}/dev?dev=${sessionId}`;
    navigator.clipboard?.writeText(url).then(() => notify(`Dev link copied: ${sessionId}`));
  };

  const handlePushToBuyer = async () => {
    try {
      await pushToSession(sessionId, buyerSession);
      notify('Pushed to buyer session ✓');
    } catch (err) {
      notify(err.response?.data?.error || 'Push failed', 'error');
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header__inner">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              className="btn btn--sm btn--back"
              onClick={() => {
                if (uploadInfo) {
                  setShowExitConfirm(true);
                } else {
                  window.location.href = '/';
                }
              }}
            >← Mode Select</button>
            <span className="header-sep" />
            <span className="app-header__title">🛠 Offer Prep Tool</span>
            <span className={`badge ${mode === 'dev' ? 'badge--purple' : 'badge--blue'}`}>
              {mode === 'dev' ? 'Developer' : 'Standard'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {mode === 'dev' && (
              <a href="/dev?sessions=1" className="btn btn--sm">All Sessions</a>
            )}
            {buyerSession && (
              <button className="btn btn--sm btn--primary" onClick={handlePushToBuyer} title={`Push current state to buyer session ${buyerSession}`}>
                ⬆ Push to buyer
              </button>
            )}
            {uploadInfo && (
              <div className="app-header__session">
                <span>Session: <code>{sessionId}</code></span>
                {!uploadInfo._cloned && <>
                  <span className="badge">{uploadInfo.filesUploaded} files</span>
                  <span className="badge badge--blue">{uploadInfo.indexSizeKb} KB</span>
                </>}
                {uploadInfo._cloned && <span className="badge badge--purple">from originals</span>}
                {mode === 'dev' && !buyerSession && (
                  <button className="btn btn--sm" onClick={handleShare} title="Copy dev access link">
                    Share Session
                  </button>
                )}
              </div>
            )}
          </div>
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

      {notifications.length > 0 && (
        <div className="notifications-container">
          {notifications.map(n => (
            <div key={n.id} className={`notification notification--${n.type}${n.exiting ? ' notification--exiting' : ''}`}>
              <span>{n.msg}</span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                {n.action && (
                  <button className="btn btn--sm" onClick={n.action.onClick}>{n.action.label}</button>
                )}
                <button className="notification__close" onClick={() => dismissNotif(n.id)}>×</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {devUpdated && (
        <div className="dev-update-banner">
          <span>⚠ Developer updated the session — reload to see changes</span>
          <button className="btn btn--sm" onClick={handleDevReload}>↺ Reload Preview</button>
        </div>
      )}

      <main className="app-main">
        {step === 'upload' && (
          <FolderUpload
            sessionId={sessionId}
            mode={mode}
            onComplete={handleUploadComplete}
            onError={e => notify(e, 'error')}
            loading={autoCleaning}
            loadingText="Auto-cleaning…"
          />
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
            mode={mode}
            onDone={() => { notify('Content saved'); goTo('php'); }}
            onSkip={() => goTo('php')}
            onError={e => notify(e, 'error')}
            externalReloadKey={contentReloadKey}
          />
        )}
        {step === 'php' && (
          <PhpIntegration
            sessionId={sessionId}
            mode={mode}
            onDone={msg => { notify(msg); goTo('build'); }}
            onError={e => notify(e, 'error')}
          />
        )}
        {step === 'build' && (
          <BuildButton sessionId={sessionId} uploadInfo={uploadInfo} onError={e => notify(e, 'error')} externalReloadKey={contentReloadKey} />
        )}
      </main>

      {showExitConfirm && (
        <div className="exit-confirm-overlay" onClick={() => setShowExitConfirm(false)}>
          <div className="exit-confirm-modal" onClick={e => e.stopPropagation()}>
            <h3>Leave this session?</h3>
            <p>All unsaved progress will be lost.</p>
            <div className="exit-confirm-actions">
              <button className="btn" onClick={() => setShowExitConfirm(false)}>Stay</button>
              <button className="btn btn--danger" onClick={() => { window.location.href = '/'; }}>Leave anyway</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function App() {
  const mode = getMode();
  const params = new URLSearchParams(window.location.search);
  const devSession = params.get('dev');
  const showSessions = params.get('sessions') === '1';
  const cloneSession = params.get('clone');
  const buyerSession = params.get('buyer');
  const previewSession = params.get('preview');

  if (previewSession) return <PreviewWindow sessionId={previewSession} />;
  if (devSession) return <DevPanel sessionId={devSession} />;
  if (mode === 'dev' && showSessions) return <SessionList />;
  if (cloneSession) return <PipelineApp mode="dev" initialSession={cloneSession} startStep="clean" buyerSession={buyerSession} />;
  if (mode === 'select') return <ModeSelect />;
  return <PipelineApp mode={mode} />;
}
