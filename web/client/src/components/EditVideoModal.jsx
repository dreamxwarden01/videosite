import { useState, useRef, useEffect } from 'react';
import { apiPost } from '../api';
import { multipartUpload, UploadConflictError, UploadAbortedError, UploadRetryExhaustedError } from '../services/uploadService';
import { useToast } from '../context/ToastContext';

export default function EditVideoModal({ isOpen, video, courseName, canReplace, onClose, onComplete }) {
  const { showToast } = useToast();
  const fileInputRef = useRef(null);
  const abortRef = useRef(null);

  const [title, setTitle] = useState('');
  const [week, setWeek] = useState('');
  const [date, setDate] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState(null);
  const [dragActive, setDragActive] = useState(false);

  // Original values for change detection
  const [origTitle, setOrigTitle] = useState('');
  const [origWeek, setOrigWeek] = useState('');
  const [origDate, setOrigDate] = useState('');
  const [origDesc, setOrigDesc] = useState('');

  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadText, setUploadText] = useState('');
  const [successTitle, setSuccessTitle] = useState('');

  // Initialize from video
  useEffect(() => {
    if (isOpen && video) {
      const t = video.title || '';
      const w = video.week || '';
      const d = video.lecture_date ? video.lecture_date.slice(0, 10) : '';
      const desc = video.description || '';
      setTitle(t);
      setWeek(w);
      setDate(d);
      setDescription(desc);
      setOrigTitle(t);
      setOrigWeek(w);
      setOrigDate(d);
      setOrigDesc(desc);
      setFile(null);
      setDragActive(false);
      setBusy(false);
      setUploading(false);
      setUploadProgress(0);
      setUploadText('');
      setSuccessTitle('');
    }
  }, [isOpen, video]);

  // Warn before closing tab during upload
  useEffect(() => {
    if (!uploading) return;
    const handler = (e) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [uploading]);

  if (!isOpen || !video) return null;

  const hasFieldChanges = title !== origTitle || week !== origWeek || date !== origDate || description !== origDesc;
  const hasFile = !!file;
  const canReplaceFile = canReplace && video.status === 'finished';
  const isProcessing = video.status !== 'finished' && video.status !== 'error';

  // Determine button label and enabled state
  let actionLabel = 'Save';
  let actionEnabled = false;
  if (hasFile && hasFieldChanges) {
    actionLabel = 'Save and Replace';
    actionEnabled = true;
  } else if (hasFile) {
    actionLabel = 'Replace the Video';
    actionEnabled = true;
  } else if (hasFieldChanges) {
    actionLabel = 'Save';
    actionEnabled = true;
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragActive(false);
    if (busy || !canReplaceFile) return;
    const f = e.dataTransfer.files[0];
    if (f) setFile(f);
  }

  function handleDragOver(e) {
    e.preventDefault();
    if (!busy && canReplaceFile) setDragActive(true);
  }

  function handleDragLeave(e) {
    e.preventDefault();
    setDragActive(false);
  }

  async function handleAbort() {
    if (abortRef.current) {
      await abortRef.current();
    }
    setUploading(false);
    setBusy(false);
  }

  function handleClose() {
    if (uploading) {
      handleAbort();
      return;
    }
    if (!busy) onClose();
  }

  async function saveMetadata() {
    const { ok, data } = await apiPost(`/api/videos/${video.video_id}`, {
      title,
      week,
      lecture_date: date || null,
      description
    });
    if (!ok) throw new Error(data?.error || 'Failed to save changes');
  }

  async function replaceVideo() {
    setUploadText('Preparing replacement...');
    setUploadProgress(0);
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
        onProgress: (percent, uploaded, total) => {
          setUploadProgress(percent);
          setUploadText(`${percent}% (${(uploaded / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB)`);
        },
        onAbortRef: abortRef,
      });
    } finally {
      // Clear uploading on both success and error so the beforeunload
      // handler detaches before the success screen renders. The catch in
      // handleAction still handles error UX; we just own the flag here.
      setUploading(false);
    }
  }

  async function handleAction() {
    setBusy(true);
    try {
      if (hasFieldChanges && hasFile) {
        // Save first, then replace
        await saveMetadata();
        await replaceVideo();
        setBusy(false);
        setSuccessTitle(title);
      } else if (hasFile) {
        // Replace only
        await replaceVideo();
        setBusy(false);
        setSuccessTitle(title);
      } else if (hasFieldChanges) {
        // Save only
        await saveMetadata();
        setBusy(false);
        showToast('Changes saved.', 'success');
        onComplete();
      }
    } catch (err) {
      if (err instanceof UploadConflictError) {
        showToast('Another upload is already in progress for this video.', 'error');
      } else if (err instanceof UploadAbortedError) {
        showToast('Upload cancelled.', 'info');
      } else if (err instanceof UploadRetryExhaustedError) {
        showToast('Upload failed after multiple retries. Please try again.', 'error');
      } else {
        showToast(err.message || 'Operation failed', 'error');
      }
      setUploading(false);
      setBusy(false);
    }
  }

  function handleSuccessOk() {
    onComplete();
  }

  // Success screen after replace
  if (successTitle) {
    return (
      <div className="modal-overlay active" onClick={() => {}}>
        <div className="upload-modal" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <h3>Replace Complete</h3>
          </div>
          <div className="modal-body" style={{ textAlign: 'center', padding: '32px 20px' }}>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>&#10003;</div>
            <p style={{ fontSize: '16px', color: '#333', marginBottom: '8px' }}>
              <strong>{successTitle}</strong> has been replaced and is now queued for processing.
            </p>
            <div style={{ marginTop: '24px' }}>
              <button className="btn btn-primary" onClick={handleSuccessOk}>OK</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay active" onClick={() => {}}>
      <div className="upload-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Edit Video</h3>
          <button className="modal-close" onClick={uploading ? handleAbort : handleClose} disabled={busy && !uploading}>&times;</button>
        </div>
        <div className="modal-body">
          {/* Drop zone — shown if user has replace permission */}
          {canReplace && (
            canReplaceFile ? (
              <div
                className={`upload-dropzone${dragActive ? ' drag-active' : ''}${file ? ' has-file' : ''}`}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onClick={() => !busy && fileInputRef.current?.click()}
                style={{ pointerEvents: busy ? 'none' : 'auto' }}
              >
                <p>{file ? file.name : 'Drag & drop a video file to replace, or click to select'}</p>
                {file && <p style={{ fontSize: '12px', marginTop: '4px', color: '#6b7280' }}>{(file.size / 1048576).toFixed(1)} MB</p>}
                <input
                  type="file"
                  ref={fileInputRef}
                  accept="video/*"
                  style={{ display: 'none' }}
                  onChange={e => { if (e.target.files[0]) setFile(e.target.files[0]); }}
                />
              </div>
            ) : (
              <div
                className="upload-dropzone"
                style={{ pointerEvents: 'none', opacity: 0.5, cursor: 'default' }}
              >
                <p style={{ color: '#6b7280' }}>
                  {isProcessing
                    ? 'Video is processing \u2014 replacement not available'
                    : 'Video is in error state \u2014 replacement not available'}
                </p>
              </div>
            )
          )}

          {/* Title */}
          <div className="form-group">
            <label>Title</label>
            <input
              type="text"
              className="form-control"
              value={title}
              onChange={e => setTitle(e.target.value)}
              disabled={busy}
            />
          </div>

          {/* Course — locked */}
          <div className="form-group">
            <label>Course</label>
            <input
              type="text"
              className="form-control"
              value={courseName}
              disabled
              style={{ background: '#f3f4f6' }}
            />
          </div>

          {/* Week + Date on same row */}
          <div style={{ display: 'flex', gap: '12px' }}>
            <div className="form-group" style={{ flex: 1 }}>
              <label>Week</label>
              <input
                type="text"
                className="form-control"
                value={week}
                onChange={e => setWeek(e.target.value)}
                disabled={busy}
              />
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label>Date</label>
              <input
                type="date"
                className="form-control"
                value={date}
                onChange={e => setDate(e.target.value)}
                disabled={busy}
              />
            </div>
          </div>

          {/* Description */}
          <div className="form-group">
            <label>Description</label>
            <textarea
              className="form-control"
              value={description}
              onChange={e => setDescription(e.target.value)}
              disabled={busy}
              rows={3}
            />
          </div>

          {/* Progress bar */}
          {busy && hasFile && (
            <div style={{ marginBottom: '16px' }}>
              <div className="progress-bar">
                <div className="progress-bar-fill" style={{ width: `${uploadProgress}%` }} />
              </div>
              <p className="progress-text" style={{ marginTop: '4px' }}>{uploadText}</p>
            </div>
          )}

          {/* Buttons */}
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            {!uploading ? (
              <>
                <button className="btn btn-secondary" onClick={handleClose} disabled={busy}>
                  Cancel
                </button>
                <button className="btn btn-primary" onClick={handleAction} disabled={busy || !actionEnabled}>
                  {busy ? 'Saving...' : actionLabel}
                </button>
              </>
            ) : (
              <>
                <button className="btn btn-secondary" disabled>Cancel</button>
                <button className="btn btn-warning" onClick={handleAbort}>Cancel Upload</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
