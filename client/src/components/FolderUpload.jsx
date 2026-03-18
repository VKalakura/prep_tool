import { useState, useRef } from 'react';
import { uploadFolder } from '../api.js';

export default function FolderUpload({ sessionId, mode, onComplete, onError, loading, loadingText }) {
  const [isDragging, setIsDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [fileCount, setFileCount] = useState(0);
  const inputRef = useRef(null);

  const handleFiles = async (files) => {
    const arr = Array.from(files);
    if (!arr.length) return;
    setFileCount(arr.length);
    setUploading(true);
    setProgress(0);
    try {
      const res = await uploadFolder(arr, sessionId, setProgress, mode);
      onComplete(res.data);
    } catch (err) {
      onError(err.response?.data?.error || 'Upload failed');
    } finally {
      setUploading(false);
      setProgress(0);
    }
  };

  return (
    <div className="panel panel--wide">
      <div className="panel__header">
        <h2>Upload Offer Folder</h2>
        <p className="panel__desc">
          Select your entire offer folder. The tool will automatically find{' '}
          <code>index.html</code>, normalize the file structure to{' '}
          <code>js/ css/ fonts/ img/</code>, update all paths, and remove unused files.
        </p>
      </div>

      <div
        className={`drop-zone ${isDragging ? 'drop-zone--active' : ''} ${uploading ? 'drop-zone--uploading' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => { e.preventDefault(); setIsDragging(false); handleFiles(e.dataTransfer.files); }}
        onClick={() => !uploading && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          webkitdirectory="true"
          directory="true"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => handleFiles(e.target.files)}
        />

        {loading ? (
          <div className="drop-zone__content">
            <div className="spinner" />
            <p>{loadingText || 'Processing…'}</p>
          </div>
        ) : uploading ? (
          <div className="drop-zone__content">
            <div className="spinner" />
            <p>Uploading {fileCount} files and normalizing structure…</p>
            <div className="progress-bar">
              <div className="progress-bar__fill" style={{ width: `${progress}%` }} />
            </div>
            <span className="progress-bar__label">{progress}%</span>
          </div>
        ) : (
          <div className="drop-zone__content">
            <div className="drop-zone__icon">📁</div>
            <p className="drop-zone__primary">Click to select offer folder</p>
            <p className="drop-zone__secondary">or drag & drop here</p>
          </div>
        )}
      </div>

      <div className="info-box">
        <strong>Output structure after upload:</strong>
        <pre>{`index.html
js/   ← all .js files
css/  ← all .css files (url() paths updated)
fonts/ ← .woff .woff2 .ttf etc.
img/  ← all images
# Unreferenced files are removed automatically`}</pre>
      </div>
    </div>
  );
}
