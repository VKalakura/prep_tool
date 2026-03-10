import { useState, useEffect } from 'react';
import { getPhpConfig, applyPhpIntegration, getPhpPreviewSendPhp } from '../api.js';

const PHP_SNIPPETS = (langCode, offerName) => [
  {
    pos: 'Before <!DOCTYPE html>',
    code: `<?php require_once '/var/www/keitaro/lander/include-thanks-page/global_new.php'; ?>`,
  },
  {
    pos: 'After <head>',
    code: `<?php require_once '/var/www/keitaro/lander/include-thanks-page/google_event.php'; ?>`,
  },
  {
    pos: 'Before </head>',
    code: `<?php echo getFormJSCss('${(langCode || 'en').toLowerCase()}'); ?>`,
  },
  {
    pos: 'Before </body>',
    code: `<?php require_once '/var/www/keitaro/lander/include-thanks-page/offer_footer_script.php'; ?>`,
  },
  {
    pos: 'After <form> (first form)',
    code: `<input type="hidden" name="offer_name" value="${offerName || 'Offer Name'}" />\n<?php require_once '/var/www/keitaro/lander/include-thanks-page/hidden_params.php'; ?>`,
  },
];

export default function PhpIntegration({ sessionId, onDone, onError }) {
  const [offerName, setOfferName] = useState('Quantum AI');
  const [countryCode, setCountryCode] = useState('DE');
  const [langCode, setLangCode] = useState('de');
  const [tab, setTab] = useState('config');
  const [sendPhpPreview, setSendPhpPreview] = useState('');
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    getPhpConfig(sessionId)
      .then((r) => {
        const c = r.data.config;
        if (c.offerName) setOfferName(c.offerName);
        if (c.countryCode) setCountryCode(c.countryCode);
        if (c.langCode) setLangCode(c.langCode);
        if (c.applied) setApplied(true);
      })
      .catch(() => {});
  }, [sessionId]);

  const loadSendPhpPreview = async () => {
    try {
      const r = await getPhpPreviewSendPhp(sessionId, { offerName, countryCode, langCode });
      setSendPhpPreview(r.data.content);
    } catch {}
  };

  const handleTabChange = (t) => {
    setTab(t);
    // Always refresh preview when switching to sendphp tab so it reflects current form
    if (t === 'sendphp') loadSendPhpPreview();
  };

  const handleApply = async () => {
    if (!offerName.trim() || !countryCode.trim() || !langCode.trim()) {
      onError('Fill in all fields');
      return;
    }
    setApplying(true);
    try {
      const res = await applyPhpIntegration(sessionId, { offerName, countryCode, langCode });
      setApplied(true);
      const fmtMsg = res.data.formatted === true
        ? 'PHP integration applied · Auto-formatting successful'
        : 'PHP integration applied · Auto-formatting failed';
      onDone(fmtMsg);
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to apply PHP integration');
      setApplying(false);
    }
  };

  const snippets = PHP_SNIPPETS(langCode, offerName);

  return (
    <div className="panel panel--wide">
      <div className="panel__header">
        <h2>PHP Integration</h2>
        <p className="panel__desc">
          Configure the offer settings. The tool will inject all required PHP includes into
          the HTML and generate <code>send.php</code>. The file will be saved as{' '}
          <code>index.php</code>.
        </p>
        <div className="tab-bar" style={{ marginTop: 12 }}>
          <button className={`tab-bar__btn ${tab === 'config' ? 'active' : ''}`} onClick={() => handleTabChange('config')}>Configuration</button>
          <button className={`tab-bar__btn ${tab === 'snippets' ? 'active' : ''}`} onClick={() => handleTabChange('snippets')}>PHP Snippets</button>
          <button className={`tab-bar__btn ${tab === 'sendphp' ? 'active' : ''}`} onClick={() => handleTabChange('sendphp')}>send.php Preview</button>
        </div>
      </div>

      {tab === 'config' && (
        <div className="php-config">
          <div className="php-config__field">
            <label className="php-config__label">Offer Name</label>
            <p className="php-config__hint">Used in <code>OFFER_NAME</code> field and hidden form input</p>
            <input
              className="input input--wide"
              value={offerName}
              onChange={(e) => setOfferName(e.target.value)}
              placeholder="e.g. Quantum AI"
            />
          </div>

          <div className="php-config__row">
            <div className="php-config__field">
              <label className="php-config__label">Country Code</label>
              <p className="php-config__hint">Used in <code>COUNTRY_CODE</code> in send.php</p>
              <input
                className="input"
                value={countryCode}
                onChange={(e) => setCountryCode(e.target.value.toUpperCase())}
                placeholder="DE"
                maxLength={5}
              />
            </div>
            <div className="php-config__field">
              <label className="php-config__label">Language Code</label>
              <p className="php-config__hint">Used in <code>lang</code> attr, <code>getFormJSCss</code>, <code>LANGUAGE_CODE</code></p>
              <input
                className="input"
                value={langCode}
                onChange={(e) => setLangCode(e.target.value.toLowerCase())}
                placeholder="de"
                maxLength={5}
              />
            </div>
          </div>

          <div className="php-config__preview-row">
            <div className="php-config__preview-item">
              <span className="php-config__preview-label">HTML lang attr:</span>
              <code>&lt;html lang="{langCode.toLowerCase()}"&gt;</code>
            </div>
            <div className="php-config__preview-item">
              <span className="php-config__preview-label">getFormJSCss call:</span>
              <code>getFormJSCss('{langCode.toLowerCase()}')</code>
            </div>
            <div className="php-config__preview-item">
              <span className="php-config__preview-label">LANGUAGE_CODE:</span>
              <code>'{langCode.toUpperCase()}'</code>
            </div>
            <div className="php-config__preview-item">
              <span className="php-config__preview-label">COUNTRY_CODE:</span>
              <code>'{countryCode.toUpperCase()}'</code>
            </div>
          </div>
        </div>
      )}

      {tab === 'snippets' && (
        <div className="snippets-list">
          {snippets.map((s, i) => (
            <div key={i} className="snippet-item">
              <div className="snippet-item__pos">{s.pos}</div>
              <pre className="snippet-item__code">{s.code}</pre>
            </div>
          ))}
        </div>
      )}

      {tab === 'sendphp' && (
        <pre className="code-preview code-preview--lg">
          {sendPhpPreview || 'Loading preview…'}
        </pre>
      )}

      <div className="panel__footer">
        {applied && <span className="badge badge--green">Applied — saved as index.php</span>}
        <button
          className="btn btn--primary btn--xl"
          onClick={handleApply}
          disabled={applying}
        >
          {applying ? 'Applying…' : 'Apply PHP Integration & Continue →'}
        </button>
      </div>
    </div>
  );
}
