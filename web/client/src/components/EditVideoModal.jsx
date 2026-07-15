import { useState, useRef, useEffect } from 'react';
import { apiPost } from '../api';
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

// Mirror of the server-side cap (POST /api/videos/:id). .length counts UTF-16
// code units, matching the server check, so client and server never disagree
// about what's over the line.
const MAX_DESCRIPTION_CHARS = 15000;

function formatSize(bytes) {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
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

export default function EditVideoModal({ video, moduleLabel, canReplace, onClose, onSaved, onRefresh }) {
  const { showToast } = useToast();
  const fileInputRef = useRef(null);
  const abortRef = useRef(null);
  // 'Save and Replace' commits the metadata before the upload begins, so the
  // save can survive an upload that is then cancelled or fails.
  const savedMetaRef = useRef(false);

  const [orig, setOrig] = useState({
    title: video.title || '',
    week: video.module_number || '',
    date: video.lecture_date ? video.lecture_date.slice(0, 10) : '',
    description: video.description || '',
  });

  const [title, setTitle] = useState(orig.title);
  const [week, setWeek] = useState(orig.week);
  const [date, setDate] = useState(orig.date);
  const [description, setDescription] = useState(orig.description);
  const [descriptionTouched, setDescriptionTouched] = useState(false);
  const [file, setFile] = useState(null);
  const [fileError, setFileError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);

  // A finished video is the only replaceable state — you cannot swap the
  // source out from under a transcode that is still running or errored.
  const canReplaceFile = canReplace && video.status === 'finished';

  const fieldsChanged = title !== orig.title || week !== orig.week || date !== orig.date || description !== orig.description;
  const descriptionTooLong = description.length > MAX_DESCRIPTION_CHARS;
  const descriptionInvalid = descriptionTouched && descriptionTooLong;

  // Primary-action label + enablement. A staged file makes "replace" the
  // dominant intent; metadata edits fold in when both are present.
  let actionLabel = 'Save changes';
  let actionEnabled = false;
  if (file && fieldsChanged) { actionLabel = 'Save and Replace'; actionEnabled = true; }
  else if (file) { actionLabel = 'Replace the video'; actionEnabled = true; }
  else if (fieldsChanged) { actionLabel = 'Save changes'; actionEnabled = true; }

  const moduleWord = moduleTerm(moduleLabel);

  // Window-wide drop mirrors UploadVideoModal: the whole viewport is the
  // target so the user never has to hit the small dropzone. It keeps
  // listening (and refuses) during the upload rather than tearing down.
  const { dragActive, refusing } = useFullWindowDrop({
    enabled: canReplaceFile,
    multiple: false,
    refuse: uploading,
    onFiles: (f) => handleFileSelect(f[0]),
  });

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  // Warn before the tab is closed mid-upload.
  useEffect(() => {
    if (!uploading) return undefined;
    const handler = (e) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [uploading]);

  function handleFileSelect(f) {
    if (!f) return;
    setFileError('');
    const err = validateVideoFile(f);
    if (err) { setFile(null); setFileError(err); return; }
    setFile(f);
  }

  function clearFile() {
    setFile(null);
    setFileError('');
  }

  async function saveMetadata() {
    const mn = week.trim();
    const { ok, data } = await apiPost(`/api/videos/${video.video_id}`, {
      title,
      description,
      module_number: mn === '' ? null : mn,
      lecture_date: date || null,
    });
    if (!ok) throw new Error(data?.error || 'Failed to save changes');
    savedMetaRef.current = true;
    setOrig({ title, week, date, description });
  }

  async function replaceVideo() {
    setProgress(0);
    setUploading(true);
    try {
      await multipartUpload({
        file,
        createUrl: '/api/upload/replace',
        createBody: {
          videoId: video.video_id,
          filename: file.name,
          fileSize: file.size,
          contentType: file.type || 'application/octet-stream',
        },
        onProgress: (percent) => setProgress(percent),
        onAbortRef: abortRef,
      });
    } finally {
      // Clear on both success and error so the beforeunload guard detaches
      // before we hand control back; the catch below owns the error UX.
      setUploading(false);
    }
  }

  async function handleAction(e) {
    if (e) e.preventDefault();
    if (!actionEnabled || busy || descriptionTooLong) return;
    setBusy(true);
    try {
      if (file && fieldsChanged) {
        await saveMetadata();
        await replaceVideo();
        showToast('Changes saved — video queued for processing.', 'success');
        onSaved();
      } else if (file) {
        await replaceVideo();
        showToast('Video replaced — queued for processing.', 'success');
        onSaved();
      } else if (fieldsChanged) {
        await saveMetadata();
        showToast('Changes saved.', 'success');
        onSaved();
      }
    } catch (err) {
      if (err instanceof UploadConflictError) {
        showToast('Another upload is already in progress for this video.', 'error');
      } else if (err instanceof UploadAbortedError) {
        showToast('Upload cancelled.', 'info');
      } else if (err instanceof UploadRetryExhaustedError) {
        showToast('Upload failed after multiple retries. Please try again.', 'error');
      } else {
        showToast(err.message || 'Operation failed.', 'error');
      }
      // On 'Save and Replace' the metadata was already committed before the
      // upload started. The modal stays open so the file can be retried, but
      // the list behind it is now stale — refresh it in place.
      if (savedMetaRef.current) onRefresh?.();
      setUploading(false);
      setBusy(false);
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
        title={refusing ? 'Upload in progress' : file ? 'Drop to replace the video' : 'Drop the new video anywhere'}
        hint={refusing
          ? 'Wait for the current upload to finish, or cancel it first.'
          : file ? `${file.name} will be swapped out.` : 'MP4, MKV, MOV — up to 50 GB'}
      />
      <form className="vs-modal" onSubmit={handleAction}>
        <div className="vs-modal-head">
          <h3 className="vs-modal-title">Edit Video</h3>
          <button type="button" className="vs-modal-x" onClick={onClose} disabled={busy} aria-label="Close"><CloseIcon /></button>
        </div>
        <div className="vs-modal-body">
          {canReplaceFile && (
            <div className="vs-field">
              {!file ? (
                <>
                  <div
                    className={'vs-dropzone' + (dragActive ? ' drag' : '')}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <div className="vs-dropzone-ico"><UploadIcon /></div>
                    <p className="vs-dropzone-t">Replace the video file</p>
                    <p className="vs-dropzone-h">Drop a new video here or click to browse — MP4, MKV, MOV — up to 50 GB</p>
                    <input
                      type="file"
                      ref={fileInputRef}
                      accept={ALLOWED_VIDEO_EXTENSIONS.join(',')}
                      style={{ display: 'none' }}
                      onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; handleFileSelect(f); }}
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
                    <button type="button" className="vs-fl-x" onClick={clearFile} disabled={busy} aria-label="Remove file"><CloseIcon /></button>
                  </div>
                  {uploading && (
                    <div>
                      <div className="vs-progress vs-progress-lg">
                        <div className="vs-progress-fill" style={{ width: `${progress}%` }} />
                      </div>
                      <p className="vs-hint" style={{ marginTop: 6, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{progress}%</p>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <div className="vs-field">
            <label className="vs-label" htmlFor="edit_vid_title">Title</label>
            <input
              type="text" id="edit_vid_title"
              className="vs-input"
              value={title}
              onChange={e => setTitle(e.target.value)}
              disabled={busy}
              autoComplete="off"
            />
          </div>

          <div className="vs-field-row">
            <div className="vs-field">
              <label className="vs-label" htmlFor="edit_vid_module">{moduleWord} number</label>
              <input
                type="text" id="edit_vid_module"
                className="vs-input"
                value={week}
                onChange={e => setWeek(e.target.value.slice(0, 50))}
                disabled={busy}
                maxLength={50}
                autoComplete="off"
              />
            </div>
            <div className="vs-field">
              <label className="vs-label" htmlFor="edit_vid_date">Lecture date</label>
              <input
                type="date" id="edit_vid_date"
                className="vs-input"
                value={date}
                onChange={e => setDate(e.target.value)}
                disabled={busy}
              />
            </div>
          </div>

          <div className="vs-field">
            <label className="vs-label" htmlFor="edit_vid_desc">Description</label>
            <textarea
              id="edit_vid_desc"
              className={`vs-textarea${descriptionInvalid ? ' err' : ''}`}
              value={description}
              onChange={e => setDescription(e.target.value)}
              onBlur={() => setDescriptionTouched(true)}
              onFocus={() => setDescriptionTouched(false)}
              disabled={busy}
              rows={4}
            />
            <p className={`vs-hint${descriptionTooLong ? ' err' : ''}`} style={{ textAlign: 'right' }}>
              {description.length.toLocaleString()} / {MAX_DESCRIPTION_CHARS.toLocaleString()}
            </p>
          </div>
        </div>
        <div className="vs-modal-foot">
          {!uploading ? (
            <>
              <button type="button" className="vs-btn" onClick={onClose} disabled={busy}>Cancel</button>
              <button type="submit" className="vs-btn vs-btn-primary" disabled={!actionEnabled || busy || descriptionTooLong}>
                {busy ? 'Saving...' : actionLabel}
              </button>
            </>
          ) : (
            <button type="button" className="vs-btn vs-btn-danger" onClick={handleAbort}>Cancel upload</button>
          )}
        </div>
      </form>
    </div>
  );
}
