/**
 * Pre-process the user's brief for AI-driven slot mapping.
 *
 * The brief MAY use explicit tag prefixes to tell the model which DOM slot
 * type each line belongs to. Supported prefixes (case-insensitive, ":" or "|"):
 *
 *   h1:  Headline goes here
 *   h2:  Section title
 *   h3:  Sub-section
 *   p:   Long paragraph of body copy …
 *   li:  List item
 *   a:   inline anchor / link text or URL
 *   button: CTA label
 *
 * Untagged lines are still accepted — the AI will infer the slot from content
 * length and the surrounding context. Tagged lines always win over the skip
 * filter, so e.g. `a:https://example.com/x?id=5` is treated as anchor copy
 * even though a bare URL on its own line would normally be dropped.
 *
 * Skip filter is intentionally minimal:
 *   - ФОТО N / PHOTO N / ВІДЕО N / VIDEO N → media markers (popup),
 *   - ФОРМА РЕГИСТРАЦИИ / ФОРМА РЕЄСТРАЦІЇ → form placeholder.
 *
 * Everything else (Сделать калькулятор, brand mentions like "CNN Portugal",
 * bare URLs, etc.) is now real copy — tag it explicitly if you want it placed
 * in a specific slot, or leave it untagged for the AI to decide.
 */

const TAGGED_RE = /^(h[1-6]|p|li|a|button)\s*[:|]\s*(.+?)\s*$/i;

const MEDIA_MARKER_RE = /^\s*(фото|photo|відео|видео|video)(\s*\d+)?\s*$/i;
const FORM_MARKER_LINE = /^форм[аи]\s+(регистрации|реєстрації)(?=$|[\s.,!?:;()-])/iu;
const SEPARATOR_LINE = /^[\s\-–—_=]+$/;

function shouldSkipLine(line) {
  const t = String(line || '').trim();
  if (!t) return true;
  if (MEDIA_MARKER_RE.test(t)) return true;
  if (FORM_MARKER_LINE.test(t)) return true;
  if (SEPARATOR_LINE.test(t)) return true;
  return false;
}

/**
 * Parse brief into ordered chunks with optional explicit tag.
 * Multi-line untagged paragraphs are joined into a single chunk; a new tagged
 * line always starts a fresh chunk.
 *
 * @param {string} brief
 * @returns {{ tag: string|null, text: string }[]}
 */
function parseTaggedChunks(brief) {
  const lines = String(brief || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let buf = null;

  const flush = () => {
    if (buf && buf.text && buf.text.trim()) out.push({ tag: buf.tag, text: buf.text.trim() });
    buf = null;
  };

  for (const raw of lines) {
    const line = String(raw || '').trim();
    if (!line) { flush(); continue; }

    // Tag prefix wins over skip filter — tagged lines are always real copy.
    const m = line.match(TAGGED_RE);
    if (m) {
      flush();
      buf = { tag: m[1].toLowerCase(), text: m[2].trim() };
      continue;
    }

    if (shouldSkipLine(line)) { flush(); continue; }

    if (buf) {
      buf.text = `${buf.text} ${line}`.replace(/\s+/g, ' ').trim();
    } else {
      buf = { tag: null, text: line };
    }
  }
  flush();
  return out;
}

/** Backwards-compat: just the text per chunk (drops tag info). */
function parseArticleChunks(brief) {
  return parseTaggedChunks(brief).map((c) => c.text);
}

/**
 * Safe fallback used ONLY when the AI fails / returns invalid JSON.
 * Three-pass mapping that respects explicit tag prefixes:
 *   1) tagged chunks → next free slot of same tag (DOM order),
 *   2) untagged chunks → next free p/li slot,
 *   3) anything left → next free slot of any kind.
 *
 * @param {{ idx: number, tag: string, text: string }[]} elements
 * @param {string} brief
 * @returns {{ idx: number, text: string }[]}
 */
function buildFallbackAssignment(elements, brief) {
  if (!elements.length) return [];
  const chunks = parseTaggedChunks(brief);
  const out = elements.map((e) => ({ idx: e.idx, text: e.text }));
  if (!chunks.length) return out;

  const used = new Set();
  const consumed = new Set();

  const tryAssign = (chunkIdx, predicate) => {
    for (let i = 0; i < elements.length; i++) {
      if (used.has(i)) continue;
      if (predicate(elements[i])) {
        out[i].text = chunks[chunkIdx].text;
        used.add(i);
        consumed.add(chunkIdx);
        return true;
      }
    }
    return false;
  };

  // Pass 1: explicit tag → exact tag match.
  chunks.forEach((c, i) => {
    if (!c.tag) return;
    tryAssign(i, (el) => el.tag === c.tag);
  });

  // Pass 2: untagged chunks → next free p / li.
  chunks.forEach((c, i) => {
    if (consumed.has(i)) return;
    if (c.tag) return;
    tryAssign(i, (el) => el.tag === 'p' || el.tag === 'li');
  });

  // Pass 3: anything still unplaced → next free slot of any kind.
  chunks.forEach((c, i) => {
    if (consumed.has(i)) return;
    tryAssign(i, () => true);
  });

  return out;
}

module.exports = {
  parseArticleChunks,
  parseTaggedChunks,
  shouldSkipLine,
  buildFallbackAssignment,
};
