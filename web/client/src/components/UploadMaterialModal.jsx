import { useState, useRef, useEffect } from 'react';
import { useToast } from '../context/ToastContext';
import { useConfirm } from './ConfirmModal';
import { apiPost } from '../api';
import { startUploadHeartbeat } from '../services/uploadHeartbeat';
import CourseSelector from './CourseSelector';
import useFullWindowDrop from '../hooks/useFullWindowDrop';

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
const BLOCKED_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.ts', '.m3u8'];

function getExtension(filename) {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.substring(dot).toLowerCase() : '';
}

export default function UploadMaterialModal({ isOpen, onClose, courses, preselectedCourseId, preselectedCourseName, existingMaterials, onUploadComplete }) {
  const { showToast } = useToast();
  const confirm = useConfirm();
  const fileInputRef = useRef(null);

  const [file, setFile] = useState(null);
  const [filename, setFilename] = useState('');
  const [courseId, setCourseId] = useState(preselectedCourseId || '');
  const [week, setWeek] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadText, setUploadText] = useState('');
  const [failed, setFailed] = useState(false);
  const [successTitle, setSuccessTitle] = useState('');
  const [fileError, setFileError] = useState('');

  const xhrRef = useRef(null);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setFile(null);
      setFilename('');
      setCourseId(preselectedCourseId || '');
      setWeek('');
      setUploading(false);
      setUploadProgress(0);
      setUploadText('');
      setFailed(false);
      setSuccessTitle('');
      setFileError('');
    }
  }, [isOpen, preselectedCourseId]);

  // Warn before closing tab during upload
  useEffect(() => {
    if (!uploading) return;
    const handler = (e) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [uploading]);

  // Whole-tab drag-drop. Same pattern as UploadModal — anywhere in the
  // tab is the effective drop zone while the modal is open and not
  // mid-upload. handleFileSelect runs validation (extension blocklist,
  // 100 MB cap) before accepting the file.
  const { dragActive: windowDragActive } = useFullWindowDrop({
    enabled: isOpen && !uploading && !successTitle,
    onFile: (f) => handleFileSelect(f),
  });

  if (!isOpen) return null;

  const selectedCourse = courses.find(c => String(c.course_id) === String(courseId));

  function handleFileSelect(selectedFile) {
    if (!selectedFile) return;
    setFileError('');

    const ext = getExtension(selectedFile.name);
    if (BLOCKED_EXTENSIONS.includes(ext)) {
      setFileError('Video files are not allowed. Use the video upload feature instead.');
      return;
    }
    if (selectedFile.size > MAX_FILE_SIZE) {
      setFileError('File size exceeds 100 MB limit.');
      return;
    }
    if (!ext) {
      setFileError('File must have an extension.');
      return;
    }

    setFile(selectedFile);

    // Parse [Week{N}] prefix from filename
    const weekMatch = selectedFile.name.match(/^\[Week(\d+)\]\s*/i);
    if (weekMatch) {
      setFilename(selectedFile.name.slice(weekMatch[0].length));
      setWeek(weekMatch[1]);
    } else {
      setFilename(selectedFile.name);
    }
  }

  const filenameValid = filename.trim().length > 0 && filename.trim().length <= 255 && !/[/\\]/.test(filename);
  const canUpload = file && filenameValid && courseId && week.trim() && !uploading;

  async function handleUpload() {
    if (!canUpload) return;

    // Check for duplicate (same filename, week, and size)
    if (existingMaterials?.length) {
      const dup = existingMaterials.find(m =>
        m.filename === filename.trim() && m.week === week.trim() && m.file_size === file.size
      );
      if (dup) {
        const ok = await confirm(`A file with the same name, week, and size already exists. Upload anyway?`);
        if (!ok) return;
      }
    }

    setUploading(true);
    setFailed(false);
    setUploadProgress(0);
    setUploadText('Starting upload...');

    let uploadId = null;
    let heartbeat = null;
    try {
      // 1. Create attachment upload session + get presigned PUT URL
      const { data, ok } = await apiPost(`/api/materials/courses/${courseId}/upload`, {
        filename: filename.trim(),
        fileSize: file.size,
        contentType: file.type || 'application/octet-stream',
        week: week.trim(),
      });

      if (!ok || !data?.uploadUrl) {
        throw new Error(data?.error || 'Failed to initiate upload.');
      }

      uploadId = data.uploadId;

      // 2. Start heartbeat ticker (5s / 5 retries with backoff / single
      //    in-flight / self-abort at 60s of no successful heartbeat).
      heartbeat = startUploadHeartbeat(`/api/materials/${uploadId}/heartbeat`, {
        onTimeout: () => {
          // Server-side stale timer will fire in parallel — just abort
          // the local XHR so the user sees a fast failure.
          if (xhrRef.current) xhrRef.current.abort();
        },
      });

      // 3. PUT file to presigned URL with progress reporting
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhrRef.current = xhr;

        xhr.upload.onprogress = (evt) => {
          if (evt.lengthComputable) {
            const percent = Math.round((evt.loaded / evt.total) * 100);
            setUploadProgress(percent);
            setUploadText(`${percent}% (${(evt.loaded / 1048576).toFixed(1)} / ${(evt.total / 1048576).toFixed(1)} MB)`);
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(new Error(`Upload failed with status ${xhr.status}`));
          }
        };

        xhr.onerror = () => reject(new Error('Upload failed.'));
        xhr.onabort = () => reject(new Error('__aborted__'));

        xhr.open('PUT', data.uploadUrl);
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
        xhr.send(file);
      });

      // 4. Report completion — server re-stamps headers, creates the
      //    course_materials row, returns the materialId.
      const completeResult = await apiPost(`/api/materials/${uploadId}/complete`, {
        week: week.trim(),
      });
      if (completeResult.status === 410) {
        throw new Error('Course was deleted; upload discarded.');
      }
      if (!completeResult.ok) {
        throw new Error(completeResult.data?.error || 'Failed to complete upload.');
      }

      heartbeat.stop();
      heartbeat = null;
      setUploading(false);
      setSuccessTitle(filename.trim());
    } catch (err) {
      if (heartbeat) {
        heartbeat.stop();
        heartbeat = null;
      }
      if (err.message === '__aborted__') {
        // User cancelled (or heartbeat self-aborted). Notify server so
        // the R2 object is enqueued for deletion.
        if (uploadId) {
          apiPost(`/api/materials/${uploadId}/abort`).catch(() => {});
        }
        showToast('Upload cancelled.', 'info');
      } else {
        // Other failure — also tell server to drop the session.
        if (uploadId) {
          apiPost(`/api/materials/${uploadId}/abort`).catch(() => {});
        }
        showToast(err.message || 'Upload failed', 'error');
      }
      setFailed(true);
      setUploading(false);
    }
  }

  async function handleAbort() {
    if (xhrRef.current) {
      xhrRef.current.abort();
    }
    setUploading(false);
    setFailed(true);
  }

  function handleClose() {
    if (!uploading) onClose();
  }

  function handleSuccessOk() {
    onUploadComplete();
  }

  // Success screen
  if (successTitle) {
    return (
      <div className="modal-overlay active" onClick={() => {}}>
        <div className="upload-modal" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <h3>Upload Complete</h3>
          </div>
          <div className="modal-body" style={{ textAlign: 'center', padding: '32px 20px' }}>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>&#10003;</div>
            <p style={{ fontSize: '16px', color: '#333', marginBottom: '8px' }}>
              <strong>{successTitle}</strong> has been uploaded successfully.
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
          <h3>Upload Material</h3>
          <button className="modal-close" onClick={handleClose} disabled={uploading}>&times;</button>
        </div>
        <div className="modal-body">
          {/* Drop zone — click target for the file picker. Drag-and-drop
              itself is handled at the window level by useFullWindowDrop. */}
          <div
            className={`upload-dropzone${file ? ' has-file' : ''}`}
            onClick={() => !uploading && fileInputRef.current?.click()}
            style={{ pointerEvents: uploading ? 'none' : 'auto' }}
          >
            <p>{file ? file.name : 'Drag & drop a file here, or click to select'}</p>
            {file && <p style={{ fontSize: '12px', marginTop: '4px', color: '#6b7280' }}>{(file.size / 1048576).toFixed(1)} MB</p>}
            <input
              type="file"
              ref={fileInputRef}
              style={{ display: 'none' }}
              onChange={e => { if (e.target.files[0]) handleFileSelect(e.target.files[0]); }}
            />
          </div>
          {fileError && (
            <p style={{ color: '#991b1b', fontSize: '13px', marginTop: '-12px', marginBottom: '12px' }}>{fileError}</p>
          )}

          {/* Filename */}
          <div className="form-group">
            <label>Filename <span style={{ color: '#dc3545' }}>*</span></label>
            <input
              type="text"
              className="form-control"
              value={filename}
              onChange={e => setFilename(e.target.value)}
              disabled={uploading}
              maxLength={255}
              placeholder="Display filename"
              autoComplete="off"
            />
          </div>

          {/* Course selector */}
          <div className="form-group">
            <label>Course <span style={{ color: '#dc3545' }}>*</span></label>
            {preselectedCourseId ? (
              <input
                type="text"
                className="form-control"
                value={preselectedCourseName || selectedCourse?.course_name || ''}
                disabled
                style={{ background: '#f3f4f6' }}
              />
            ) : (
              <CourseSelector
                courses={courses}
                value={courseId}
                onChange={setCourseId}
                disabled={uploading}
              />
            )}
          </div>

          {/* Week */}
          <div className="form-group">
            <label>Week <span style={{ color: '#dc3545' }}>*</span></label>
            <input
              type="text"
              className="form-control"
              value={week}
              onChange={e => setWeek(e.target.value)}
              disabled={uploading}
              maxLength={20}
              placeholder="e.g. 5"
              autoComplete="off"
            />
          </div>

          {/* Progress bar */}
          {uploading && (
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
                <button className="btn btn-secondary" onClick={handleClose}>Cancel</button>
                <button className="btn btn-primary" onClick={handleUpload} disabled={!canUpload}>Upload</button>
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
      {/* Full-window drop overlay — same surface as the video upload
          modal so drag interactions feel identical across both flows. */}
      {windowDragActive && (
        <div className="full-window-drop-overlay">
          <div className="full-window-drop-overlay-message">
            Drop the file here
            <span className="full-window-drop-overlay-message-sub">
              Anywhere on the page works
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
