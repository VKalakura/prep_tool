import { useState, useEffect } from 'react';
import { getPhpConfig, applyPhpIntegration, getPhpPreviewSendPhp } from '../api.js';

const LEGACY_SNIPPETS = (langCode, offerName) => [
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

const NEW_SNIPPETS = (countryCode, langCode, offerName, offerId) => [
  {
    pos: 'Before <!DOCTYPE html>',
    code: `<?php require_once '/var/www/keitaro/lander/include-thanks-page/prod/current/_autoload.php';\n\nService::init();\nif (Request::isPost()) {\n    Service::register(RegistrationFieldsDto::fromRequest());\n}\n?>`,
  },
  {
    pos: 'After <head>',
    code: `<?php echo File::getHeaderHtml(); ?>`,
  },
  {
    pos: 'Before </body>',
    code: `<?php echo File::getFooterHtml(); ?>`,
  },
  {
    pos: 'After <form> (first form)',
    code: `<?php\n$formParams = [\n    Form::COUNTRY_CODE  => '${(countryCode || 'GB').toUpperCase()}',\n    Form::LANGUAGE_CODE => '${(langCode || 'en').toUpperCase()}',\n    Form::OFFER_NAME    => '${offerName || 'Offer Name'}',\n    Form::OFFER_ID      => '${offerId || '1234'}',\n];\necho Form::getHiddenParameters($formParams);\n?>`,
  },
];

export default function PhpIntegration({ sessionId, mode, onDone, onError }) {
  const isDev = mode === 'dev';
  const [integration, setIntegration] = useState('legacy');
  const [offerName, setOfferName] = useState('Quantum AI');
  const [countryCode, setCountryCode] = useState('DE');
  const [langCode, setLangCode] = useState('de');
  const [offerId, setOfferId] = useState('1234');
  const [tab, setTab] = useState('config');
  const [sendPhpPreview, setSendPhpPreview] = useState('');
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);

  const isNew = integration === 'new';

  useEffect(() => {
    getPhpConfig(sessionId)
      .then((r) => {
        const c = r.data.config;
        if (c.offerName) setOfferName(c.offerName);
        if (c.countryCode) setCountryCode(c.countryCode);
        if (c.langCode) setLangCode(c.langCode);
        if (c.offerId) setOfferId(c.offerId);
        if (c.integration === 'new') setIntegration('new');
        if (c.applied) setApplied(true);
      })
      .catch(() => {});
  }, [sessionId]);

  const loadSendPhpPreview = async () => {
    try {
      const r = await getPhpPreviewSendPhp(sessionId, { offerName, countryCode, langCode, offerId, integration });
      setSendPhpPreview(r.data.content);
    } catch {}
  };

  const handleTabChange = (t) => {
    setTab(t);
    // Always refresh preview when switching to sendphp tab so it reflects current form
    if (t === 'sendphp') loadSendPhpPreview();
  };

  // Keep the send.php preview in sync when the integration type changes while
  // the operator is looking at that tab.
  const handleIntegrationChange = (next) => {
    setIntegration(next);
    if (tab === 'sendphp') {
      getPhpPreviewSendPhp(sessionId, { offerName, countryCode, langCode, offerId, integration: next })
        .then((r) => setSendPhpPreview(r.data.content))
        .catch(() => {});
    }
  };

  const handleApply = async () => {
    if (!offerName.trim() || !countryCode.trim() || !langCode.trim()) {
      onError('Fill in all fields');
      return;
    }
    if (isNew && !offerId.trim()) {
      onError('Offer ID is required for the new integration');
      return;
    }
    setApplying(true);
    try {
      const res = await applyPhpIntegration(sessionId, { offerName, countryCode, langCode, offerId, integration });
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

  const snippets = isNew
    ? NEW_SNIPPETS(countryCode, langCode, offerName, offerId)
    : LEGACY_SNIPPETS(langCode, offerName);

  return (
    <div className="panel panel--wide">
      <div className="panel__header">
        <h2>PHP Integration</h2>
        <p className="panel__desc">
          Configure the offer settings. The tool will inject all required PHP includes into
          the HTML and generate <code>send.php</code>. The main file keeps its original name{' '}
          (<code>index.html</code>) — it is not renamed to <code>.php</code>.
        </p>

        <div className="php-integration-switch">
          <span className="php-integration-switch__label">Integration</span>
          <div className="tab-bar">
            <button
              className={`tab-bar__btn ${!isNew ? 'active' : ''}`}
              onClick={() => handleIntegrationChange('legacy')}
            >
              Legacy
            </button>
            <button
              className={`tab-bar__btn ${isNew ? 'active' : ''}`}
              onClick={() => handleIntegrationChange('new')}
            >
              New
            </button>
          </div>
          <span className="php-integration-switch__hint">
            {isNew
              ? 'Autoload + Service bootstrap, File::getHeaderHtml/FooterHtml, Form::getHiddenParameters (with Offer ID).'
              : 'global_new.php, google_event.php, getFormJSCss, offer_footer_script.php, hidden_params.php.'}
          </span>
        </div>

        {isDev && (
          <div className="tab-bar" style={{ marginTop: 12 }}>
            <button className={`tab-bar__btn ${tab === 'config' ? 'active' : ''}`} onClick={() => handleTabChange('config')}>Configuration</button>
            <button className={`tab-bar__btn ${tab === 'snippets' ? 'active' : ''}`} onClick={() => handleTabChange('snippets')}>PHP Snippets</button>
            <button className={`tab-bar__btn ${tab === 'sendphp' ? 'active' : ''}`} onClick={() => handleTabChange('sendphp')}>send.php Preview</button>
          </div>
        )}
      </div>

      {tab === 'config' && (
        <div className="php-config">
          <div className="php-config__field">
            <label className="php-config__label">Offer Name</label>
            <p className="php-config__hint">Used in <code>OFFER_NAME</code> {isNew ? 'form parameter' : 'field and hidden form input'}</p>
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
              <p className="php-config__hint">Used in <code>COUNTRY_CODE</code> {isNew ? 'form parameter' : 'in send.php'}</p>
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
              <p className="php-config__hint">Used in <code>lang</code> attr{isNew ? ', ' : ', '}<code>{isNew ? 'LANGUAGE_CODE' : 'getFormJSCss'}</code></p>
              <input
                className="input"
                value={langCode}
                onChange={(e) => setLangCode(e.target.value.toLowerCase())}
                placeholder="de"
                maxLength={5}
              />
            </div>
          </div>

          {isNew && (
            <div className="php-config__field">
              <label className="php-config__label">Offer ID <span className="php-config__req">*</span></label>
              <p className="php-config__hint">Used in <code>OFFER_ID</code> form parameter — dynamic per offer, replace the template value</p>
              <input
                className="input"
                value={offerId}
                onChange={(e) => setOfferId(e.target.value.trim())}
                placeholder="e.g. 6878"
                maxLength={32}
              />
            </div>
          )}

          <div className="php-config__preview-row">
            <div className="php-config__preview-item">
              <span className="php-config__preview-label">HTML lang attr:</span>
              <code>&lt;html lang="{langCode.toLowerCase()}"&gt;</code>
            </div>
            {isNew ? (
              <>
                <div className="php-config__preview-item">
                  <span className="php-config__preview-label">COUNTRY_CODE:</span>
                  <code>'{countryCode.toUpperCase()}'</code>
                </div>
                <div className="php-config__preview-item">
                  <span className="php-config__preview-label">LANGUAGE_CODE:</span>
                  <code>'{langCode.toUpperCase()}'</code>
                </div>
                <div className="php-config__preview-item">
                  <span className="php-config__preview-label">OFFER_ID:</span>
                  <code>'{offerId || '—'}'</code>
                </div>
              </>
            ) : (
              <>
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
              </>
            )}
          </div>
        </div>
      )}

      {isDev && tab === 'snippets' && (
        <div className="snippets-list">
          {snippets.map((s, i) => (
            <div key={i} className="snippet-item">
              <div className="snippet-item__pos">{s.pos}</div>
              <pre className="snippet-item__code">{s.code}</pre>
            </div>
          ))}
        </div>
      )}

      {isDev && tab === 'sendphp' && (
        <pre className="code-preview code-preview--lg">
          {sendPhpPreview || 'Loading preview…'}
        </pre>
      )}

      <div className="panel__footer">
        {applied && <span className="badge badge--green">Applied — saved as index.html</span>}
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
