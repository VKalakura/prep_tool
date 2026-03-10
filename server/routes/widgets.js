const express = require('express');
const path = require('path');
const fs = require('fs');
const widgetInjector = require('../services/widgetInjector');

const router = express.Router();

const WIDGETS_DIR = path.join(__dirname, '../../widgets');

router.get('/', (req, res) => {
  if (!fs.existsSync(WIDGETS_DIR)) return res.json({ widgets: [] });

  const widgets = fs.readdirSync(WIDGETS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(WIDGETS_DIR, e.name);
      const files = fs.readdirSync(dir);
      const htmlFile = files.find((f) => f.endsWith('.html'));
      const jsFile = files.find((f) => f.endsWith('.js'));
      const cssFile = files.find((f) => f.endsWith('.css'));
      const metaPath = path.join(dir, 'meta.json');
      const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf-8')) : {};

      return {
        id: e.name,
        name: meta.name || e.name,
        description: meta.description || '',
        files: { html: htmlFile, js: jsFile, css: cssFile },
        content: {
          html: htmlFile ? fs.readFileSync(path.join(dir, htmlFile), 'utf-8') : '',
          js: jsFile ? fs.readFileSync(path.join(dir, jsFile), 'utf-8') : '',
          css: cssFile ? fs.readFileSync(path.join(dir, cssFile), 'utf-8') : '',
        },
      };
    });

  res.json({ widgets });
});

router.post('/inject', (req, res) => {
  const { sessionId, widgetId, position } = req.body;
  if (!sessionId || !widgetId || !position) {
    return res.status(400).json({ error: 'sessionId, widgetId, position required' });
  }

  const widgetDir = path.join(WIDGETS_DIR, widgetId);
  if (!fs.existsSync(widgetDir)) return res.status(404).json({ error: `Widget "${widgetId}" not found` });

  const sessionDir = path.join(__dirname, '../sessions', sessionId);
  // After normalization, index is always at sessionDir root
  const indexPath = path.join(sessionDir, 'index.html');
  if (!fs.existsSync(indexPath)) return res.status(404).json({ error: 'index.html not found' });

  const content = fs.readFileSync(indexPath, 'utf-8');
  const html = widgetInjector.inject(content, widgetDir, widgetId, position, sessionDir);
  fs.writeFileSync(indexPath, html, 'utf-8');

  res.json({ ok: true });
});

module.exports = router;
