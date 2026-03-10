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
  return { offerName: 'Quantum AI', countryCode: 'DE', langCode: 'de', applied: false };
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

  // echo functionName(...) — match on the function name itself
  const echoMatch = snippet.match(/echo\s+(\w+)\s*\(/);
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
  res.json({ content: generateSendPhp({ offerName, countryCode, langCode }) });
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
    const { offerName, countryCode, langCode } = req.body;
    if (!offerName || !countryCode || !langCode) {
      return res.status(400).json({ error: 'offerName, countryCode, langCode are required' });
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

    // Inject PHP (idempotent)
    html = injectPhp(html, { offerName, langCode });

    // Try to format with Prettier (may fail due to PHP tags — that's expected)
    const fmt = await formatHtml(html);
    html = fmt.html;

    // Save as index.php
    const newIndexPath = path.join(sessionDir, 'index.php');
    fs.writeFileSync(newIndexPath, html, 'utf-8');

    // Remove old index.html if it's different from index.php
    if (indexPath !== newIndexPath && fs.existsSync(indexPath)) {
      fs.unlinkSync(indexPath);
    }

    // Generate send.php
    fs.writeFileSync(
      path.join(sessionDir, 'send.php'),
      generateSendPhp({ offerName, countryCode, langCode }),
      'utf-8'
    );

    saveConfig(sid, { offerName, countryCode, langCode, applied: true });

    res.json({ ok: true, indexFile: 'index.php', sendPhpGenerated: true, formatted: fmt.success });
  } catch (err) {
    console.error('PHP apply error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
