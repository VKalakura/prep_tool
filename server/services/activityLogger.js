const fs = require('fs');
const path = require('path');

const SESSIONS_DIR = path.join(__dirname, '../sessions');

function logActivity(sessionId, action, details = {}) {
  if (!sessionId || !/^[\w-]+$/.test(sessionId)) return;
  const sessionDir = path.join(SESSIONS_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) return;

  const logPath = path.join(sessionDir, '_activity_log.json');
  let log = [];
  if (fs.existsSync(logPath)) {
    try { log = JSON.parse(fs.readFileSync(logPath, 'utf-8')); } catch {}
  }

  log.push({ timestamp: new Date().toISOString(), action, ...details });
  if (log.length > 200) log = log.slice(-200);

  try {
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
    fs.writeFileSync(
      path.join(sessionDir, '_session_meta.json'),
      JSON.stringify({ lastActivity: new Date().toISOString() })
    );
  } catch {}
}

module.exports = { logActivity };
