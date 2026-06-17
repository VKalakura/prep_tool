/**
 * Session retention policy.
 *
 * Two limits, enforced together:
 *   - TTL: a session inactive for longer than SESSION_TTL_MS is removed.
 *   - CAP: at most MAX_SESSIONS sessions are kept; when there are more, the
 *     least-recently-active ones are evicted until only MAX_SESSIONS remain.
 *
 * "Activity" = `lastActivity` from the session's _session_meta.json (written by
 * activityLogger on every action) and falls back to the directory mtime for a
 * brand-new session that has not logged anything yet.
 *
 * Used in two places:
 *   - index.js: on boot + on a periodic timer.
 *   - upload.js: right after a new session's files land, with keepId set to the
 *     new session so the cap never deletes the offer being uploaded.
 */

const path = require('path');
const fs = require('fs');

const SESSIONS_DIR = path.join(__dirname, '../sessions');
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_SESSIONS = 5;

function lastActivityOf(dir) {
  let ts;
  try {
    ts = fs.statSync(dir).mtime.getTime();
  } catch {
    return 0;
  }
  const metaPath = path.join(dir, '_session_meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      if (meta.lastActivity) ts = new Date(meta.lastActivity).getTime();
    } catch { /* keep mtime fallback */ }
  }
  return ts;
}

function listSessionDirs() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(SESSIONS_DIR, e.name);
      return { name: e.name, dir, lastActivity: lastActivityOf(dir) };
    });
}

function removeSession(dir, name, reason) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`[cleanup] Removed session ${name} (${reason})`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply the retention policy. Returns the number of sessions removed.
 * @param {string} [keepId] session id that must survive regardless of TTL/cap
 *   (the session being created or actively used during this call).
 */
function cleanupSessions(keepId) {
  const now = Date.now();
  let removed = 0;

  // 1. TTL — drop sessions inactive longer than the window (keepId exempt).
  const survivors = [];
  for (const s of listSessionDirs()) {
    if (s.name !== keepId && now - s.lastActivity > SESSION_TTL_MS) {
      if (removeSession(s.dir, s.name, 'expired > 2h')) removed++;
    } else {
      survivors.push(s);
    }
  }

  // 2. CAP — keep the MAX_SESSIONS most-recently-active, evict the rest.
  if (survivors.length > MAX_SESSIONS) {
    survivors.sort((a, b) => b.lastActivity - a.lastActivity);
    const keep = new Set();
    if (keepId) keep.add(keepId); // reserve a slot for the active session
    for (const s of survivors) {
      if (keep.size >= MAX_SESSIONS) break;
      keep.add(s.name);
    }
    for (const s of survivors) {
      if (!keep.has(s.name) && removeSession(s.dir, s.name, 'over cap (max 5)')) removed++;
    }
  }

  if (removed) console.log(`[cleanup] Removed ${removed} session(s) total`);
  return removed;
}

module.exports = { cleanupSessions, SESSIONS_DIR, SESSION_TTL_MS, MAX_SESSIONS };
