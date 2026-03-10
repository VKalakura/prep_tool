const path = require('path');
const fs = require('fs');

const TEMPLATE_PATH = path.join(__dirname, '../templates/send.php.template');

function getTemplate() {
  return fs.readFileSync(TEMPLATE_PATH, 'utf-8');
}

/**
 * Generate send.php content by injecting the geo config as a PHP array.
 */
function generate(geoConfig, customTemplate = null) {
  const template = customTemplate || getTemplate();

  // Build PHP array literal from geoConfig
  const phpArray = buildPhpArray(geoConfig);
  return template.replace('%%GEO_CONFIG%%', phpArray);
}

function buildPhpArray(geoConfig) {
  const lines = ['['];
  for (const [code, entry] of Object.entries(geoConfig)) {
    const endpoint = (entry.endpoint || '').replace(/'/g, "\\'");
    const label = (entry.label || code).replace(/'/g, "\\'");
    lines.push(`  '${code}' => ['endpoint' => '${endpoint}', 'label' => '${label}'],`);
  }
  lines.push(']');
  return lines.join('\n');
}

module.exports = { getTemplate, generate };
