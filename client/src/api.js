import axios from 'axios';

const BASE = '/api';

export function uploadFolder(files, sessionId, onProgress) {
  const form = new FormData();

  // Send relative paths as a separate JSON field — multer v2 strips slashes
  // from originalname, so we can't rely on it for folder structure.
  const paths = Array.from(files).map((f) => f.webkitRelativePath || f.name);
  form.append('filePaths', JSON.stringify(paths));

  for (const file of files) {
    form.append('files', file); // no custom filename — let browser handle it
  }

  // Do NOT set Content-Type manually — axios/browser must set it automatically
  // with the correct multipart boundary. Setting it without boundary breaks multer.
  return axios.post(`${BASE}/upload`, form, {
    headers: { 'X-Session-Id': sessionId },
    onUploadProgress: (e) => onProgress && onProgress(Math.round((e.loaded * 100) / e.total)),
  });
}

export function getHtml(sessionId) {
  return axios.get(`${BASE}/process/${sessionId}/html`);
}

export function getScripts(sessionId) {
  return axios.get(`${BASE}/process/${sessionId}/scripts`);
}

export function cleanScripts(sessionId, scriptsToRemove) {
  return axios.post(`${BASE}/process/${sessionId}/clean`, { scriptsToRemove });
}

export function getInsertionPoints(sessionId) {
  return axios.get(`${BASE}/process/${sessionId}/insertion-points`);
}

// iFrames
export function getIframes(sessionId) {
  return axios.get(`${BASE}/process/${sessionId}/iframes`);
}
export function cleanIframes(sessionId, indicesToRemove) {
  return axios.post(`${BASE}/process/${sessionId}/clean-iframes`, { indicesToRemove });
}

// Unused files
export function getUnusedFiles(sessionId) {
  return axios.get(`${BASE}/process/${sessionId}/unused-files`);
}
export function cleanUnusedFiles(sessionId, filePaths) {
  return axios.post(`${BASE}/process/${sessionId}/clean-unused`, { filePaths });
}

export function getWidgets() {
  return axios.get(`${BASE}/widgets`);
}

export function injectWidget(sessionId, widgetId, position) {
  return axios.post(`${BASE}/widgets/inject`, { sessionId, widgetId, position });
}

// PHP Integration
export function getPhpConfig(sessionId) {
  return axios.get(`${BASE}/php/${sessionId}/config`);
}

export function getPhpPreviewHtml(sessionId) {
  return axios.get(`${BASE}/php/${sessionId}/preview-html`);
}

export function getPhpPreviewSendPhp(sessionId, { offerName, countryCode, langCode } = {}) {
  return axios.post(`${BASE}/php/${sessionId}/preview-sendphp`, { offerName, countryCode, langCode });
}

export function applyPhpIntegration(sessionId, { offerName, countryCode, langCode }) {
  return axios.post(`${BASE}/php/${sessionId}/apply`, { offerName, countryCode, langCode });
}

// Build
export function getFileTree(sessionId) {
  return axios.get(`${BASE}/build/${sessionId}/file-tree`);
}

export function buildOffer(sessionId) {
  return axios.post(`${BASE}/build/${sessionId}`, {}, { responseType: 'blob' });
}

// Content Editor — Text
export function getEditableElements(sessionId) {
  return axios.get(`${BASE}/content/${sessionId}/editable-elements`);
}
export function saveText(sessionId, idx, text) {
  return axios.post(`${BASE}/content/${sessionId}/save-text`, { idx, text });
}
export function bulkReplace(sessionId, replacements) {
  return axios.post(`${BASE}/content/${sessionId}/bulk-replace`, { replacements });
}

// Content Editor — Images
export function getImages(sessionId) {
  return axios.get(`${BASE}/content/${sessionId}/images`);
}
export function replaceImage(sessionId, name, file) {
  const form = new FormData();
  form.append('name', name);
  form.append('file', file);
  return axios.post(`${BASE}/content/${sessionId}/replace-image`, form);
}
export function compressImage(sessionId, name, quality, format) {
  return axios.post(`${BASE}/content/${sessionId}/compress-image`, { name, quality, format });
}
export function compressAll(sessionId, quality, format) {
  return axios.post(`${BASE}/content/${sessionId}/compress-all`, { quality, format });
}

// Session stats
export function getSessionStats(sessionId) {
  return axios.get(`${BASE}/process/${sessionId}/stats`);
}

// Dev Access
export function getDevState(sessionId) {
  return axios.get(`${BASE}/dev/${sessionId}/state`);
}
export function getDevFile(sessionId, filePath) {
  return axios.get(`${BASE}/dev/${sessionId}/file`, { params: { path: filePath } });
}
export function saveDevFile(sessionId, filePath, content) {
  return axios.put(`${BASE}/dev/${sessionId}/file`, { path: filePath, content });
}
