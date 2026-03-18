const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const uploadRoutes = require('./routes/upload');
const processRoutes = require('./routes/process');
const widgetRoutes = require('./routes/widgets');
const phpRoutes = require('./routes/php');
const buildRoutes = require('./routes/build');
const contentRoutes = require('./routes/content');
const devRoutes = require('./routes/dev');

const app = express();
const PORT = process.env.PORT || 3001;
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  credentials: true,
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ─── Static: widgets and session assets for iframe preview ───────────────────
app.use('/widgets', express.static(path.join(__dirname, '../widgets')));

// Serve session assets (for preview iframe base href)
app.use('/session-files', (req, res, next) => {
  const normalized = path.normalize(req.path);
  const full = path.join(SESSIONS_DIR, normalized);
  // Path traversal guard
  if (!full.startsWith(SESSIONS_DIR + path.sep) && full !== SESSIONS_DIR) {
    return res.status(403).end();
  }
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return next();
  res.sendFile(full);
});

// ─── Ensure sessions dir exists ───────────────────────────────────────────────
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/upload', uploadRoutes);
app.use('/api/process', processRoutes);
app.use('/api/widgets', widgetRoutes);
app.use('/api/php', phpRoutes);
app.use('/api/build', buildRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/dev', devRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use((req, res) => {
  res.status(200).send(`
    <html><body style="font-family:sans-serif;padding:40px;background:#0f1117;color:#e2e8f0">
      <h2>Offer Prep Tool — API</h2>
      <p>UI: <a href="http://localhost:5173" style="color:#6366f1">http://localhost:5173</a></p>
    </body></html>
  `);
});

app.use((err, req, res, _next) => {
  console.error('[server] Unhandled error:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// ─── Session TTL cleanup (runs on start + every 6h) ──────────────────────────
function cleanExpiredSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return;
  const now = Date.now();
  let cleaned = 0;

  for (const e of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = path.join(SESSIONS_DIR, e.name);

    let lastActivity = fs.statSync(dir).mtime.getTime();
    const metaPath = path.join(dir, '_session_meta.json');
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        if (meta.lastActivity) lastActivity = new Date(meta.lastActivity).getTime();
      } catch {}
    }

    if (now - lastActivity > SESSION_TTL_MS) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        cleaned++;
        console.log(`[cleanup] Removed expired session: ${e.name}`);
      } catch {}
    }
  }

  if (cleaned) console.log(`[cleanup] Removed ${cleaned} expired session(s)`);
}

cleanExpiredSessions();
setInterval(cleanExpiredSessions, 6 * 60 * 60 * 1000);

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  ┌─────────────────────────────────────────┐');
  console.log(`  │  API Server  →  http://localhost:${PORT}   │`);
  console.log('  │  Open UI    →  http://localhost:5173    │');
  console.log('  └─────────────────────────────────────────┘');
  console.log('');
});
