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
