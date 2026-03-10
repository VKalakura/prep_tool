const fs = require('fs');
const path = require('path');

/**
 * Recursively scan a directory to find the "main" index.html.
 * Strategy: prefer the shallowest index.html, and if multiple exist
 * at the same depth pick the one whose parent dir contains the most
 * assets (JS/CSS files) — a reliable heuristic for real offer folders.
 */
function findIndexHtml(rootDir) {
  const candidates = [];
  scan(rootDir, rootDir, 0, candidates);

  if (candidates.length === 0) return null;

  // Sort by depth (ascending), then by sibling asset count (descending)
  candidates.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return b.assetCount - a.assetCount;
  });

  return candidates[0].path;
}

function scan(dir, root, depth, results) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const hasIndex = entries.some(
    (e) => e.isFile() && e.name.toLowerCase() === 'index.html'
  );

  if (hasIndex) {
    const indexPath = path.join(dir, 'index.html');
    const assetCount = countAssets(dir, entries);
    results.push({ path: indexPath, depth, assetCount });
    // Still descend to find deeper candidates (some offers nest inside sub-dirs)
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      scan(path.join(dir, entry.name), root, depth + 1, results);
    }
  }
}

function countAssets(dir, entries) {
  let count = 0;
  for (const e of entries) {
    if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (['.js', '.css', '.png', '.jpg', '.svg', '.gif', '.woff', '.ttf'].includes(ext)) {
        count++;
      }
    } else if (e.isDirectory()) {
      const name = e.name.toLowerCase();
      if (['assets', 'js', 'css', 'images', 'img', 'fonts', 'static'].includes(name)) {
        count += 10; // Strongly weight standard asset folders
      }
    }
  }
  return count;
}

/**
 * List all files under rootDir with their relative paths.
 */
function listAllFiles(rootDir) {
  const results = [];
  listFiles(rootDir, rootDir, results);
  return results;
}

function listFiles(dir, root, results) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listFiles(fullPath, root, results);
    } else {
      results.push(path.relative(root, fullPath));
    }
  }
}

module.exports = { findIndexHtml, listAllFiles };
