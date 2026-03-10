const cheerio = require('cheerio');

// Known tracking/unnecessary script patterns
const TRACKING_PATTERNS = [
  /google-analytics\.com/i,
  /googletagmanager\.com/i,
  /facebook\.net\/.*\/fbevents/i,
  /connect\.facebook\.net/i,
  /hotjar\.com/i,
  /clarity\.ms/i,
  /mouseflow\.com/i,
  /fullstory\.com/i,
  /mixpanel\.com/i,
  /segment\.com/i,
  /heap\.io/i,
  /crazyegg\.com/i,
  /tiktok\.com\/.*\/events/i,
  /snap\.licdn\.com/i,
  /static\.ads-twitter\.com/i,
  /cdn\.pendo\.io/i,
  /analytics\.js/i,
  /gtag\.js/i,
  /pixel\.js/i,
];

const CRITICAL_PATTERNS = [
  /jquery/i,
  /bootstrap/i,
  /vue\./i,
  /react\./i,
  /angular/i,
  /main\.js/i,
  /app\.js/i,
  /bundle\.js/i,
];

/**
 * Extract all <script> tags with metadata for display.
 */
function extractScripts(html) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const scripts = [];

  $('script').each((i, el) => {
    const $el = $(el);
    const src = $el.attr('src') || null;
    const type = $el.attr('type') || 'text/javascript';
    const inline = !src ? $el.html()?.trim().slice(0, 200) : null;
    const isTracking = src ? TRACKING_PATTERNS.some((p) => p.test(src)) : false;
    const isCritical = src ? CRITICAL_PATTERNS.some((p) => p.test(src)) : false;

    // Assign a stable ID based on position
    const id = `script-${i}`;

    scripts.push({
      id,
      index: i,
      src,
      type,
      inline: inline || null,
      isTracking,
      isCritical,
      suggestion: isTracking ? 'remove' : isCritical ? 'keep' : 'review',
    });
  });

  return scripts;
}

/**
 * Remove scripts by their index in the document.
 */
function removeScripts(html, scriptIndicesToRemove) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const toRemove = new Set(scriptIndicesToRemove.map(Number));
  const removed = [];

  $('script').each((i, el) => {
    if (toRemove.has(i)) {
      const src = $(el).attr('src') || '(inline)';
      removed.push({ index: i, src });
      $(el).remove();
    }
  });

  return { html: $.html(), removed };
}

/**
 * Inject an HTML snippet at a specified position.
 * positions: 'before-body-close' | 'before-head-close' | 'after-body-open' | 'before-form-close'
 */
function injectSnippet(html, snippet, position) {
  const $ = cheerio.load(html, { decodeEntities: false });

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

  return $.html();
}

/**
 * Detect meaningful insertion points in the HTML.
 */
function detectInsertionPoints(html) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const points = [];

  if ($('body').length) {
    points.push({
      id: 'before-body-close',
      label: 'Before </body>',
      description: 'Standard position for scripts and widgets at the end of the page.',
      recommended: true,
    });
    points.push({
      id: 'after-body-open',
      label: 'After <body> opens',
      description: 'Useful for top-of-page banners or overlays.',
      recommended: false,
    });
  }

  if ($('head').length) {
    points.push({
      id: 'before-head-close',
      label: 'Before </head>',
      description: 'CSS and early-loading scripts.',
      recommended: false,
    });
  }

  if ($('form').length) {
    const formCount = $('form').length;
    points.push({
      id: 'before-form-close',
      label: `Inside last <form> (${formCount} form${formCount > 1 ? 's' : ''} detected)`,
      description: 'Hidden inputs, honeypots, or form widgets.',
      recommended: false,
    });
  }

  // Look for common container divs
  const containerSelectors = [
    { sel: '#content', label: '#content div' },
    { sel: '.container', label: '.container div' },
    { sel: '.wrapper', label: '.wrapper div' },
    { sel: 'main', label: '<main> element' },
    { sel: 'section', label: 'First <section>' },
    { sel: '.hero', label: '.hero section' },
    { sel: '.cta', label: '.cta section' },
  ];

  for (const { sel, label } of containerSelectors) {
    if ($(sel).length) {
      points.push({
        id: `selector:${sel}`,
        label: `After ${label}`,
        description: `Detected "${sel}" in the page.`,
        recommended: false,
      });
    }
  }

  return points;
}

module.exports = { extractScripts, removeScripts, injectSnippet, detectInsertionPoints };
