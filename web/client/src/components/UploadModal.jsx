import { useState, useRef, useEffect } from 'react';
import { multipartUpload, UploadConflictError, UploadAbortedError, UploadRetryExhaustedError, ALLOWED_VIDEO_EXTENSIONS, validateVideoFile } from '../services/uploadService';
import { useToast } from '../context/ToastContext';
import CourseSelector from './CourseSelector';
import useFullWindowDrop from '../hooks/useFullWindowDrop';

// Mirror of the server-side cap (POST /api/upload/create + POST /api/videos/:id).
// .length counts UTF-16 code units, matching the server check, so the client
// and server never disagree about what's over the line.
const MAX_DESCRIPTION_CHARS = 15000;

function parseFilename(filename, courses) {
  const base = filename.replace(/\.[^.]+$/, '');
  const match = base.match(/^(.+?)_Week(\d+)_(\d{8})/i);
  if (!match) return {};

  const courseStr = match[1].replace(/_/g, ' ').toLowerCase();
  const weekNum = match[2];
  const dateStr = match[3];

  const result = { parsedCourse: courseStr };

  const found = courses.find(c => c.course_name.toLowerCase() === courseStr);
  if (found) result.courseId = found.course_id;

  result.week = weekNum;

  const y = parseInt(dateStr.slice(0, 4));
  const m = parseInt(dateStr.slice(4, 6));
  const d = parseInt(dateStr.slice(6, 8));
  const dateObj = new Date(y, m - 1, d);
  if (dateObj.getFullYear() === y && dateObj.getMonth() === m - 1 && dateObj.getDate() === d) {
    result.date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  return result;
}

export default function UploadModal({ isOpen, onClose, courses, preselectedCourseId, preselectedCourseName, onUploadComplete }) {
  const { showToast } = useToast();
  const fileInputRef = useRef(null);
  const abortRef = useRef(null);

  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [courseId, setCourseId] = useState(preselectedCourseId || '');
  const [week, setWeek] = useState('');
  const [date, setDate] = useState('');
  const [description, setDescription] = useState('');
  const [descriptionTouched, setDescriptionTouched] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadText, setUploadText] = useState('');
  const [failed, setFailed] = useState(false);
  const [courseWarning, setCourseWarning] = useState('');
  const [successTitle, setSuccessTitle] = useState('');
  const [fileError, setFileError] = useState('');

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setFile(null);
      setTitle('');
      setCourseId(preselectedCourseId || '');
      setWeek('');
      setDate('');
      setDescription('');
      setDescriptionTouched(false);
      setUploading(false);
      setUploadProgress(0);
      setUploadText('');
      setFailed(false);
      setCourseWarning('');
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

  // Always-defined so we can use it after the early return below — hooks
  // can't run conditionally. Pulls the dragged file straight into the
  // file picker validator regardless of where in the tab the user
  // dropped it.
  const { dragActive: windowDragActive } = useFullWindowDrop({
    enabled: isOpen && !uploading && !successTitle,
    onFile: (f) => handleFileSelect(f),
  });

  if (!isOpen) return null;

  const selectedCourse = courses.find(c => String(c.course_id) === String(courseId));

  function handleFileSelect(selectedFile) {
    if (!selectedFile) return;
    setFileError('');

    const err = validateVideoFile(selectedFile);
    if (err) {
      setFileError(err);
      return;
    }

    setFile(selectedFile);
    setCourseWarning('');

    const parsed = parseFilename(selectedFile.name, courses);

    if (preselectedCourseId) {
      // Inside a course — don't change course, but warn if filename implies a different one
      if (parsed.parsedCourse) {
        const currentName = (preselectedCourseName || selectedCourse?.course_name || '').toLowerCase();
        if (parsed.parsedCourse !== currentName) {
          setCourseWarning(`Filename suggests "${parsed.parsedCourse.toUpperCase()}" but uploading to "${preselectedCourseName || selectedCourse?.course_name}".`);
        }
      }
      if (parsed.week) setWeek(parsed.week);
      if (parsed.date) setDate(parsed.date);
    } else {
      if (parsed.courseId) setCourseId(String(parsed.courseId));
      if (parsed.week) setWeek(parsed.week);
      if (parsed.date) setDate(parsed.date);
    }
  }

  async function handleUpload() {
    if (!file || !title.trim() || !courseId) return;

    setUploading(true);
    setFailed(false);
    setUploadProgress(0);
    setUploadText('Starting upload...');

    try {
      const result = await multipartUpload({
        file,
        createUrl: '/api/upload/create',
        createBody: {
          courseId,
          filename: file.name,
          fileSize: file.size,
          contentType: file.type || 'application/octet-stream',
          title: title.trim(),
          week: week || null,
          lectureDate: date || null,
          description: description.trim() || null,
        },
        onProgress: (percent, uploaded, total) => {
          setUploadProgress(percent);
          setUploadText(`${percent}% (${(uploaded / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB)`);
        },
        onAbortRef: abortRef,
      });

      setUploading(false);
      setSuccessTitle(title.trim());
    } catch (err) {
      if (err instanceof UploadAbortedError) {
        showToast('Upload cancelled', 'info');
      } else if (err instanceof UploadConflictError) {
        if (err.conflictData.type === 'video') {
          showToast('A video with the same title, week, and date already exists in this course.', 'error');
        } else {
          showToast('Another upload with matching metadata is already in progress.', 'error');
        }
      } else if (err instanceof UploadRetryExhaustedError) {
        showToast('Upload failed after multiple retries. Please try again.', 'error');
      } else {
        showToast(err.message || 'Upload failed', 'error');
      }
      setFailed(true);
      setUploading(false);
    }
  }

  async function handleAbort() {
    if (abortRef.current) {
      await abortRef.current();
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

  const descriptionTooLong = description.length > MAX_DESCRIPTION_CHARS;
  const descriptionInvalid = descriptionTouched && descriptionTooLong;
  const canUpload = file && title.trim() && courseId && !uploading && !descriptionTooLong;

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
              <strong>{successTitle}</strong> has been uploaded and is now queued for processing.
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
          <h3>Upload a Video</h3>
          <button className="modal-close" onClick={handleClose} disabled={uploading}>&times;</button>
        </div>
        <div className="modal-body">
          {/* Drop zone — click target for the file picker. Drag-and-drop
              itself is handled at the window level by useFullWindowDrop
              so dropping anywhere on the tab works, not just on this
              small rectangle. */}
          <div
            className={`upload-dropzone${file ? ' has-file' : ''}`}
            onClick={() => !uploading && fileInputRef.current?.click()}
            style={{ pointerEvents: uploading ? 'none' : 'auto' }}
          >
            <p>{file ? file.name : 'Drag & drop a video file here, or click to select'}</p>
            {file && <p style={{ fontSize: '12px', marginTop: '4px', color: '#6b7280' }}>{(file.size / 1048576).toFixed(1)} MB</p>}
            <input
              type="file"
              ref={fileInputRef}
              accept={ALLOWED_VIDEO_EXTENSIONS.join(',')}
              style={{ display: 'none' }}
              onChange={e => { if (e.target.files[0]) handleFileSelect(e.target.files[0]); }}
            />
          </div>
          {fileError && (
            <p style={{ color: '#dc3545', fontSize: '13px', marginTop: '8px', marginBottom: '0' }}>{fileError}</p>
          )}

          {/* Title */}
          <div className="form-group">
            <label>Title <span style={{ color: '#dc3545' }}>*</span></label>
            <input
              type="text"
              className="form-control"
              value={title}
              onChange={e => setTitle(e.target.value)}
              disabled={uploading}
              placeholder="Video title"
            />
          </div>

          {/* Course selector */}
          <div className="form-group">
            <label>Course <span style={{ color: '#dc3545' }}>*</span></label>
            {preselectedCourseId ? (
              <>
                <input
                  type="text"
                  className="form-control"
                  value={preselectedCourseName || selectedCourse?.course_name || ''}
                  disabled
                  style={{ background: '#f3f4f6' }}
                />
                {courseWarning && (
                  <small style={{ color: '#d97706', display: 'block', marginTop: '4px' }}>{courseWarning}</small>
                )}
              </>
            ) : (
              <CourseSelector
                courses={courses}
                value={courseId}
                onChange={setCourseId}
                disabled={uploading}
              />
            )}
          </div>

          {/* Week + Date on same row */}
          <div style={{ display: 'flex', gap: '12px' }}>
            <div className="form-group" style={{ flex: 1 }}>
              <label>Week</label>
              <input
                type="text"
                className="form-control"
                value={week}
                onChange={e => setWeek(e.target.value.replace(/\D/g, ''))}
                disabled={uploading}
                placeholder="e.g. 5"
              />
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label>Date</label>
              <input
                type="date"
                className="form-control"
                value={date}
                onChange={e => setDate(e.target.value)}
                disabled={uploading}
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
              onBlur={() => setDescriptionTouched(true)}
              onFocus={() => setDescriptionTouched(false)}
              disabled={uploading}
              rows={3}
              placeholder="Optional description"
              style={descriptionInvalid ? { borderColor: '#dc3545' } : undefined}
            />
            <div style={{
              fontSize: '12px',
              marginTop: '4px',
              textAlign: 'right',
              color: descriptionTooLong ? '#dc3545' : '#6b7280',
            }}>
              {description.length.toLocaleString()} / {MAX_DESCRIPTION_CHARS.toLocaleString()}
            </div>
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
      {/* Full-window drop overlay. The hook flips windowDragActive
          true on dragenter of a Files drag and false on dragleave/drop.
          The overlay z-index sits above everything else so a drop
          anywhere in the tab is captured here. The actual file plumbing
          (validateVideoFile etc.) lives in handleFileSelect, which the
          hook calls via its onFile callback. */}
      {windowDragActive && (
        <div className="full-window-drop-overlay">
          <div className="full-window-drop-overlay-message">
            Drop the video here
            <span className="full-window-drop-overlay-message-sub">
              Anywhere on the page works
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
