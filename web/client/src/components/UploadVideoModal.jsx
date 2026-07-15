import { useState, useRef, useEffect } from 'react';
import {
  multipartUpload,
  UploadConflictError,
  UploadAbortedError,
  UploadRetryExhaustedError,
  ALLOWED_VIDEO_EXTENSIONS,
  validateVideoFile,
} from '../services/uploadService';
import { useToast } from '../context/ToastContext';
import useFullWindowDrop from '../hooks/useFullWindowDrop';
import DropVeil from './DropVeil';
import { moduleTerm } from '../utils/moduleLabel';

// Server rejects a longer description with 422 (routes/api/upload.js). .length
// counts UTF-16 code units, matching the server check, so we never disagree.
const MAX_DESCRIPTION_CHARS = 15000;

function formatSize(bytes) {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

// Autofills the module number + lecture date off the "<code>_Week<n>_<yyyymmdd>"
// upload naming scheme. The literal "Week" token is the filename convention and
// is independent of the course's own module label.
function parseFilename(name) {
  const base = name.replace(/\.[^.]+$/, '');
  const m = base.match(/^(.+?)_Week(\d+)_(\d{8})/i);
  if (!m) return null;
  const code = m[1].replace(/_/g, ' ').trim();
  const week = m[2];
  const ds = m[3];
  const y = +ds.slice(0, 4), mo = +ds.slice(4, 6), d = +ds.slice(6, 8);
  const dt = new Date(y, mo - 1, d);
  const date = dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d
    ? `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    : '';
  return { code, week, date };
}

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
);
const UploadIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5" /><path d="M12 3v13" /></svg>
);
const FilmIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M10 9l5 3-5 3z" /></svg>
);

export default function UploadVideoModal({ courseId, moduleLabel, courseCode, onClose, onUploaded }) {
  const { showToast } = useToast();
  const fileInputRef = useRef(null);
  const abortRef = useRef(null);

  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [moduleNumber, setModuleNumber] = useState('');
  const [date, setDate] = useState('');
  const [description, setDescription] = useState('');
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [fileError, setFileError] = useState('');
  const [conflict, setConflict] = useState('');
  const [nameHint, setNameHint] = useState('');
  const [autoModule, setAutoModule] = useState(false);
  const [autoDate, setAutoDate] = useState(false);

  const modTerm = moduleTerm(moduleLabel);

  // Warn before the tab is closed mid-upload.
  useEffect(() => {
    if (!uploading) return undefined;
    const handler = (e) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [uploading]);

  // The whole window is the drop target, so the user never has to land on the
  // small dropzone div. It stays enabled during the upload so the drop is
  // intercepted and visibly refused rather than silently ignored — or, worse,
  // handed to the browser, which would navigate away from the running upload.
  const { dragActive, refusing } = useFullWindowDrop({
    enabled: true,
    multiple: false,
    refuse: uploading,
    onFiles: (files) => { if (files[0]) selectFile(files[0]); },
  });

  function selectFile(f) {
    setFileError('');
    const err = validateVideoFile(f);
    if (err) { setFileError(err); return; }

    setFile(f);
    setConflict('');
    setNameHint('');
    setAutoModule(false);
    setAutoDate(false);

    const parsed = parseFilename(f.name);
    if (parsed) {
      if (parsed.week) { setModuleNumber(parsed.week); setAutoModule(true); }
      if (parsed.date) { setDate(parsed.date); setAutoDate(true); }
      if (courseCode && parsed.code && parsed.code.toLowerCase() !== courseCode.trim().toLowerCase()) {
        setNameHint(`Filename says ${parsed.code.toUpperCase()}, uploading to ${courseCode}.`);
      }
    }
  }

  function clearFile() {
    setFile(null);
    setFileError('');
    setConflict('');
    setNameHint('');
  }

  const descTooLong = description.length > MAX_DESCRIPTION_CHARS;
  const canUpload = !!file && !!title.trim() && !uploading && !descTooLong;

  async function handleUpload() {
    if (!canUpload) return;

    setUploading(true);
    setProgress(0);
    setConflict('');

    try {
      await multipartUpload({
        file,
        createUrl: '/api/upload/create',
        createBody: {
          courseId,
          filename: file.name,
          fileSize: file.size,
          contentType: file.type || 'application/octet-stream',
          title: title.trim(),
          module_number: moduleNumber.trim() || null,
          lectureDate: date || null,
          description: description.trim() || null,
        },
        onProgress: (percent) => setProgress(percent),
        onAbortRef: abortRef,
      });

      showToast('Video uploaded — queued for processing.', 'success');
      onUploaded();
    } catch (err) {
      setUploading(false);
      if (err instanceof UploadAbortedError) {
        showToast('Upload cancelled.', 'info');
      } else if (err instanceof UploadConflictError) {
        setConflict(err.conflictData?.type === 'upload'
          ? 'Another upload with matching metadata is already in progress.'
          : 'A video with the same title, module number, and date already exists in this course.');
      } else if (err instanceof UploadRetryExhaustedError) {
        showToast('Upload failed after multiple retries. Please try again.', 'error');
      } else {
        showToast(err.message || 'Upload failed.', 'error');
      }
    }
  }

  function handleAbort() {
    if (abortRef.current) abortRef.current();
  }

  return (
    <div className="vs-scrim">
      <DropVeil
        active={dragActive}
        refusing={refusing}
        title={refusing ? 'Upload in progress' : file ? 'Drop to replace the video' : 'Drop the video anywhere'}
        hint={refusing
          ? 'Wait for the current upload to finish, or cancel it first.'
          : file ? `${file.name} will be swapped out.` : 'MP4, MKV, MOV — up to 50 GB'}
      />
      <div className="vs-modal">
        <div className="vs-modal-head">
          <h3 className="vs-modal-title">Upload a video</h3>
          <button className="vs-modal-x" onClick={onClose} disabled={uploading} aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        <div className="vs-modal-body">
          {!file ? (
            <>
              <div
                className={'vs-dropzone' + (dragActive ? ' drag' : '')}
                onClick={() => fileInputRef.current?.click()}
              >
                <div className="vs-dropzone-ico"><UploadIcon /></div>
                <p className="vs-dropzone-t">Drop a video here</p>
                <p className="vs-dropzone-h">or click to browse — MP4, MKV, MOV — up to 50 GB</p>
                <input
                  type="file"
                  ref={fileInputRef}
                  accept={ALLOWED_VIDEO_EXTENSIONS.join(',')}
                  style={{ display: 'none' }}
                  onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; if (f) selectFile(f); }}
                />
              </div>
              {fileError && <p className="vs-hint err" style={{ marginTop: 8 }}>{fileError}</p>}
            </>
          ) : (
            <>
              <div className="vs-filechip">
                <span className="vs-filechip-ico"><FilmIcon /></span>
                <div className="vs-filechip-mn">
                  <p className="vs-filechip-t" title={file.name}>{file.name}</p>
                  <p className="vs-filechip-s">{formatSize(file.size)}</p>
                </div>
                <button className="vs-fl-x" onClick={clearFile} disabled={uploading} aria-label="Remove file">
                  <CloseIcon />
                </button>
              </div>
              {nameHint && <p className="vs-hint" style={{ marginTop: 8 }}>{nameHint}</p>}

              <div style={{ marginTop: 16 }}>
                <div className="vs-field">
                  <label className="vs-label">Title</label>
                  <input
                    className={'vs-input' + (conflict ? ' err' : '')}
                    value={title}
                    onChange={(e) => { setTitle(e.target.value); if (conflict) setConflict(''); }}
                    disabled={uploading}
                    placeholder="Video title"
                    autoComplete="off"
                  />
                  {conflict && <p className="vs-hint err">{conflict}</p>}
                </div>

                <div className="vs-field-row">
                  <div className="vs-field">
                    <label className="vs-label">{modTerm} number {autoModule && <span className="vs-auto">auto</span>}</label>
                    <input
                      className="vs-input"
                      value={moduleNumber}
                      onChange={(e) => { setModuleNumber(e.target.value.slice(0, 50)); setAutoModule(false); }}
                      disabled={uploading}
                      maxLength={50}
                      placeholder="e.g. 5"
                      autoComplete="off"
                    />
                  </div>
                  <div className="vs-field">
                    <label className="vs-label">Lecture date {autoDate && <span className="vs-auto">auto</span>}</label>
                    <input
                      type="date"
                      className="vs-input"
                      value={date}
                      onChange={(e) => { setDate(e.target.value); setAutoDate(false); }}
                      disabled={uploading}
                    />
                  </div>
                </div>

                <div className="vs-field">
                  <label className="vs-label">Description</label>
                  <textarea
                    className="vs-textarea"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    disabled={uploading}
                    rows={3}
                    placeholder="Optional description"
                  />
                  {descTooLong && (
                    <p className="vs-hint err">Description exceeds the {MAX_DESCRIPTION_CHARS.toLocaleString()} character limit.</p>
                  )}
                </div>

                {uploading && (
                  <div>
                    <div className="vs-progress vs-progress-lg">
                      <div className="vs-progress-fill" style={{ width: `${progress}%` }} />
                    </div>
                    <p className="vs-hint" style={{ marginTop: 6, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{progress}%</p>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="vs-modal-foot">
          {!uploading ? (
            <>
              <button className="vs-btn" onClick={onClose}>Cancel</button>
              <button className="vs-btn vs-btn-primary" onClick={handleUpload} disabled={!canUpload}>Upload</button>
            </>
          ) : (
            <button className="vs-btn vs-btn-danger" onClick={handleAbort}>Cancel upload</button>
          )}
        </div>
      </div>
    </div>
  );
}
