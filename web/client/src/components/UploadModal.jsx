import { useState, useRef, useEffect } from 'react';
import { multipartUpload, UploadConflictError, UploadAbortedError, UploadRetryExhaustedError } from '../services/uploadService';
import { useToast } from '../context/ToastContext';

// Mirror of the server-side allowlist in routes/api/upload.js. The check
// here is UX (fail fast, no wasted multipart init); the server is the
// source of truth.
const ALLOWED_EXTENSIONS = ['.mp4', '.mkv', '.mov', '.webm', '.m4v', '.avi', '.flv', '.wmv', '.ts', '.mpg', '.mpeg', '.3gp'];
const MAX_FILE_SIZE = 50 * 1024 * 1024 * 1024; // 50 GB

function getExtension(filename) {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.substring(dot).toLowerCase() : '';
}

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
  const [dragActive, setDragActive] = useState(false);
  const [title, setTitle] = useState('');
  const [courseId, setCourseId] = useState(preselectedCourseId || '');
  const [courseSearch, setCourseSearch] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [week, setWeek] = useState('');
  const [date, setDate] = useState('');
  const [description, setDescription] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadText, setUploadText] = useState('');
  const [failed, setFailed] = useState(false);
  const [courseWarning, setCourseWarning] = useState('');
  const [successTitle, setSuccessTitle] = useState('');
  const [fileError, setFileError] = useState('');

  const dropdownRef = useRef(null);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setFile(null);
      setTitle('');
      setCourseId(preselectedCourseId || '');
      setCourseSearch('');
      setShowDropdown(false);
      setWeek('');
      setDate('');
      setDescription('');
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

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  if (!isOpen) return null;

  const selectedCourse = courses.find(c => String(c.course_id) === String(courseId));
  const filteredCourses = courses.filter(c =>
    c.course_name.toLowerCase().includes(courseSearch.toLowerCase())
  );

  function handleFileSelect(selectedFile) {
    if (!selectedFile) return;
    setFileError('');

    const ext = getExtension(selectedFile.name);
    if (!ext) {
      setFileError('File must have an extension.');
      return;
    }
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      setFileError(`File type not allowed. Supported: ${ALLOWED_EXTENSIONS.join(', ')}.`);
      return;
    }
    if (selectedFile.size > MAX_FILE_SIZE) {
      setFileError('File size exceeds 50 GB limit.');
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

  function handleDrop(e) {
    e.preventDefault();
    setDragActive(false);
    if (uploading) return;
    const f = e.dataTransfer.files[0];
    if (f) handleFileSelect(f);
  }

  function handleDragOver(e) {
    e.preventDefault();
    if (!uploading) setDragActive(true);
  }

  function handleDragLeave(e) {
    e.preventDefault();
    setDragActive(false);
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

  const canUpload = file && title.trim() && courseId && !uploading;

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
          {/* Drop zone */}
          <div
            className={`upload-dropzone${dragActive ? ' drag-active' : ''}${file ? ' has-file' : ''}`}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => !uploading && fileInputRef.current?.click()}
            style={{ pointerEvents: uploading ? 'none' : 'auto' }}
          >
            <p>{file ? file.name : 'Drag & drop a video file here, or click to select'}</p>
            {file && <p style={{ fontSize: '12px', marginTop: '4px', color: '#6b7280' }}>{(file.size / 1048576).toFixed(1)} MB</p>}
            <input
              type="file"
              ref={fileInputRef}
              accept={ALLOWED_EXTENSIONS.join(',')}
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
              <div className="course-select-wrap" ref={dropdownRef}>
                <input
                  type="text"
                  className="form-control"
                  value={showDropdown ? courseSearch : (selectedCourse?.course_name || courseSearch)}
                  onChange={e => {
                    setCourseSearch(e.target.value);
                    setCourseId('');
                    setShowDropdown(true);
                  }}
                  onFocus={() => setShowDropdown(true)}
                  disabled={uploading}
                  placeholder="Search for a course..."
                />
                {showDropdown && filteredCourses.length > 0 && (
                  <div className="course-select-dropdown">
                    {filteredCourses.map(c => (
                      <div
                        key={c.course_id}
                        className="course-select-option"
                        onClick={() => {
                          setCourseId(String(c.course_id));
                          setCourseSearch(c.course_name);
                          setShowDropdown(false);
                        }}
                      >
                        {c.course_name}
                      </div>
                    ))}
                  </div>
                )}
              </div>
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
              disabled={uploading}
              rows={3}
              placeholder="Optional description"
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
    </div>
  );
}
