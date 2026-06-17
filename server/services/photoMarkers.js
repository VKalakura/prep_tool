/**
 * Detect layout lines like "ФОТО 1", "Photo 2" / "VIDEO 1", "Відео 2" in a pasted brief
 * (first occurrence order per slot number, unique slot numbers).
 */

function parsePhotoMarkers(brief) {
  const text = String(brief || '');
  const re = /(?:^|[\r\n])\s*(фото|photo)\s*(\d+)/gi;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    const num = parseInt(m[2], 10);
    if (!Number.isFinite(num) || num < 1 || seen.has(num)) continue;
    seen.add(num);
    const kind = m[1].toLowerCase();
    const label = kind === 'photo' ? `Photo ${num}` : `ФОТО ${num}`;
    out.push({ num, label });
  }
  return out;
}

function parseVideoMarkers(brief) {
  const text = String(brief || '');
  const re = /(?:^|[\r\n])\s*(відео|видео|video)\s*(\d+)/gi;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    const num = parseInt(m[2], 10);
    if (!Number.isFinite(num) || num < 1 || seen.has(num)) continue;
    seen.add(num);
    const kind = m[1].toLowerCase();
    const label = kind === 'video' ? `Video ${num}` : kind === 'видео' ? `Видео ${num}` : `Відео ${num}`;
    out.push({ num, label });
  }
  return out;
}

/**
 * Detect wireframe placeholder line "ФОРМА РЕГИСТРАЦИИ" / "ФОРМА РЕЄСТРАЦІЇ".
 *
 * The server uses this to decide whether to insert a fallback <p>ФОРМА РЕГИСТРАЦИИ</p>
 * paragraph when the page has no real <form> / lead-capture widget in the content
 * scope. If a form is present, the marker is silently dropped (handled by the
 * skip filter in articleToReplacements.js) and the existing form stays intact.
 *
 * Calculator hints are NO LONGER auto-detected — the operator should write them
 * as plain tagged copy in the brief, e.g.:
 *   p:Сделать калькулятор, как здесь
 *   a:https://example.com/calc
 *
 * @param {string} brief
 * @returns {{ needsForm: boolean, formText: string }}
 */
function parsePlaceholderMarkers(brief) {
  const text = String(brief || '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  // \b is ASCII-only in JS regex, so match Cyrillic words by start + simple lookahead instead.
  const FORM_RE = /^\s*форм[аи]\s+(регистрации|реєстрації)(?=$|[\s.,!?:;()-])/iu;

  let needsForm = false;
  let formText = '';

  for (let i = 0; i < lines.length; i++) {
    const l = (lines[i] || '').trim();
    if (!l) continue;
    if (!needsForm && FORM_RE.test(l)) {
      needsForm = true;
      formText = l;
      break;
    }
  }

  return {
    needsForm,
    formText: formText || 'ФОРМА РЕГИСТРАЦИИ',
  };
}

module.exports = { parsePhotoMarkers, parseVideoMarkers, parsePlaceholderMarkers };
