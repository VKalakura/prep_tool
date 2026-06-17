/**
 * Working zone resolution for the xAI flow.
 *
 * The operator picks the zone manually (iframe picker or typed CSS selector).
 * Whatever they pick IS the scope — no auto-detection, no chrome / nav /
 * sidebar heuristics, no publication-metadata guessing. If the selector is
 * empty or matches nothing, we fall back to <body> so callers can still emit
 * a clean error like "no editable blocks in this zone".
 *
 * The only defensive filter still applied inside scope is form / lead-capture
 * detection: even when the operator includes a <form> by accident, we never
 * let the AI rewrite form-internal copy (labels, submit-button text). That
 * would silently break the funnel and is hard to spot in preview.
 */

// Form-like containers AND form-adjacent labels (titles / headings / captions
// commonly placed next to a <form> as its visual heading) — both should NEVER
// be touched by AI text mapping.
const FORM_CLASS_RE = /(^|\s)(form-?wrapper|form-?container|form-?inner|form-?box|form-?feedback[a-z-]*|form-?title|form-?heading|form-?caption|form-?label[a-z-]*|register-?form|registration-?form|signup-?form|sign-?up-?form|optin-?form|opt-?in-?form|lead-?form|cta-?form|contact-?form|register-?block|registration-?block|signup-?block|optin-?block|lead-?block|hero-?form|order-?form|register-?title|signup-?title|optin-?title|lead-?title)(\s|$)/i;

function looksLikeForm($, node) {
  if (!node || node.type !== 'tag') return false;
  if ((node.name || '').toLowerCase() === 'form') return true;
  const $n = $(node);
  const cls = ($n.attr('class') || '').trim();
  if (cls && FORM_CLASS_RE.test(cls)) return true;
  const id = ($n.attr('id') || '').trim();
  if (id && FORM_CLASS_RE.test(id)) return true;
  return false;
}

function isUnderForm(el, $) {
  let cur = el;
  while (cur && cur.type === 'tag') {
    if (looksLikeForm($, cur)) return true;
    cur = cur.parent;
  }
  return false;
}

function isDescendantOf(ancestor, el) {
  let cur = el;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parent;
  }
  return false;
}

function tryCustomSelector($, sel) {
  if (!sel || typeof sel !== 'string') return null;
  const trimmed = sel.trim();
  if (!trimmed) return null;
  try {
    const $found = $(trimmed).first();
    if ($found.length && $found[0]) return $found[0];
  } catch (_) { /* invalid selector */ }
  return null;
}

function shortLabelFor($, node) {
  if (!node) return 'body';
  const tag = (node.name || 'div').toLowerCase();
  if (tag === 'body' || tag === 'main' || tag === 'article') return tag;
  const $n = $(node);
  if ($n.attr('role') === 'main') return '[role="main"]';
  const id = ($n.attr('id') || '').trim();
  if (id) return `${tag}#${id}`;
  const cls = ($n.attr('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
  if (cls) return `${tag}.${cls}`;
  const dti = ($n.attr('data-test-id') || $n.attr('data-testid') || '').trim();
  if (dti) return `${tag}[data-test-id="${dti}"]`;
  return tag;
}

/**
 * CSS nth-child path from a node up to <html>, matching iframe buildEptPath
 * (element siblings only).
 */
function buildEptPathCheerio(el) {
  const parts = [];
  let cur = el;
  while (cur && cur.type === 'tag') {
    const tag = (cur.name || 'div').toLowerCase();
    if (tag === 'html') break;
    const parent = cur.parent;
    if (!parent || !parent.children) {
      parts.unshift(tag);
      break;
    }
    const sibs = parent.children.filter((c) => c.type === 'tag');
    const idx = sibs.indexOf(cur) + 1;
    if (idx < 1) break;
    parts.unshift(`${tag}:nth-child(${idx})`);
    cur = parent;
  }
  return parts.join('>');
}

/**
 * Resolve the working zone.
 *   custom selector hits  → that element IS the scope.
 *   missing / no match    → <body>, so the route can still respond gracefully.
 *
 * Returns { node, label, selectorPath, usedCustom }.
 */
function resolveScope($, customSelector) {
  const fromCustom = tryCustomSelector($, customSelector);
  const node = fromCustom || $('body')[0] || null;
  const usedCustom = !!fromCustom;
  const label = shortLabelFor($, node);
  const selectorPath = node ? buildEptPathCheerio(node) : 'body';
  return { node, label, selectorPath, usedCustom };
}

/** True when the resolved scope contains any <form>-like / lead-capture container. */
function hasFormInScope($, customSelector) {
  const { node } = resolveScope($, customSelector);
  if (!node) return false;
  const $n = $(node);
  if (looksLikeForm($, node)) return true;
  if ($n.find('form').length) return true;
  let found = false;
  $n.find('*').each((_i, el) => {
    if (found) return;
    if (looksLikeForm($, el)) found = true;
  });
  return found;
}

/**
 * List editable text nodes inside the operator's chosen scope.
 *
 * Filters:
 *   - must be a descendant of the scope node;
 *   - must NOT sit inside a <form>-like / lead-capture container (defensive);
 *   - must have non-empty trimmed text.
 *
 * Plus a duplicate-text dedup pass: short identical strings repeated ≥2 times
 * are dropped from the AI list (decorative brand callouts, "×" close icons,
 * sidebar boilerplate). DOM is never modified by this filter — the operator's
 * preview just shows the meaningful copy.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @param {string} EDITABLE_SEL - comma-separated selectors (must match content.js)
 * @param {string} [customSelector] — CSS selector chosen by user.
 * @returns {{ scopeLabel: string, scopeSelectorPath: string, scopeUsedCustom: boolean,
 *             elements: { idx: number, tag: string, text: string }[] }}
 */
function getContentScopedEditables($, EDITABLE_SEL, customSelector) {
  const { node: scopeNode, label, selectorPath, usedCustom } = resolveScope($, customSelector);

  const raw = [];
  $(EDITABLE_SEL).each((i, el) => {
    if (!scopeNode || !isDescendantOf(scopeNode, el)) return;
    if (isUnderForm(el, $)) return;
    // Drop site-chrome inside the picked scope: category epigraphs ("Noticia"),
    // share / save / report toolbar, comment-count chips, related-articles
    // cards, social icons, recommended-news rails. Same filter as for images
    // — non-article noise is NEVER what the operator's pasted paragraphs
    // should land on, regardless of whether the noise sits IN scope.
    if (nodeHasNonArticleSignal($, el)) return;
    if (isInsideNonArticleContainer($, el, scopeNode)) return;
    const text = $(el).text().trim();
    if (!text) return;
    raw.push({ idx: i, tag: (el.name || '').toLowerCase(), text, el });
  });

  // Dedup wrapper / wrapped pairs. Common templates render <li><p>…</p></li>
  // (or <div><p>…</p></div>) where BOTH the parent <li> and the inner <p>
  // match the editable selector and report the SAME trimmed text. Keeping
  // both means the operator's paragraph is written twice (once into the
  // child, then the parent's replaceContent wipes the child's tags). Drop
  // the wrapper, keep the inner editable — it's the semantic owner of the
  // copy and the wrapper's structure is preserved.
  const innerKeys = new Set();
  for (const r of raw) {
    let cur = r.el.parent;
    while (cur && cur !== scopeNode) {
      if (cur.type === 'tag') {
        const sameText = $(cur).text().trim() === r.text;
        if (sameText) innerKeys.add(`${cur.name}:${cur.startIndex || ''}:${$(cur).text().trim().slice(0, 50)}`);
      }
      cur = cur.parent;
    }
  }
  const filteredRaw = raw.filter((r) => {
    const key = `${r.el.name}:${r.el.startIndex || ''}:${r.text.slice(0, 50)}`;
    if (!innerKeys.has(key)) return true;
    // This raw element is a wrapper of an editable child carrying the same
    // text. Skip it.
    return false;
  });

  // Duplicate-text noise filter — VERY conservative now.
  // Rationale: legitimate articles often have short repeated copy that LOOKS
  // duplicate but is real content (Speaker labels: "Gustavo Petro:",
  // "Александар Вучић:"; CTA buttons: "Regístrese ahora"; numbered list
  // items "01", "02"…). Strict-pour treats those as real slots — drop them
  // here and the new article ends up with stale Spanish labels mid-text.
  // Only drop when ALL three are true: very short (≤6 chars), repeated 4+
  // times, AND no letters / digits (decorative glyphs like "×", "•", "→").
  const counts = new Map();
  for (const r of filteredRaw) counts.set(r.text, (counts.get(r.text) || 0) + 1);
  const elements = filteredRaw
    .filter((r) => {
      if (r.text.length > 6) return true;
      if ((counts.get(r.text) || 0) < 4) return true;
      if (/[\p{L}\p{N}]/u.test(r.text)) return true; // has letter/digit → real copy
      return false;
    })
    .map(({ idx, tag, text }) => ({ idx, tag, text }));

  return { scopeLabel: label, scopeSelectorPath: selectorPath, scopeUsedCustom: usedCustom, elements };
}

// Containers / classes that mark "page chrome" or "secondary navigation" —
// content inside these is NEVER what ФОТО N markers / paragraph slots should
// target. These tags trigger the filter even when nested INSIDE the picked
// scope (e.g. <article><aside class=related>… inside the article body).
const CHROME_TAGS = new Set(['header', 'footer', 'nav', 'aside']);

// Class / id fragments that consistently mark non-article noise.
// IMPORTANT: every fragment here MUST contain at least one '-' or be paired
// with one (so we don't accidentally match generic body wrappers like
// `c-articulo__compartir` whose suffix happens to overlap a single noise
// word — `compartir` alone is article body, `compartir-media` is the share
// toolbar). Matched against the element itself AND every ancestor up to scope.
//
// Used by BOTH the image filter (logos, avatars, related thumbs, social
// icons) AND the text-slot filter (share buttons, "Noticia" category chip,
// comment chips, related-articles cards).
const NON_ARTICLE_CLASS_RE = new RegExp(
  '(^|[\\s_-])(' +
  // Compound share / save / report / listen / summary / comment toolbars
  '(?:share|compartir|partager|social|reaccion|reaction)-(?:toolbar|bar|buttons?|icons?|actions?|block|widget|wrap|wrapper|media|panel|chip|row|menu|list|links?)|' +
  '(?:save|guardar|sauvegarder|report|reportar|signaler|listen|escuchar|read-aloud|tts|summary|resumen|aperçu)-(?:toolbar|bar|button|btn|chip|action|widget|block)|' +
  // Comment widgets — entire trees are non-article (Naver u_cbox, generic
  // comment-section/comment-content/comment-list/comment-block/comment-area).
  // Single-token "comment(s)" is also covered: <div class="comment"> wrappers
  // around third-party widgets are common.
  'u_cbox(?:[_-]|\\b)|' +
  '(?:comment|comments|comentar|comentarios)(?:[_-](?:toolbar|bar|count|counter|chip|widget|block|wrap|wrapper|button|btn|content|section|area|list|inner|item|feed|panel|module|main|body|header|footer|form|input|reply|tools|sort|info|likes?|dislikes?|count-?wrap|user|avatar|nick|name|date))?(?=[\\s_-]|$)|' +
  // Site chrome / structural
  '(?:^|c-)?(?:epigrafe|kicker|chrome)(?:_|-|__|\\b)|' +
  '(?:site|page|app|global)-(?:header|footer|nav|navigation|menu|chrome)|' +
  // Related / recommended / popular / trending rails
  '(?:related|relacion(?:ad)?o|recommend(?:ed|ation)?|recomend(?:ado|aciones)?|popular|trending|also-?read|read-?more|read-?next|more-?news|other-?news|other-?articles|previous-?next|prev-?next)(?:-|_|s\\b)|' +
  // Sidebars, widgets, breadcrumbs, menu / nav variants, cookies, banners, ads
  '(?:sidebar|side-bar|widget|breadcrumb|toolbar|cookie|cookies|subscribe|newsletter|paywall)(?:-|_|\\b)|' +
  '(?:advert(?:ising)?|advertis(?:ement)?|sponsored?|promo|banner)(?:-|_|\\b)|' +
  '(?:^|[_-])(?:ad|ads)[_-]|' +
  // Author / byline / profile chips
  '(?:author|byline|autor|profile|user-info|user-info)(?:-|_|\\b)|' +
  // Category / tag chips
  '(?:category|categoria|categori|tag-list|tag-cloud|tags-list|topic-list)(?:-|_|\\b)|' +
  // News-list / card grids, post-list rails (related & "popular" sections)
  '(?:news-list|list-news|post-list|post-card|news-card|item-card|teaser-card|card-grid|gallery-nav|carousel-nav|pagination)(?:-|_|\\b)|' +
  // Decorative whole tokens — these are always icons/logos/etc.
  '(?:logo|avatar|favicon|sprite|emoji|flag-icon|brand-mark)(?:-|_|\\b)' +
  ')(\\b|[\\s_-])',
  'i'
);

// Fragments inside the image's src that hint at "decorative" / "structural":
// site logo files, avatar uploads, sprite sheets, etc.
const NON_ARTICLE_SRC_RE = /(^|[\/_-])(logo|favicon|sprite|emoji|avatar|icon-|icons\/|brand|placeholder|loader|spinner)([._\-/]|$)/i;

function nodeHasNonArticleSignal($, node) {
  if (!node || node.type !== 'tag') return false;
  const $n = $(node);
  const cls = ($n.attr('class') || '').trim();
  if (cls && NON_ARTICLE_CLASS_RE.test(cls)) return true;
  const id = ($n.attr('id') || '').trim();
  if (id && NON_ARTICLE_CLASS_RE.test(id)) return true;
  return false;
}

/**
 * Walk up from `el` to the scope node. Return true if any ancestor is a
 * chrome tag (header / footer / nav / aside) or has a class / id that flags
 * it as related-articles / sidebar / social / etc.
 */
function isInsideNonArticleContainer($, el, scopeNode) {
  let cur = el.parent;
  while (cur && cur !== scopeNode) {
    if (cur.type === 'tag') {
      const tag = (cur.name || '').toLowerCase();
      if (CHROME_TAGS.has(tag)) return true;
      if (nodeHasNonArticleSignal($, cur)) return true;
    }
    cur = cur.parent;
  }
  return false;
}

/**
 * In-flow image heuristic.
 * In-flow = image sits inside a paragraph / figure / picture, OR its
 * immediate container has a meaningful text-paragraph sibling. Decorative
 * stuff (logos, avatars, share icons, related thumbnails, sprites) is dropped.
 */
function looksLikeInFlowImage($, el, scopeNode) {
  if (!el || el.type !== 'tag') return false;
  if (nodeHasNonArticleSignal($, el)) return false;
  if (isInsideNonArticleContainer($, el, scopeNode)) return false;

  const $el = $(el);
  const src = ($el.attr('src') || '').trim();
  if (NON_ARTICLE_SRC_RE.test(src)) return false;

  const w = parseInt($el.attr('width') || '', 10);
  const h = parseInt($el.attr('height') || '', 10);
  if (Number.isFinite(w) && w > 0 && w < 100) return false;
  if (Number.isFinite(h) && h > 0 && h < 100) return false;

  const directParent = el.parent;
  const parentTag = directParent && directParent.type === 'tag' ? (directParent.name || '').toLowerCase() : '';
  if (parentTag === 'figure' || parentTag === 'picture') return true;

  let cur = el.parent;
  let depth = 0;
  while (cur && cur !== scopeNode && depth < 4) {
    if (cur.type === 'tag') {
      const tag = (cur.name || '').toLowerCase();
      if (tag === 'figure' || tag === 'picture' || tag === 'p') return true;
      if (tag === 'main' || tag === 'article' || tag === 'section') break;
    }
    cur = cur.parent;
    depth++;
  }

  // Last-chance signal: an immediate sibling of the wrapper carries a real
  // text paragraph (≥35 chars). That's the standard editorial pattern of
  // <img> followed by <p> inside an article body.
  const wrap = directParent && directParent.type === 'tag' ? directParent : el;
  const siblings = (wrap.parent && wrap.parent.children) || [];
  for (const s of siblings) {
    if (s === wrap) continue;
    if (s.type !== 'tag') continue;
    if ((s.name || '').toLowerCase() !== 'p') continue;
    const txt = $(s).text().trim();
    if (txt.length >= 35) return true;
  }
  return false;
}

/**
 * Article-body images inside the picked zone, in DOM order.
 *
 * Strict mode (default): keep only images that look like in-flow article
 * pictures — inside <figure>/<picture>/<p>, or paired with a real paragraph
 * sibling — and drop site chrome (logos, avatars, share icons, related cards,
 * sidebar thumbs, sprites). If strict filtering removes everything, the raw
 * unfiltered list is returned so the operator never ends up with an empty
 * picker on weird markup.
 */
function getScopedImages($, customSelector) {
  const { node: scopeNode } = resolveScope($, customSelector);
  const candidates = [];
  $('img').each((_i, el) => {
    if (!el || el.type !== 'tag') return;
    if (!scopeNode || !isDescendantOf(scopeNode, el)) return;
    if (isUnderForm(el, $)) return; // form logos / step icons are structural
    const src = $(el).attr('src') || '';
    if (!src.trim() || src.startsWith('data:')) return;
    candidates.push(el);
  });

  const strict = candidates.filter((el) => looksLikeInFlowImage($, el, scopeNode));
  const picked = strict.length ? strict : candidates;

  return picked.map((el, i) => {
    const src = $(el).attr('src') || '';
    const selectorPath = buildEptPathCheerio(el);
    const name = src.replace(/^\//, '').split('/').pop().split('?')[0] || `img-${i}`;
    return { selectorPath, src, name };
  });
}

/**
 * Article-body videos inside the picked zone, in DOM order.
 * Reuses the chrome / non-article filter so player cards in sidebars don't
 * sneak in. Videos rarely live in chrome anyway, so the filter is a no-op
 * on most pages.
 */
function getScopedVideos($, customSelector) {
  const { node: scopeNode } = resolveScope($, customSelector);
  const out = [];
  $('video').each((_i, el) => {
    if (!el || el.type !== 'tag') return;
    if (!scopeNode || !isDescendantOf(scopeNode, el)) return;
    if (isUnderForm(el, $)) return;
    if (nodeHasNonArticleSignal($, el)) return;
    if (isInsideNonArticleContainer($, el, scopeNode)) return;
    const $el = $(el);
    let src = ($el.attr('src') || '').trim();
    if (!src) {
      src = ($el.find('source').first().attr('src') || '').trim();
    }
    if (!src || src.startsWith('data:')) return;
    const selectorPath = buildEptPathCheerio(el);
    const name = src.replace(/^\//, '').split('/').pop().split('?')[0] || `video-${out.length}`;
    out.push({ selectorPath, src, name });
  });
  return out;
}

module.exports = {
  resolveScope,
  hasFormInScope,
  looksLikeForm,
  isUnderForm,
  getContentScopedEditables,
  getScopedImages,
  getScopedVideos,
  buildEptPathCheerio,
  nodeHasNonArticleSignal,
  isInsideNonArticleContainer,
};
