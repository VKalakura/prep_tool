const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');

/**
 * Inject a widget into the HTML.
 * Copies widget JS/CSS into the session directory and links them.
 */
function inject(html, widgetDir, widgetId, position, sessionDir) {
  const $ = cheerio.load(html, { decodeEntities: false });

  const files = fs.readdirSync(widgetDir);
  const htmlFile = files.find((f) => f.endsWith('.html'));
  const jsFile = files.find((f) => f.endsWith('.js'));
  const cssFile = files.find((f) => f.endsWith('.css'));

  // Determine where index.html lives within session to set correct relative paths
  const indexRelDir = findIndexRelDir(sessionDir);
  const widgetAssetsRelDir = path.join(indexRelDir, `widgets/${widgetId}`);
  const widgetAssetsDest = path.join(sessionDir, widgetAssetsRelDir);
  fs.mkdirSync(widgetAssetsDest, { recursive: true });

  // Copy JS and CSS into session
  if (jsFile) {
    fs.copyFileSync(path.join(widgetDir, jsFile), path.join(widgetAssetsDest, jsFile));
  }
  if (cssFile) {
    fs.copyFileSync(path.join(widgetDir, cssFile), path.join(widgetAssetsDest, cssFile));
  }

  // Relative path from index.html to widget assets
  const relPath = `widgets/${widgetId}`;

  // Inject CSS link into <head>
  if (cssFile) {
    $('head').append(`\n  <link rel="stylesheet" href="${relPath}/${cssFile}">`);
  }

  // Build the widget HTML block
  let widgetHtml = htmlFile
    ? fs.readFileSync(path.join(widgetDir, htmlFile), 'utf-8').trim()
    : '';

  // Append JS script tag after the widget HTML
  let snippet = widgetHtml;
  if (jsFile) {
    snippet += `\n<script src="${relPath}/${jsFile}"></script>`;
  }

  // Inject at position
  injectAtPosition($, snippet, position);

  return $.html();
}

function injectAtPosition($, snippet, position) {
  if (position.startsWith('selector:')) {
    const sel = position.replace('selector:', '');
    const el = $(sel).first();
    if (el.length) {
      el.after(snippet);
      return;
    }
  }

  switch (position) {
    case 'before-body-close':
      $('body').append(snippet);
      break;
    case 'before-head-close':
      $('head').append(snippet);
      break;
    case 'after-body-open':
      $('body').prepend(snippet);
      break;
    case 'before-form-close':
      $('form').last().append(snippet);
      break;
    default:
      $('body').append(snippet);
  }
}

function findIndexRelDir(sessionDir) {
  // Returns the relative directory of index.html within sessionDir
  // We rely on folderScanner but avoid circular dep by doing a simple search
  const found = findIndex(sessionDir);
  if (!found) return '';
  return path.relative(sessionDir, path.dirname(found));
}

function findIndex(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase() === 'index.html') {
      return path.join(dir, e.name);
    }
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const result = findIndex(path.join(dir, e.name));
      if (result) return result;
    }
  }
  return null;
}

module.exports = { inject };
