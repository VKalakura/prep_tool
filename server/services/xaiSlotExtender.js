/**
 * Slot auto-extension for xAI flow.
 *
 * Problem: operator's brief sometimes carries more chunks than the page layout
 * has slots. Old behaviour: extra chunks were merged or dropped.
 * New behaviour: clone an existing slot of the matching tag right after itself
 * (preserving class / style / structural markup) and let Grok fill the clones
 * — "the same kind by analogy until all the text is placed".
 *
 * Architecture
 *   xai-suggest:
 *     1. Resolve scope & list editable slots (existing helper).
 *     2. planSlotExtension({ taggedChunks, slots }) → array of clone plans.
 *     3. applySlotExtensionPlan($, plan, EDITABLE_SEL) — mutates the in-memory
 *        cheerio DOM with the clones.
 *     4. listScopedEditablesPostExtension($, EDITABLE_SEL, customSelector) —
 *        returns the post-extension slot list (clones included, dedup filter
 *        bypassed for cloned nodes so they survive).
 *     5. Build prompt + call Grok using the extended slot list.
 *     6. Return { plan, slotsCloned } in the suggest response.
 *
 *   xai-apply:
 *     1. Re-load HTML from disk.
 *     2. applySlotExtensionPlan($, plan, EDITABLE_SEL) — same plan, same order,
 *        deterministic idx mapping.
 *     3. Apply text replacements via $(EDITABLE_SEL).eq(idx).
 *     4. Save to disk. (Existing /undo backup still covers the whole change.)
 */

const {
  resolveScope,
  isUnderForm,
  nodeHasNonArticleSignal,
  isInsideNonArticleContainer,
} = require('./xaiScope');

const CLONE_MARKER_ATTR = 'data-ept-cloned';

function isDescendantOf(ancestor, el) {
  let cur = el;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parent;
  }
  return false;
}

/**
 * Compute clone plan when brief has more chunks than the scope has slots.
 *
 * Rules:
 *   - Per-tag explicit demand: if brief says 4×p but scope has 2×p, plan adds
 *     2 clones of the LAST <p> in scope.
 *   - Untagged overflow: if total untagged chunks exceed remaining capacity
 *     (slots - explicitly-matched-tagged), clone the last <p> (or <li>, or
 *     last slot of any tag) by the deficit.
 *   - When NO slot of a requested tag exists at all, the closest semantic
 *     neighbour is preferred via the prompt's tag-fallback rules — we don't
 *     try to fabricate a tag here.
 *
 * @param {{ taggedChunks: {tag?: string, text: string}[], slots: {idx:number, tag:string}[] }}
 * @returns {{ sourceIdx: number, count: number, tag: string }[]}
 */
function planSlotExtension({ taggedChunks, slots }) {
  if (!Array.isArray(taggedChunks) || !Array.isArray(slots) || !slots.length) return [];

  const slotsByTag = new Map();
  for (const s of slots) {
    if (!slotsByTag.has(s.tag)) slotsByTag.set(s.tag, []);
    slotsByTag.get(s.tag).push(s);
  }

  const taggedDemand = new Map();
  for (const c of taggedChunks) {
    if (c && c.tag) {
      taggedDemand.set(c.tag, (taggedDemand.get(c.tag) || 0) + 1);
    }
  }

  const plan = [];

  for (const [tag, need] of taggedDemand) {
    const have = (slotsByTag.get(tag) || []).length;
    if (need > have && have > 0) {
      const last = slotsByTag.get(tag).slice(-1)[0];
      plan.push({ sourceIdx: last.idx, count: need - have, tag });
    }
  }

  const untagged = taggedChunks.filter((c) => c && !c.tag).length;
  if (untagged > 0) {
    let matchedTagged = 0;
    for (const [tag, need] of taggedDemand) {
      matchedTagged += Math.min(need, (slotsByTag.get(tag) || []).length);
    }
    const availableForUntagged = slots.length - matchedTagged;
    const deficit = untagged - availableForUntagged;
    if (deficit > 0) {
      const fallback = (slotsByTag.get('p') || []).slice(-1)[0]
        || (slotsByTag.get('li') || []).slice(-1)[0]
        || slots[slots.length - 1];
      if (fallback) {
        plan.push({ sourceIdx: fallback.idx, count: deficit, tag: fallback.tag });
      }
    }
  }

  return plan;
}

/**
 * Apply clone plan to cheerio DOM. Mutates $ in-place.
 *
 * Order: descending sourceIdx, so insertions don't shift earlier source
 * positions in subsequent iterations. Each clone is marked with
 * data-ept-cloned="1"; its inner content is replaced by a zero-width unique
 * placeholder so the post-extension scan sees it as a distinct fresh slot.
 *
 * @returns {number} total clones inserted.
 */
function applySlotExtensionPlan($, plan, EDITABLE_SEL) {
  if (!plan || !plan.length) return 0;
  const sorted = [...plan].sort((a, b) => b.sourceIdx - a.sourceIdx);
  let total = 0;
  for (const item of sorted) {
    const sourceIdx = Number(item.sourceIdx);
    const count = Number(item.count);
    if (!Number.isInteger(sourceIdx) || sourceIdx < 0) continue;
    if (!Number.isInteger(count) || count <= 0) continue;
    const source = $(EDITABLE_SEL).eq(sourceIdx);
    if (!source.length) continue;
    let anchor = source;
    for (let i = 0; i < count; i++) {
      const clone = source.clone();
      clone.attr(CLONE_MARKER_ATTR, '1');
      clone.empty();
      clone.text(' '); // single non-empty char, distinct from source so dedup logic stays sane
      anchor.after(clone);
      anchor = clone;
      total++;
    }
  }
  return total;
}

/**
 * Like getContentScopedEditables but tailored for the post-extension scan:
 * - Includes elements marked data-ept-cloned even when their text is blank.
 * - Bypasses the duplicate-text noise filter for cloned nodes (a cloned slot
 *   whose source had short repeated text would otherwise be silently dropped).
 *
 * Original duplicate-text noise filtering still applies to non-cloned nodes,
 * preserving existing behaviour for normal pages without extension.
 */
function listScopedEditablesPostExtension($, EDITABLE_SEL, customSelector) {
  const { node: scopeNode, label, selectorPath, usedCustom } = resolveScope($, customSelector);

  const raw = [];
  $(EDITABLE_SEL).each((i, el) => {
    if (!scopeNode || !isDescendantOf(scopeNode, el)) return;
    if (isUnderForm(el, $)) return;
    const $el = $(el);
    const isCloned = $el.attr(CLONE_MARKER_ATTR) === '1';
    // Same site-chrome filter as getContentScopedEditables (kept in sync so
    // post-extension rescan doesn't accidentally re-include "Noticia" labels,
    // share toolbars or comment chips after we cloned a trailing slot).
    // Cloned nodes bypass this check — they were created intentionally and
    // inherit a marker class only by accident.
    if (!isCloned && nodeHasNonArticleSignal($, el)) return;
    if (!isCloned && isInsideNonArticleContainer($, el, scopeNode)) return;
    const text = $el.text().trim();
    if (!isCloned && !text) return;
    // Skip cloned <a> wrappers that exist solely to hold a media element
    // (apply-photo-markers creates <a data-ept-cloned><img></a> shells).
    // Treating them as text slots would confuse the AI.
    if (isCloned && (el.name || '').toLowerCase() === 'a') {
      const onlyMedia = $el.children().toArray().every((c) => {
        const n = (c.name || '').toLowerCase();
        return n === 'img' || n === 'video' || n === 'picture' || n === 'source';
      });
      if (onlyMedia && !text) return;
    }
    raw.push({ idx: i, tag: (el.name || '').toLowerCase(), text, cloned: isCloned, el });
  });

  // Wrapper / wrapped dedup — same logic as getContentScopedEditables. A
  // <li><p>same text</p></li> pair is treated as a single editable and we
  // keep the inner element (its replaceContent doesn't blow away the parent
  // structure). Cloned wrappers also get deduped if they happen to clone an
  // <li> whose only child <p> exists.
  const wrapperKeys = new Set();
  for (const r of raw) {
    let cur = r.el.parent;
    while (cur && cur !== scopeNode) {
      if (cur.type === 'tag') {
        const sameText = $(cur).text().trim() === r.text;
        if (sameText) wrapperKeys.add(`${cur.name}:${cur.startIndex || ''}:${$(cur).text().trim().slice(0, 50)}`);
      }
      cur = cur.parent;
    }
  }
  const filteredRaw = raw.filter((r) => {
    const key = `${r.el.name}:${r.el.startIndex || ''}:${r.text.slice(0, 50)}`;
    return !wrapperKeys.has(key);
  });

  // Same conservative dedup rule as getContentScopedEditables: drop ONLY
  // decorative repeated glyphs (≤6 chars, 4+ repeats, no letter/digit).
  // Speaker labels like "Gustavo Petro:" or repeated CTA text are real copy.
  const counts = new Map();
  for (const r of filteredRaw) {
    if (r.cloned) continue;
    counts.set(r.text, (counts.get(r.text) || 0) + 1);
  }
  const elements = filteredRaw
    .filter((r) => {
      if (r.cloned) return true;
      if (r.text.length > 6) return true;
      if ((counts.get(r.text) || 0) < 4) return true;
      if (/[\p{L}\p{N}]/u.test(r.text)) return true;
      return false;
    })
    .map(({ idx, tag, text, cloned }) => ({ idx, tag, text, cloned }));

  return {
    scopeLabel: label,
    scopeSelectorPath: selectorPath,
    scopeUsedCustom: usedCustom,
    elements,
  };
}

/**
 * Inline style merger: replace any existing `width:` declaration with
 * `width:100%` (and ensure `height:auto` so aspect ratio is preserved).
 * Other rules in the source's style attribute are kept as-is.
 */
function forceFullWidthStyle(existing) {
  const cleaned = String(existing || '')
    .replace(/(?:^|;)\s*width\s*:\s*[^;]+;?/gi, '')
    .replace(/(?:^|;)\s*height\s*:\s*[^;]+;?/gi, '')
    .trim()
    .replace(/^;+/, '')
    .replace(/;+$/, '');
  const prefix = cleaned ? `${cleaned};` : '';
  return `${prefix}width:100%;height:auto`;
}

/**
 * Clone a media element (img / video) so a missing FOTO N / VIDEO N marker
 * can land somewhere that visually matches the existing layout.
 *
 * <img> clones get an opinionated wrapping treatment so they fit a typical
 * editorial article layout out of the box:
 *   - clone is wrapped in <a data-ept-cloned="1"> (apply-photo-markers will
 *     later set href to the uploaded image path → click-to-open lightbox);
 *   - inline style is forced to `width:100%;height:auto` and the legacy
 *     width / height HTML attrs are stripped, so a 350×233 thumbnail clone
 *     stretches to the article column instead of staying tiny;
 *   - if the source <img> sat inside its own <a> already, the new wrapper is
 *     inserted as a SIBLING of that parent <a> so we never produce nested
 *     <a> elements (invalid HTML).
 *
 * <video> clones keep wrapper-level attributes but lose their own src and any
 * <source> children — those are repopulated by apply-video-markers.
 *
 * Returns the inserted clones' selector paths (post-clone) so the caller can
 * upload files into them straight away.
 *
 * NOTE: This function is invoked at apply time, not suggest, because media
 * markers only become real slots once the operator actually picks files.
 */
function extendMediaInScope($, scopeNode, tagName, count, buildPath, templateEl) {
  if (!scopeNode || !count || count <= 0) return [];
  // Caller may pass an explicit template (e.g. last in-flow article photo
  // returned by getScopedImages — we want to clone THAT, not the very last
  // <img> in scope which is often a footer share-toolbar icon and would be
  // discarded by the in-flow filter on the next rescan).
  let lastEl = (templateEl && templateEl.type === 'tag') ? templateEl : null;
  if (!lastEl) {
    $(tagName).each((_i, el) => {
      if (!el || el.type !== 'tag') return;
      if (!isDescendantOf(scopeNode, el)) return;
      if (isUnderForm(el, $)) return;
      if (nodeHasNonArticleSignal($, el)) return;
      if (isInsideNonArticleContainer($, el, scopeNode)) return;
      lastEl = el;
    });
  }
  if (!lastEl) return [];
  const $source = $(lastEl);

  // Pick the right insertion anchor:
  //   - source <img> inside an <a> → insert sibling AFTER the parent <a>
  //     (avoids nested <a> elements which are invalid HTML);
  //   - otherwise → insert right after the source element itself.
  let anchor = $source;
  const sourceParent = $source.parent();
  if (
    tagName === 'img'
    && sourceParent.length
    && sourceParent.get(0)
    && (sourceParent.get(0).name || '').toLowerCase() === 'a'
  ) {
    anchor = sourceParent;
  }

  const inserted = [];
  for (let i = 0; i < count; i++) {
    const clone = $source.clone();
    clone.attr(CLONE_MARKER_ATTR, '1');

    if (tagName === 'img') {
      clone.removeAttr('src');
      clone.removeAttr('width');
      clone.removeAttr('height');
      ['data-src', 'data-srcset', 'srcset', 'data-lazy', 'data-original',
       'data-lazy-src', 'data-full', 'data-sizes', 'sizes'].forEach((a) => clone.removeAttr(a));
      clone.attr('style', forceFullWidthStyle(clone.attr('style')));

      // Wrap each clone in its own <a> (no href yet — apply-photo-markers
      // populates href once the upload lands so the link points to the new
      // image, lightbox-style).
      const wrapper = $('<a></a>');
      wrapper.attr(CLONE_MARKER_ATTR, '1');
      wrapper.append(clone);
      anchor.after(wrapper);
      anchor = wrapper;
      if (typeof buildPath === 'function') {
        const node = clone.get(0);
        if (node) inserted.push(buildPath(node));
      }
      continue;
    }

    if (tagName === 'video') {
      clone.removeAttr('src');
      clone.find('source').remove();
    }
    anchor.after(clone);
    anchor = clone;
    if (typeof buildPath === 'function') {
      const node = clone.get(0);
      if (node) inserted.push(buildPath(node));
    }
  }
  return inserted;
}

module.exports = {
  CLONE_MARKER_ATTR,
  planSlotExtension,
  applySlotExtensionPlan,
  listScopedEditablesPostExtension,
  extendMediaInScope,
};
