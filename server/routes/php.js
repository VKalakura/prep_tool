const express = require('express');
const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const { formatHtml } = require('../services/htmlFormatter');

const router = express.Router();

function getSessionDir(sid) {
  return path.join(__dirname, '../sessions', sid);
}

function getIndexPath(sid) {
  const dir = getSessionDir(sid);
  for (const name of ['index.php', 'index.html']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function getConfigPath(sid) {
  return path.join(getSessionDir(sid), '_offer_config.json');
}

function loadConfig(sid) {
  const p = getConfigPath(sid);
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  return { offerName: 'Quantum AI', countryCode: 'DE', langCode: 'de', offerId: '1234', integration: 'legacy', applied: false };
}

/** Normalize the requested integration variant. 'new' or 'legacy' (default). */
function normalizeIntegration(value) {
  return String(value || '').toLowerCase() === 'new' ? 'new' : 'legacy';
}

function saveConfig(sid, config) {
  fs.writeFileSync(getConfigPath(sid), JSON.stringify(config, null, 2));
}

// ─── Duplicate-safe injectors ─────────────────────────────────────────────────

/**
 * Check if a PHP require_once or echo snippet is already present in the file.
 * Matches on the path/call inside the snippet so minor whitespace diffs don't matter.
 */
function alreadyPresent(html, snippet) {
  // require_once '/path/to/file.php' — match on the file path (unique)
  const requireMatch = snippet.match(/require_once\s+'([^']+)'/);
  if (requireMatch) return html.includes(requireMatch[1]);

  // echo functionName(...) / echo Class::method(...) — match on the call name.
  // [\w:]+ keeps the class prefix so File::getHeaderHtml and File::getFooterHtml
  // (or getFormJSCss vs Form::getHiddenParameters) are told apart correctly.
  const echoMatch = snippet.match(/echo\s+([\w:]+)\s*\(/);
  if (echoMatch) return html.includes(echoMatch[1]);

  // hidden input with name attribute
  const inputMatch = snippet.match(/name="([^"]+)"/);
  if (inputMatch) return html.includes(`name="${inputMatch[1]}"`);

  return html.includes(snippet.trim());
}

function injectBefore(html, marker, snippet) {
  if (alreadyPresent(html, snippet)) return html;
  const re = new RegExp(`(${marker})`, 'i');
  if (!re.test(html)) return html;
  return html.replace(re, `${snippet}\n$1`);
}

function injectAfter(html, marker, snippet) {
  if (alreadyPresent(html, snippet)) return html;
  const re = new RegExp(`(${marker})`, 'i');
  if (!re.test(html)) return html;
  return html.replace(re, `$1\n${snippet}`);
}

/**
 * Inject all PHP snippets. Each one is idempotent — skipped if already present.
 */
function injectPhp(html, { offerName, langCode }) {
  let result = html;

  // 1. Before <!DOCTYPE>
  const globalSnippet = `<?php require_once '/var/www/keitaro/lander/include-thanks-page/global_new.php'; ?>`;
  if (!alreadyPresent(result, globalSnippet)) {
    const doctypeIdx = result.search(/<!doctype\s+html/i);
    if (doctypeIdx !== -1) {
      result = result.slice(0, doctypeIdx) + globalSnippet + '\n' + result.slice(doctypeIdx);
    } else {
      result = globalSnippet + '\n' + result;
    }
  }

  // 2. Right after <head ...>
  result = injectAfter(
    result,
    '<head[^>]*>',
    `<?php require_once '/var/www/keitaro/lander/include-thanks-page/google_event.php'; ?>`
  );

  // 3. Before </head>
  result = injectBefore(
    result,
    '<\\/head>',
    `<?php echo getFormJSCss('${langCode.toLowerCase()}'); ?>`
  );

  // 4. Before </body>
  result = injectBefore(
    result,
    '<\\/body>',
    `<?php require_once '/var/www/keitaro/lander/include-thanks-page/offer_footer_script.php'; ?>`
  );

  // 5. After first <form ...> — insert hidden inputs
  const hiddenInputSnippet = `<input type="hidden" name="offer_name" value="${offerName}" />`;
  const hiddenParamsSnippet = `<?php require_once '/var/www/keitaro/lander/include-thanks-page/hidden_params.php'; ?>`;

  // Check for hidden_params already present
  if (!alreadyPresent(result, hiddenParamsSnippet)) {
    result = result.replace(/(<form[^>]*>)/i, (m) => {
      const offerInput = alreadyPresent(result, 'name="offer_name"')
        ? '' // already has offer_name input
        : `\n                    ${hiddenInputSnippet}`;
      return m + offerInput + `\n                    ${hiddenParamsSnippet}`;
    });
  } else if (!alreadyPresent(result, 'name="offer_name"')) {
    // hidden_params is there but offer_name input is not
    result = result.replace(/(<form[^>]*>)/i, (m) =>
      m + `\n                    ${hiddenInputSnippet}`
    );
  }

  return result;
}

/**
 * New integration. POST handling is inline (Service::register at the top of the
 * page), header/footer come from File::get*Html(), and the form carries a
 * Form::getHiddenParameters([...]) block with COUNTRY_CODE / LANGUAGE_CODE /
 * OFFER_NAME / OFFER_ID. Each injection is idempotent — skipped if present.
 */
function injectPhpNew(html, { offerName, countryCode, langCode, offerId }) {
  let result = html;

  // 1. Before <!DOCTYPE> — autoload + Service bootstrap + POST registration.
  const autoloadSnippet = `<?php require_once '/var/www/keitaro/lander/include-thanks-page/prod/current/_autoload.php';

Service::init();
if (Request::isPost()) {
    Service::register(RegistrationFieldsDto::fromRequest());
}
?>`;
  if (!alreadyPresent(result, autoloadSnippet)) {
    const doctypeIdx = result.search(/<!doctype\s+html/i);
    if (doctypeIdx !== -1) {
      result = result.slice(0, doctypeIdx) + autoloadSnippet + '\n' + result.slice(doctypeIdx);
    } else {
      result = autoloadSnippet + '\n' + result;
    }
  }

  // 2. Right after <head ...> — server-rendered header markup.
  result = injectAfter(result, '<head[^>]*>', `<?php echo File::getHeaderHtml(); ?>`);

  // 3. Before </body> — server-rendered footer markup.
  result = injectBefore(result, '<\\/body>', `<?php echo File::getFooterHtml(); ?>`);

  // 4. After first <form ...> — hidden parameters block.
  const formParamsSnippet = `<?php
$formParams = [
    Form::COUNTRY_CODE  => '${countryCode.toUpperCase()}',
    Form::LANGUAGE_CODE => '${langCode.toUpperCase()}',
    Form::OFFER_NAME    => '${offerName}',
    Form::OFFER_ID      => '${offerId}',
];
echo Form::getHiddenParameters($formParams);
?>`;
  if (!alreadyPresent(result, formParamsSnippet)) {
    result = result.replace(/(<form[^>]*>)/i, (m) => `${m}\n${formParamsSnippet}`);
  }

  return result;
}

function generateSendPhp({ offerName, countryCode, langCode }) {
  return `<?php
require_once '/var/www/keitaro/lander/include-thanks-page/global.php';
sendToSpread(
    getParam(CSRF),
    [
        SUB_ID        => getParam(SUB_ID),
        EMAIL         => getParam(EMAIL),
        PHONE         => getParam(PHONE),
        FIRST_NAME    => getParam(FIRST_NAME),
        LAST_NAME     => getParam(LAST_NAME),
        PASSWORD      => getParam(PASSWORD, generatePassword()),
        COUNTRY_CODE  => getParam('', '${countryCode.toUpperCase()}'),
        TOWN          => getParam(TOWN, 'NY'),
        GENDER        => getParam(GENDER, 'male'),
        CURRENCY      => getParam(CURRENCY, 'USD'),
        ACCOUNT       => getParam(ACCOUNT, 'Facebook'),
        DOMAIN        => getDomain(),
        SOURCE_TYPE   => 'FACEBOOK',
        REMOTE_IP     => getRealIpAddr(),
        USER_AGENT    => getUserAgent(),
        LANGUAGE_CODE => '${langCode.toUpperCase()}',
        CREO          => getParam(CREO),
        SEARCH_ID     => getParam(SEARCH_ID),
        OFFER_NAME    => '${offerName}',
        OFFER_URL     => '',
    ]
);
`;
}

/**
 * New-integration send.php — registration runs inline at the top of index.php,
 * so send.php just includes the page.
 */
function generateSendPhpNew(indexFile = 'index.html') {
  return `<?php

require_once __DIR__.'/${indexFile}';
`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

router.get('/:sessionId/config', (req, res) => {
  res.json({ config: loadConfig(req.params.sessionId) });
});

// POST so the client can send current form values (not yet saved to disk)
router.post('/:sessionId/preview-sendphp', (req, res) => {
  const saved = loadConfig(req.params.sessionId);
  const offerName   = req.body.offerName   || saved.offerName   || 'Quantum AI';
  const countryCode = req.body.countryCode || saved.countryCode || 'DE';
  const langCode    = req.body.langCode    || saved.langCode    || 'de';
  const integration = normalizeIntegration(req.body.integration || saved.integration);
  const ip = getIndexPath(req.params.sessionId);
  const indexFile = ip ? path.basename(ip) : 'index.html';
  const content = integration === 'new'
    ? generateSendPhpNew(indexFile)
    : generateSendPhp({ offerName, countryCode, langCode });
  res.json({ content, integration });
});

router.get('/:sessionId/preview-html', (req, res) => {
  const indexPath = getIndexPath(req.params.sessionId);
  if (!indexPath) return res.status(404).json({ error: 'index file not found' });
  const content = fs.readFileSync(indexPath, 'utf-8');
  res.json({
    preview: content.split('\n').slice(0, 200).join('\n'),
    lines: content.split('\n').length,
    file: path.basename(indexPath),
  });
});

router.post('/:sessionId/apply', async (req, res) => {
  try {
    const { offerName, countryCode, langCode, offerId } = req.body;
    const integration = normalizeIntegration(req.body.integration);
    if (!offerName || !countryCode || !langCode) {
      return res.status(400).json({ error: 'offerName, countryCode, langCode are required' });
    }
    if (integration === 'new' && !String(offerId || '').trim()) {
      return res.status(400).json({ error: 'offerId is required for the new integration' });
    }

    const sid = req.params.sessionId;
    const sessionDir = getSessionDir(sid);
    const indexPath = getIndexPath(sid);
    if (!indexPath) return res.status(404).json({ error: 'No index file found in session' });

    // Set lang attribute via cheerio, then do PHP string injections
    let html = fs.readFileSync(indexPath, 'utf-8');
    const $ = cheerio.load(html, { decodeEntities: false });
    $('html').attr('lang', langCode.toLowerCase());
    html = $.html();

    // Inject PHP (idempotent) — variant depends on the chosen integration.
    const offerIdClean = String(offerId || '').trim();
    html = integration === 'new'
      ? injectPhpNew(html, { offerName, countryCode, langCode, offerId: offerIdClean })
      : injectPhp(html, { offerName, langCode });

    // Try to format with Prettier (may fail due to PHP tags — that's expected)
    const fmt = await formatHtml(html);
    html = fmt.html;

    // Keep the original main file as-is (do NOT convert index.html → index.php).
    // PHP snippets live inside the .html file; the deploy target serves it.
    fs.writeFileSync(indexPath, html, 'utf-8');
    const indexFile = path.basename(indexPath);

    // Generate send.php — new integration just re-includes the main page
    // (inline registration); legacy builds the full sendToSpread() payload.
    fs.writeFileSync(
      path.join(sessionDir, 'send.php'),
      integration === 'new'
        ? generateSendPhpNew(indexFile)
        : generateSendPhp({ offerName, countryCode, langCode }),
      'utf-8'
    );

    saveConfig(sid, { offerName, countryCode, langCode, offerId: offerIdClean, integration, applied: true });

    res.json({ ok: true, indexFile, sendPhpGenerated: true, formatted: fmt.success, integration });
  } catch (err) {
    console.error('PHP apply error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
