const express = require('express');
const path = require('path');
const fs = require('fs');
const htmlProcessor = require('../services/htmlProcessor');

const router = express.Router();

function getSessionDir(sessionId) {
  return path.join(__dirname, '../sessions', sessionId);
}

function getIndexPath(sessionId) {
  // After normalization index.html is always at sessionDir root
  const dir = getSessionDir(sessionId);
  const html = path.join(dir, 'index.html');
  const php = path.join(dir, 'index.php');
  if (fs.existsSync(html)) return html;
  if (fs.existsSync(php)) return php;
  return null;
}

router.get('/:sessionId/html', (req, res) => {
  const indexPath = getIndexPath(req.params.sessionId);
  if (!indexPath) return res.status(404).json({ error: 'index.html not found' });
  const content = fs.readFileSync(indexPath, 'utf-8');
  res.json({ content, size: content.length, lines: content.split('\n').length });
});

router.get('/:sessionId/scripts', (req, res) => {
  const indexPath = getIndexPath(req.params.sessionId);
  if (!indexPath) return res.status(404).json({ error: 'index.html not found' });
  const content = fs.readFileSync(indexPath, 'utf-8');
  res.json({ scripts: htmlProcessor.extractScripts(content) });
});

router.post('/:sessionId/clean', (req, res) => {
  const { scriptsToRemove } = req.body;
  if (!Array.isArray(scriptsToRemove)) {
    return res.status(400).json({ error: 'scriptsToRemove must be an array' });
  }
  const indexPath = getIndexPath(req.params.sessionId);
  if (!indexPath) return res.status(404).json({ error: 'index.html not found' });

  const content = fs.readFileSync(indexPath, 'utf-8');
  const { html, removed } = htmlProcessor.removeScripts(content, scriptsToRemove);
  fs.writeFileSync(indexPath, html, 'utf-8');
  res.json({ ok: true, removed, newSize: html.length });
});

router.post('/:sessionId/inject', (req, res) => {
  const { snippet, position } = req.body;
  if (!snippet || !position) return res.status(400).json({ error: 'snippet and position required' });
  const indexPath = getIndexPath(req.params.sessionId);
  if (!indexPath) return res.status(404).json({ error: 'index.html not found' });

  const content = fs.readFileSync(indexPath, 'utf-8');
  const html = htmlProcessor.injectSnippet(content, snippet, position);
  fs.writeFileSync(indexPath, html, 'utf-8');
  res.json({ ok: true, newSize: html.length });
});

router.get('/:sessionId/insertion-points', (req, res) => {
  const indexPath = getIndexPath(req.params.sessionId);
  if (!indexPath) return res.status(404).json({ error: 'index.html not found' });
  const content = fs.readFileSync(indexPath, 'utf-8');
  res.json({ points: htmlProcessor.detectInsertionPoints(content) });
});

router.post('/:sessionId/save-html', (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
  const indexPath = getIndexPath(req.params.sessionId);
  if (!indexPath) return res.status(404).json({ error: 'index.html not found' });
  fs.writeFileSync(indexPath, content, 'utf-8');
  res.json({ ok: true });
});

module.exports = router;
