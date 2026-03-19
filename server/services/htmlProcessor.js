const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// ── Tracking: matched against script src (CDN domains + well-known local filenames) ──
const TRACKING_PATTERNS = [
  // CDN domains
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
  /mc\.yandex\.ru/i,
  /adservice\.google/i,
  /pagead2\.googlesyndication/i,
  /adsbygoogle/i,
  // Well-known tracking SDK filenames (local copies)
  /fbevents(?:\.min)?\.js/i,
  /clarity(?:\.min)?\.js/i,
  /hotjar(?:\.min)?\.js/i,
  /mouseflow(?:\.min)?\.js/i,
  /fullstory(?:\.min)?\.js/i,
  /heap(?:analytics)?(?:\.min)?\.js/i,
  /analytics(?:\.min)?\.js/i,
  /gtag(?:\.min)?\.js/i,
  /pixel(?:\.min)?\.js/i,
  /ttq(?:\.min)?\.js/i,
  /metrika(?:\.min)?\.js/i,
  /counter(?:\.min)?\.js/i,
  /\bmatomo(?:\.min)?\.js/i,
  /\badvertis(?:ing|er)?(?:\.min)?\.js/i,
];

// ── Tracking: matched against inline script CONTENT ───────────────────────────
const INLINE_TRACKING_PATTERNS = [
  /\bfbq\s*\(/,                           // Facebook Pixel
  /\bgtag\s*\(/,                          // Google Analytics 4
  /dataLayer\s*(?:=\s*\[|\.\s*push)/,     // GTM dataLayer
  /\bga\s*\(\s*['"](?:send|create)/,      // Universal Analytics
  /\bhj\s*\(\s*['"](?:identify|event)/,   // Hotjar
  /clarity\s*\(\s*['"]/,                  // MS Clarity
  /_hsq\.push\s*\(/,                      // HubSpot
  /mixpanel\.(?:track|identify|init)/,    // Mixpanel
  /analytics\.(?:track|identify|page)/,   // Segment
  /\bttq\.(?:load|track)\s*\(/,           // TikTok Pixel
  /snaptr\s*\(/,                          // Snapchat Pixel
  /\bpintrk\s*\(/,                        // Pinterest Tag
  /LinkedInTag\.init\s*\(/,              // LinkedIn Insight
  /twq\s*\(\s*['"]/,                     // Twitter/X Pixel
  /uetq\.push\s*\(/,                      // Bing/Microsoft UET
  /window\._mfq\s*=/,                     // Mouseflow
  /FS\.identify\s*\(/,                    // FullStory
  /heap\.(?:load|track|identify)/,        // Heap
  /\bym\s*\(\s*\d+/,                      // Yandex.Metrika ym(id,...)
  /yaCounter\s*=\s*new/,                  // Yandex counter
  /yandex_metrika/i,                      // Yandex config var
  /adsbygoogle\.push\s*\(/,              // Google Ads
  /googletag\.(?:cmd|display|pubads)/,    // Google Publisher Tags
  /_paq[A-Za-z]?\s*\.push\s*\(/,         // Matomo (_paq, _paqM)
  /\bMatomo\b/,                           // Matomo object reference
];

// ── Critical UI libraries: always kept unless orphaned dependency ─────────────
// NOTE: main.js / app.js / bundle.js are NOT here — they pass through analyzeScriptInteractivity
const CRITICAL_PATTERNS = [
  // Utility / framework libraries
  /jquery(?:\.[\w-]+)*(?:\.min)?\.js/i,   // jquery.js, jquery.min.js, jquery.cookie.min.js, etc.
  /\bbootstrap(?:\.bundle)?(?:\.min)?\.js/i,
  /\bvue(?:\.min)?\.js/i,
  /\breact(?:-dom)?(?:\.min)?\.js/i,
  /angular(?:\.min)?\.js/i,
  // Known UI / animation libraries — kept only if something uses them
  /\bswiper(?:\.min)?\.js/i,
  /\bslick(?:\.min)?\.js/i,
  /owl\.carousel(?:\.min)?\.js/i,
  /splide(?:\.min)?\.js/i,
  /glide(?:\.min)?\.js/i,
  /flickity(?:\.min)?\.js/i,
  /tiny-slider(?:\.min)?\.js/i,
  /\baos(?:\.min)?\.js/i,
  /\bgsap(?:\.min)?\.js/i,
  /TweenMax(?:\.min)?\.js/i,
  /TweenLite(?:\.min)?\.js/i,
  /ScrollTrigger(?:\.min)?\.js/i,
  /\bwow(?:\.min)?\.js/i,
  /isotope(?:\.min)?\.js/i,
  /magnific-popup(?:\.min)?\.js/i,
  /fancybox(?:\.min)?\.js/i,
  /\bvenobox(?:\.min)?\.js/i,
  /select2(?:\.min)?\.js/i,
  /chosen(?:\.min)?\.js/i,
  // Lazy loading / image polyfills
  /\blazysizes?(?:\.min)?\.js/i,
  /picturefill(?:\.min)?\.js/i,
];

// ── Library dependency check: API patterns per library key ────────────────────
const LIBRARY_API_PATTERNS = {
  jquery:    [/\$\s*\(/, /jQuery\s*\(/, /\$\.fn/, /\$\.extend/, /\$\.each/],
  bootstrap: [/(?:new\s+)?bootstrap\./, /Bootstrap\./, /data-bs-/],
  vue:       [/new\s+Vue\s*\(/, /createApp\s*\(/, /Vue\.component/],
  react:     [/ReactDOM\.render/, /React\.createElement/, /createRoot\s*\(/],
  angular:   [/angular\.module/, /NgModule/],
  swiper:    [/new\s+Swiper\s*\(/, /Swiper\s*\(/],
  slick:     [/\.slick\s*\(/, /slick\s*\(/],
  owl:       [/\.owlCarousel\s*\(/, /owlCarousel/],
  splide:    [/new\s+Splide\s*\(/],
  glide:     [/new\s+Glide\s*\(/],
  aos:       [/AOS\.init\s*\(/, /aos\.init\s*\(/],
  gsap:      [/gsap\.(?:to|from|timeline|set|fromTo)/, /TweenMax\./, /TweenLite\./],
  wow:       [/new\s+WOW\s*\(/],
  isotope:   [/\.isotope\s*\(/],
  fancybox:  [/\$\.fancybox/, /Fancybox\./, /\.fancybox\s*\(/],
  venobox:   [/\.venobox\s*\(/],
  select2:   [/\.select2\s*\(/],
  chosen:    [/\.chosen\s*\(/],
};

function getLibraryKey(src) {
  if (!src) return null;
  if (/jquery/i.test(src))             return 'jquery';
  if (/bootstrap/i.test(src))          return 'bootstrap';
  if (/\bvue\b/i.test(src))            return 'vue';
  if (/\breact\b/i.test(src))          return 'react';
  if (/angular/i.test(src))            return 'angular';
  if (/swiper/i.test(src))             return 'swiper';
  if (/slick/i.test(src))              return 'slick';
  if (/owl/i.test(src))                return 'owl';
  if (/splide/i.test(src))             return 'splide';
  if (/glide/i.test(src))              return 'glide';
  if (/\baos\b/i.test(src))            return 'aos';
  if (/gsap|TweenMax|TweenLite/i.test(src)) return 'gsap';
  if (/\bwow\b/i.test(src))            return 'wow';
  if (/isotope/i.test(src))            return 'isotope';
  if (/fancybox/i.test(src))           return 'fancybox';
  if (/venobox/i.test(src))            return 'venobox';
  if (/select2/i.test(src))            return 'select2';
  if (/chosen/i.test(src))             return 'chosen';
  return null;
}

// ── Positive signal 1: user interaction or timed UI trigger ───────────────────
const UI_TRIGGER_PATTERNS = [
  // User-facing events (NO submit — that's form logic)
  /addEventListener\s*\(\s*['"](?:click|scroll|touchstart|touchend|touchmove|keydown|keyup|keypress|mouseenter|mouseleave|mousedown|mouseup|resize)['"]/,
  /\.onclick\s*=/, /\.onscroll\s*=/, /\.onkeydown\s*=/, /\.onresize\s*=/,
  // jQuery user events
  /\)\s*\.(?:click|scroll|hover|keydown|keyup|on\b|bind)\s*\(/,
  // Timers (slider auto-play, countdown, animation)
  /setInterval\s*\(/, /setTimeout\s*\(/,
  /requestAnimationFrame\s*\(/,
  // Page / DOM init (valid only when paired with DOM mutation)
  /DOMContentLoaded/,
  /window\.onload\s*=/,
  /\$\s*\(\s*(?:document|window|'document'|"document")\s*\)\s*\.ready/,
];

// ── Positive signal 2: visible DOM mutation ───────────────────────────────────
const DOM_MUTATION_PATTERNS = [
  /\.classList\.(?:add|remove|toggle|replace)\b/,
  /\.style\./,
  /\.innerHTML\s*=/,
  /\.textContent\s*=/,
  /\.setAttribute\s*\(/,
  /\.removeAttribute\s*\(/,
  /\.appendChild\s*\(/,
  /\.removeChild\s*\(/,
  /\.insertBefore\s*\(/,
  /\.remove\s*\(\s*\)/,
  /\.prepend\s*\(/, /\.append\s*\(/,
  /\)\s*\.(?:addClass|removeClass|toggleClass|show\b|hide\b|toggle\b|css|html\b|text\b|fadeIn|fadeOut|slideUp|slideDown)\s*\(/,
];

// ── Path 3: explicit initialization of a known UI library ────────────────────
// Scripts that call library APIs are UI scripts by definition (e.g. new Swiper(...), AOS.init())
const UI_LIBRARY_INIT_PATTERNS = [
  /new\s+Swiper\s*\(/,
  /\.slick\s*\(/,
  /\.owlCarousel\s*\(/,
  /new\s+Splide\s*\(/,
  /new\s+Glide\s*\(/,
  /AOS\.init\s*\(/,
  /gsap\.(?:to|from|fromTo|timeline|set|registerPlugin)\s*\(/,
  /TweenMax\.(?:to|from|fromTo)/, /TweenLite\.(?:to|from|fromTo)/,
  /new\s+WOW\s*\(/,  /new\s+WOW\s*\(\s*\)\.init/,
  /\.isotope\s*\(/,
  /\$\.fancybox/, /Fancybox\./, /\.fancybox\s*\(/,
  /\.venobox\s*\(/,
  /\.select2\s*\(/,
  /\.chosen\s*\(/,
  /ScrollReveal\s*\(/,
  /particlesJS\s*\(/,
  /Typed\s*\(/,
  // Generic jQuery plugin instantiation: $(...).pluginName({...})
  /\$\s*\(['"#.\[][^)]+\)\s*\.\w{3,}\s*\(\s*\{/,
];

// ── Disqualifier 1: dynamically injects external scripts (tracker bootstrap) ──
const SCRIPT_LOADER_PATTERNS = [
  /createElement\s*\(\s*['"]script['"]\s*\)/,
  /document\.write\s*\(/,
];

// ── Disqualifier 2: form logic — validation, submission, masking, captcha ─────
const FORM_HANDLER_PATTERNS = [
  // Network requests
  /new\s+XMLHttpRequest/,
  /\.open\s*\(\s*['"](?:POST|GET|PUT|post|get|put)['"]/,
  /fetch\s*\(\s*['"`]/,
  /fetch\s*\(\s*\w+(?:Url|URL|url|Path|path|endpoint)/,
  /\$\.ajax\s*\(/, /\$\.post\s*\(/, /\$\.get\s*\(/,
  /axios\s*\.\s*(?:post|get|put|patch|delete|request)\s*\(/,
  /axios\s*\(\s*\{/,
  /new\s+FormData\s*\(/,
  /navigator\.sendBeacon\s*\(/,
  /form\.submit\s*\(\s*\)/, /\.submit\s*\(\s*\)/,
  // Form submit event listeners
  /addEventListener\s*\(\s*['"]submit['"]/,
  /\.on\s*\(\s*['"]submit['"]/,
  /\.onsubmit\s*=/,
  // Form field event listeners — 'change' fires on select/checkbox/radio (form elements only)
  /addEventListener\s*\(\s*['"]change['"]/,
  /\.on\s*\(\s*['"]change['"]/,
  // Form field value reading — canonical form-validation pattern
  /\.value\s*\.(?:length|trim|replace|split|match|includes)\b/,
  /\.value\s*(?:===|!==|==|!=)\s*['"]/,
  /\.value\s*\.length\s*[<>!=]/,
  // regex.test(input.value) — email / phone format validation
  /\.test\s*\([^)]*\.value\b/,
  // Submit/send button references
  /\b(?:sendBtn|submitBtn|submitButton|btnSubmit|btnSend)\b/i,
  // Captcha / bot protection
  /(?:h)?captcha|recaptcha/i,
  /turnstile\.render/i,
  // Input masking / phone formatting
  /inputMask|IMask|\.mask\s*\(/i,
  /(?:phone|email|card).*mask|mask.*(?:phone|email)/i,
  // intlTelInput phone library (content marker in utils.js)
  /intlTelInputUtils/i,
  // Validation keywords
  /\bvalidate\b.*form|form.*\bvalidate\b/i,
  /checkValidity\s*\(|reportValidity\s*\(/,
  /setCustomValidity\s*\(/,
  // Form anchor redirect (replaceUrl = "#form" pattern)
  /\breplaceUrl\s*=\s*['"]/,
  // Anchor click → scroll to section/form scripts
  // On offer landing pages all anchors lead to the CTA/form; these are always replaced by the new widget's own scroll logic
  /scrollIntoView\s*\(/,
  /animate\s*\(\s*\{\s*scrollTop\b/,
];

// ── Form library filenames: matched against script src ────────────────────────
// These are always removed regardless of content (form-specific libraries)
const FORM_LIB_PATTERNS = [
  /intl-?tel-?input(?:\.min)?\.js/i,
  /intlTelInput(?:\.min)?\.js/i,
  /jquery\.(?:validate|mask|form)(?:\.min)?\.js/i,
  /parsley(?:\.min)?\.js/i,
  /cleave(?:\.min)?\.js/i,
  /air-?datepicker(?:\.min)?\.js/i,
  /flatpickr(?:\.min)?\.js/i,
];

// ── Font CDN patterns: external <link> to these are kept ──────────────────────
const FONT_CDN_PATTERNS = [
  /fonts\.googleapis\.com/i,
  /fonts\.gstatic\.com/i,
  /use\.typekit\.net/i,
  /kit\.fontawesome\.com/i,
  /use\.fontawesome\.com/i,
  /fast\.fonts\.net/i,
];

// DOM_ACCESS_PATTERNS — used only for library dependency detection
const DOM_ACCESS_PATTERNS = [
  /document\.querySelector/, /document\.getElementById/, /document\.getElementsBy/,
  /\.classList\./, /\.innerHTML\s*=/, /\.style\./, /DOMContentLoaded/,
  /\$\s*\(\s*['"`#.\[]/, /jQuery\s*\(/,
];

/** Returns true if script content is only comments / whitespace (nothing executable). */
function isEffectivelyEmpty(content) {
  if (!content) return true;
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .replace(/\/\/[^\n]*/g, '')          // line comments
    .trim();
  return stripped.length === 0;
}

function isExternalSrc(src) {
  if (!src) return true;
  return src.startsWith('http://') || src.startsWith('https://') ||
    src.startsWith('//') || src.startsWith('data:') || src.startsWith('blob:');
}

function hasInteractiveCode(content) {
  if (!content) return false;
  return DOM_ACCESS_PATTERNS.some(p => p.test(content));
}

function isFormHandler(content) {
  if (!content) return false;
  return FORM_HANDLER_PATTERNS.some(p => p.test(content));
}

/**
 * Strict whitelist check: a script is UI-interactive ONLY IF it has BOTH
 * a UI trigger (user event / timer / page init) AND a DOM mutation (classList,
 * style, innerHTML, etc.) — AND none of the disqualifiers apply.
 *
 * Disqualifiers (→ remove even with DOM access):
 *   • matches inline tracking patterns (FB pixel, GTM, etc.)
 *   • makes network requests (form handler)
 *   • dynamically injects <script> elements (loader/tracker bootstrap)
 *
 * This is intentionally strict: false negatives (keeping a junk script) are
 * worse than false positives here — the dev can restore needed scripts from
 * the Removed Scripts tab, but broken UI is silent and hard to debug.
 */
function analyzeScriptInteractivity(content) {
  if (!content) return false;

  // Disqualifiers — order matters: check these first
  if (INLINE_TRACKING_PATTERNS.some(p => p.test(content))) return false;
  if (isFormHandler(content)) return false;
  if (SCRIPT_LOADER_PATTERNS.some(p => p.test(content))) return false;

  // Path A: explicitly initializes a known UI library (Swiper, AOS, GSAP, etc.)
  if (UI_LIBRARY_INIT_PATTERNS.some(p => p.test(content))) return true;

  // Path B: has both a user-facing trigger AND a visible DOM mutation
  const hasTrigger  = UI_TRIGGER_PATTERNS.some(p => p.test(content));
  const hasMutation = DOM_MUTATION_PATTERNS.some(p => p.test(content));
  return hasTrigger && hasMutation;
}

/**
 * Second pass: mark critical libraries as 'remove' if no surviving (interactive) script uses them.
 * e.g. jQuery is removed if all scripts that used it were already classified as form handlers.
 * Scripts must have _content field (full JS content) populated before calling this.
 */
function resolveLibraryDependencies(scripts) {
  // Collect full content of all interactive scripts (the ones that will survive)
  const survivorContents = scripts
    .filter(s => s.isInteractive)
    .map(s => s._content)
    .filter(Boolean);

  return scripts.map(s => {
    if (!s.isCritical) return s;

    const libKey = getLibraryKey(s.src);
    // Unknown critical lib (main.js, app.js, bundle.js) — keep conservatively
    if (!libKey || !LIBRARY_API_PATTERNS[libKey]) return s;

    const patterns = LIBRARY_API_PATTERNS[libKey];
    const isUsed = survivorContents.some(c => patterns.some(p => p.test(c)));

    if (!isUsed) {
      // No surviving script uses this library → it's an orphaned dependency
      return { ...s, suggestion: 'remove', isOrphanDependency: true };
    }
    return s;
  });
}

/**
 * Extract all <script> tags with metadata for display.
 * Pass sessionDir to enable reading local JS files for interactivity analysis.
 */
function extractScripts(html, sessionDir) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const scripts = [];

  $('script').each((i, el) => {
    const $el = $(el);
    const src = $el.attr('src') || null;
    const type = $el.attr('type') || 'text/javascript';
    const fullInline = !src ? $el.html()?.trim() : null;
    const inline = fullInline ? fullInline.slice(0, 200) : null;
    // Empty or all-comment script tag — remove immediately
    if (!src && isEffectivelyEmpty(fullInline)) {
      scripts.push({ id: `script-${i}`, index: i, src: null, type, inline: null,
        isTracking: false, isCritical: false, isFormHandler: false, isInteractive: false,
        isOrphanDependency: false, suggestion: 'remove', _content: null });
      return;
    }

    // Check src-based patterns
    const isTrackingBySrc = src ? TRACKING_PATTERNS.some((p) => p.test(src)) : false;
    const isFormLibBySrc  = src ? FORM_LIB_PATTERNS.some((p) => p.test(src)) : false;
    const isCritical = src ? CRITICAL_PATTERNS.some((p) => p.test(src)) : false;
    // Any external script not matched by a known-safe pattern is treated as tracking
    const isExternalUnknown = !isTrackingBySrc && src && isExternalSrc(src) && !isCritical && !isFormLibBySrc;

    // Read content for analysis (skip known external trackers — no need)
    let scriptContent = null;
    if (!isTrackingBySrc && !isExternalUnknown) {
      scriptContent = fullInline;
      if (!scriptContent && src && !isExternalSrc(src) && sessionDir) {
        try {
          const localPath = path.join(sessionDir, src.replace(/^\.\//, ''));
          scriptContent = fs.readFileSync(localPath, 'utf-8');
        } catch {}
      }
      // Local file that's entirely comments — treat as empty → remove
      if (src && isEffectivelyEmpty(scriptContent)) {
        scripts.push({ id: `script-${i}`, index: i, src, type, inline: null,
          isTracking: false, isCritical: false, isFormHandler: false, isInteractive: false,
          isExternalUnknown: false, isOrphanDependency: false, suggestion: 'remove', _content: null });
        return;
      }
    }

    // Check content-based tracking patterns (inline pixels: FB, GTM, GA, etc.)
    const isTrackingByContent = !isTrackingBySrc && !isExternalUnknown && !src &&
      INLINE_TRACKING_PATTERNS.some(p => p.test(scriptContent || ''));

    const isTracking = isTrackingBySrc || isExternalUnknown || isTrackingByContent;

    // Skip content-based form detection for known UI libraries (they implement $.ajax etc. internally)
    const isFormHandlerScript = !isTracking && !isCritical && (isFormLibBySrc || isFormHandler(scriptContent));
    const isInteractive = !isTracking && !isFormHandlerScript && analyzeScriptInteractivity(scriptContent);

    const suggestion = (isTracking || isFormHandlerScript) ? 'remove'
      : (isCritical || isInteractive) ? 'keep'
      : 'review';

    scripts.push({
      id: `script-${i}`,
      index: i,
      src,
      type,
      inline,
      isTracking,
      isExternalUnknown: !!isExternalUnknown,
      isCritical,
      isFormHandler: isFormHandlerScript,
      isInteractive,
      isOrphanDependency: false,
      suggestion,
      _content: scriptContent, // full content for dependency resolution — stripped before returning
    });
  });

  // Collect <noscript> tags — always remove, show in Scripts tab
  const noscripts = [];
  $('noscript').each((i, el) => {
    const preview = ($(el).html() || '').trim().slice(0, 200);
    noscripts.push({
      id: `noscript-${i}`,
      index: i,
      src: null, type: null,
      inline: preview || '(empty)',
      isTracking: false, isCritical: false, isFormHandler: false, isInteractive: false,
      isOrphanDependency: false, isNoscript: true, suggestion: 'remove',
      content: null,
    });
  });

  // Second pass: drop critical libraries whose users were all removed
  const resolved = resolveLibraryDependencies(scripts);

  // Expose full content for Dev mode expand; strip only internal marker name
  return [
    ...resolved.map(({ _content, ...s }) => ({ ...s, content: _content || null })),
    ...noscripts,
  ];
}

/**
 * Remove scripts by their index in the document.
 * Returns removed entries with full outerHtml and position for later restore.
 */
function removeScripts(html, scriptIndicesToRemove) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const toRemove = new Set(scriptIndicesToRemove.map(Number));
  const removed = [];

  $('script').each((i, el) => {
    if (toRemove.has(i)) {
      const $el = $(el);
      const src = $el.attr('src') || null;
      const outerHtml = $.html(el);
      const inlineContent = !src ? $el.html()?.trim() : null;
      const inHead = $el.closest('head').length > 0;
      removed.push({ index: i, src, outerHtml, inlineContent, position: inHead ? 'head' : 'body' });
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

// ── Head cleanup ──────────────────────────────────────────────────────────────

/**
 * Classify a single <head> element for the head-items list.
 * Returns null if the element should be skipped (kept without question).
 */
function _classifyHeadElement($, el) {
  const tag = el.tagName.toLowerCase();
  const $el = $(el);

  if (tag === 'script') {
    const src  = $el.attr('src') || null;
    const type = ($el.attr('type') || '').toLowerCase().trim();

    if (type === 'application/ld+json') {
      const preview = ($el.html() || '').trim().slice(0, 150);
      return { tag, subtype: 'jsonld', label: preview || '(empty)', suggestion: 'remove' };
    }
    // External scripts are handled entirely by the Scripts tab
    return null;
  }

  if (tag === 'link') {
    const href = ($el.attr('href') || '').trim();
    const rel  = ($el.attr('rel') || '').toLowerCase().trim();
    // Manifest — always remove regardless of local/external href
    if (rel === 'manifest') {
      return { tag, subtype: 'manifest', label: href || '(no href)', rel, suggestion: 'remove' };
    }
    // Only process external hrefs from here on
    if (!href || !isExternalSrc(href)) return null;
    const isFont = FONT_CDN_PATTERNS.some(p => p.test(href));
    return { tag, subtype: 'external-link', label: href, rel, isFont,
             suggestion: isFont ? 'keep' : 'remove' };
  }

  if (tag === 'meta') {
    const name     = ($el.attr('name')     || '').toLowerCase().trim();
    const property = ($el.attr('property') || '').toLowerCase().trim();
    const charset  = $el.attr('charset');
    // Always keep: charset and viewport
    if (charset || name === 'viewport') return null;
    const label = property ? `property="${property}"` :
                  name     ? `name="${name}"`         : '(meta)';
    return { tag, subtype: 'meta', label, property: property || null,
             name: name || null, suggestion: 'remove' };
  }

  return null;
}

/**
 * Extract head elements that are candidates for removal (for Dev mode UI).
 */
function extractHeadItems(html) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const items = [];
  $('head').find('script, link, meta').each((_, el) => {
    const item = _classifyHeadElement($, el);
    if (item) items.push({ ...item, index: items.length });
  });
  return items;
}

/**
 * Remove head items by their index (as returned by extractHeadItems).
 */
function cleanHeadItems(html, indicesToRemove) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const toRemove = new Set(indicesToRemove.map(Number));
  const stats = { jsonld: 0, externalLinks: 0, meta: 0, manifest: 0 };
  let idx = 0;

  $('head').find('script, link, meta').each((_, el) => {
    const item = _classifyHeadElement($, el);
    if (!item) return;
    if (toRemove.has(idx)) {
      if      (item.subtype === 'jsonld')                                          stats.jsonld++;
      else if (item.subtype === 'external-link' || item.subtype === 'manifest')   stats.externalLinks++;
      else if (item.subtype === 'meta')                                           stats.meta++;
      $(el).remove();
    }
    idx++;
  });

  return { html: $.html(), stats };
}

/**
 * Fully automatic head clean — removes all items with suggestion 'remove'.
 * Used by auto-clean in Standard mode.
 */
function cleanHead(html) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const stats = { jsonld: 0, externalLinks: 0, meta: 0, noscript: 0 };

  $('head').find('script, link, meta').each((_, el) => {
    const item = _classifyHeadElement($, el);
    if (!item || item.suggestion !== 'remove') return;
    if      (item.subtype === 'jsonld')                                        stats.jsonld++;
    else if (item.subtype === 'external-link' || item.subtype === 'manifest')  stats.externalLinks++;
    else if (item.subtype === 'meta')                                          stats.meta++;
    $(el).remove();
  });

  // Remove all <noscript> tags (anywhere in document)
  $('noscript').each((_, el) => { $(el).remove(); stats.noscript++; });

  const total = stats.jsonld + stats.externalScripts + stats.externalLinks + stats.meta + stats.noscript;
  return { html: $.html(), stats, total };
}

module.exports = { extractScripts, removeScripts, injectSnippet, detectInsertionPoints,
                   analyzeScriptInteractivity, extractHeadItems, cleanHeadItems, cleanHead };
