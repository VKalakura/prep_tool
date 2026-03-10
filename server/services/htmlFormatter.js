const prettier = require('prettier');

/**
 * Format HTML using Prettier.
 * Returns { html, success } — on failure returns original html with success=false.
 */
async function formatHtml(html) {
  try {
    const formatted = await prettier.format(html, {
      parser: 'html',
      printWidth: 120,
      tabWidth: 2,
      useTabs: false,
      htmlWhitespaceSensitivity: 'ignore',
    });
    return { html: formatted, success: true };
  } catch {
    return { html, success: false };
  }
}

module.exports = { formatHtml };
