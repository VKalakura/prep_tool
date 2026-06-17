/**
 * xAI system prompt for the AI rewrite tab.
 *
 * One mode, one prompt. The user message (BRIEF + SLOTS payload) is assembled
 * dynamically in content.js — see the `xai-suggest` route.
 */

module.exports = {
  rewritePrompt: require('./fullCoverage'),
};
