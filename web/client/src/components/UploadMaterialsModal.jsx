import { useState, useRef, useEffect } from 'react';
import { useToast } from '../context/ToastContext';
import { moduleTerm } from '../utils/moduleLabel';
import useFullWindowDrop from '../hooks/useFullWindowDrop';
import DropVeil from './DropVeil';
import { MATERIAL_MAX_BYTES, isBlockedFile, uploadMaterialBatch } from '../services/materialUploadService';

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
);
const UploadIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5" /><path d="M12 3v12" /></svg>
);
const FileIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" /><path d="M9 13h6" /><path d="M9 17h4" /></svg>
);
const PlusIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
);
const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l4 4 10-11" /></svg>
);
const RetryIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" /></svg>
);

function formatFileSize(bytes) {
  if (!bytes) return '';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}
function ficoClass(filename) {
  const ext = (filename.split('.').pop() || '').toUpperCase();
  return { PDF: 'fico-pdf', DOC: 'fico-doc', DOCX: 'fico-doc', ZIP: 'fico-zip', CSV: 'fico-csv' }[ext] || 'fico-gen';
}
function blockedReason(file) {
  if (isBlockedFile(file.name)) return 'Videos belong in the Videos tab.';
  if (file.size > MATERIAL_MAX_BYTES) return 'Over the 100 MB limit.';
  return null;
}
const dedupeKey = (f) => `${f.name}::${f.size}::${f.lastModified}`;

export default function UploadMaterialsModal({ courseId, moduleLabel, onClose, onUploaded }) {
  const { showToast } = useToast();
  const modTerm = moduleTerm(moduleLabel);
  const fileInputRef = useRef(null);
  const idRef = useRef(0);
  const abortRef = useRef(null);
  const finishedRef = useRef(false);

  const [rows, setRows] = useState([]);
  const [bulkModule, setBulkModule] = useState('');
  const [phase, setPhase] = useState('stage'); // 'stage' | 'upload'

  const readyRows = rows.filter((r) => !r.blocked);
  const readyCount = readyRows.length;
  const skippedCount = rows.length - readyCount;
  const doneCount = readyRows.filter((r) => r.status === 'done').length;
  const inFlight = rows.some((r) => r.status === 'queued' || r.status === 'uploading');
  const anySucceeded = rows.some((r) => r.status === 'done');
  const canUpload = readyCount > 0 && !readyRows.some((r) => !r.moduleNumber.trim());

  function addFiles(files) {
    if (!files || !files.length) return;
    setRows((prev) => {
      const seen = new Set(prev.map((r) => dedupeKey(r.file)));
      const additions = [];
      for (const file of files) {
        const key = dedupeKey(file);
        if (seen.has(key)) continue;
        seen.add(key);
        const blocked = blockedReason(file);
        additions.push({ id: `f${idRef.current++}`, file, blocked, moduleNumber: blocked ? '' : bulkModule, status: null, pct: 0, error: null, materialId: null });
      }
      return prev.concat(additions);
    });
  }

  // Window-wide drop: appends to the staged batch rather than replacing it, so
  // files can be gathered from several folders. Stays enabled (and refuses)
  // while uploading — see UploadVideoModal for why the listeners can't just be
  // torn down.
  const { dragActive, refusing } = useFullWindowDrop({
    enabled: true,
    multiple: true,
    refuse: inFlight,
    onFiles: addFiles,
  });

  function applyBulkModule(value) {
    setBulkModule(value);
    setRows((prev) => prev.map((r) => (r.blocked ? r : { ...r, moduleNumber: value })));
  }
  function setRowModule(id, value) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, moduleNumber: value } : r)));
  }
  function removeRow(id) {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }

  async function runBatch(items) {
    finishedRef.current = false;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const ids = new Set(items.map((it) => it.id));
    setRows((prev) => prev.map((r) => (ids.has(r.id) ? { ...r, status: 'queued', pct: 0, error: null, materialId: null } : r)));
    await uploadMaterialBatch(courseId, items, {
      concurrency: 3,
      signal: ctrl.signal,
      onUpdate: (id, patch) => setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r))),
    });
    if (abortRef.current === ctrl) abortRef.current = null;
  }

  function startUpload() {
    const items = readyRows.map((r) => ({ id: r.id, file: r.file, moduleNumber: r.moduleNumber.trim() }));
    if (!items.length) return;
    setPhase('upload');
    runBatch(items);
  }
  function retryRow(id) {
    // A retry starts its own batch, which would replace abortRef and add workers
    // beyond the pool of 3. Only retry once the batch it belongs to has settled.
    if (inFlight) return;
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    runBatch([{ id: row.id, file: row.file, moduleNumber: row.moduleNumber.trim() }]);
  }
  function cancelRemaining() {
    if (abortRef.current) abortRef.current.abort();
  }

  function handleClose() {
    if (inFlight) return;
    if (anySucceeded) onUploaded(); else onClose();
  }

  // When every ready file has settled successfully, close through onUploaded.
  // A partial failure leaves the modal open so the user can retry.
  useEffect(() => {
    if (phase !== 'upload' || finishedRef.current) return;
    const ready = rows.filter((r) => !r.blocked);
    if (!ready.length || ready.some((r) => r.status === 'queued' || r.status === 'uploading')) return;
    if (ready.every((r) => r.status === 'done')) {
      finishedRef.current = true;
      showToast('Materials uploaded.', 'success');
      onUploaded();
    }
  }, [phase, rows, showToast, onUploaded]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || inFlight) return;
      if (anySucceeded) onUploaded(); else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inFlight, anySucceeded, onClose, onUploaded]);

  // Warn before leaving the tab mid-upload.
  useEffect(() => {
    if (!inFlight) return undefined;
    const handler = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [inFlight]);

  const noteParts = [];
  if (readyCount > 0) noteParts.push(`${readyCount} ready`);
  if (skippedCount > 0) noteParts.push(`${skippedCount} skipped`);

  const renderStageRow = (r) => {
    const cls = ficoClass(r.file.name);
    if (r.blocked) {
      return (
        <div className="vs-fl-row bad" key={r.id}>
          <span className={`vs-cv-fico ${cls}`}><FileIcon /></span>
          <div className="vs-fl-mn">
            <p className="vs-fl-t">{r.file.name}</p>
            <p className="vs-fl-s err">{r.blocked}</p>
          </div>
          <button type="button" className="vs-fl-x" onClick={() => removeRow(r.id)} aria-label="Remove"><CloseIcon /></button>
        </div>
      );
    }
    return (
      <div className="vs-fl-row" key={r.id}>
        <span className={`vs-cv-fico ${cls}`}><FileIcon /></span>
        <div className="vs-fl-mn">
          <p className="vs-fl-t">{r.file.name}</p>
          <p className="vs-fl-s">{formatFileSize(r.file.size)}</p>
        </div>
        <div className="vs-fl-mod">
          <input
            type="text" className="vs-input" value={r.moduleNumber}
            onChange={(e) => setRowModule(r.id, e.target.value)}
            maxLength={50} placeholder="#" autoComplete="off" aria-label={`${modTerm} number`}
          />
        </div>
        <button type="button" className="vs-fl-x" onClick={() => removeRow(r.id)} aria-label="Remove"><CloseIcon /></button>
      </div>
    );
  };

  const renderUploadRow = (r) => {
    const cls = ficoClass(r.file.name);
    return (
      <div className="vs-fl-row" key={r.id}>
        <span className={`vs-cv-fico ${cls}`}><FileIcon /></span>
        <div className="vs-fl-mn">
          <p className="vs-fl-t">{r.file.name}</p>
          {r.status === 'error' ? (
            <p className="vs-fl-s err">{r.error}</p>
          ) : (
            <div className="vs-progress"><div className={'vs-progress-fill' + (r.status === 'done' ? ' done' : '')} style={{ width: `${r.pct || 0}%` }} /></div>
          )}
        </div>
        {r.status === 'done' ? (
          <span className="vs-fl-ok"><CheckIcon /></span>
        ) : r.status === 'error' ? (
          <button type="button" className="vs-fl-x" onClick={() => retryRow(r.id)} disabled={inFlight} aria-label="Retry"><RetryIcon /></button>
        ) : (
          <span className="vs-fl-pct">{r.pct || 0}%</span>
        )}
      </div>
    );
  };

  return (
    <div className="vs-scrim">
      <DropVeil
        active={dragActive}
        refusing={refusing}
        title={refusing ? 'Upload in progress' : rows.length ? 'Drop to add more files' : 'Drop the files anywhere'}
        hint={refusing
          ? 'Wait for the current batch to finish, or cancel it first.'
          : 'PDF, DOCX, ZIP, CSV and more — up to 100 MB each'}
      />
      <div className="vs-modal vs-modal-wide">
        <div className="vs-modal-head">
          <h3 className="vs-modal-title">Upload materials</h3>
          <button type="button" className="vs-modal-x" onClick={handleClose} disabled={inFlight}><CloseIcon /></button>
        </div>

        <div className="vs-modal-body">
          {rows.length === 0 ? (
            <div
              className={'vs-dropzone' + (dragActive ? ' drag' : '')}
              onClick={() => fileInputRef.current?.click()}
            >
              <div className="vs-dropzone-ico"><UploadIcon /></div>
              <p className="vs-dropzone-t">Drop files here</p>
              <p className="vs-dropzone-h">or click to browse — PDF, DOCX, ZIP, CSV and more — up to 100 MB each</p>
            </div>
          ) : phase === 'stage' ? (
            <>
              <div className="vs-batch">
                <label className="vs-label" htmlFor="vs_bulk_module">{modTerm}</label>
                <input
                  type="text" id="vs_bulk_module" className="vs-input" style={{ maxWidth: 160 }}
                  value={bulkModule} onChange={(e) => applyBulkModule(e.target.value)}
                  maxLength={50} placeholder="e.g. 3" autoComplete="off"
                />
                <p className="vs-hint">Applies to every file below.</p>
              </div>
              <div className="vs-filelist">{rows.map(renderStageRow)}</div>
              <div style={{ marginTop: 12 }}>
                <button type="button" className="vs-btn vs-btn-sm" onClick={() => fileInputRef.current?.click()}><PlusIcon />Add more files</button>
              </div>
            </>
          ) : (
            <div className="vs-filelist">{readyRows.map(renderUploadRow)}</div>
          )}
        </div>

        <div className="vs-modal-foot">
          {phase === 'stage' ? (
            <>
              {noteParts.length > 0 && <span className="vs-modal-note">{noteParts.join(', ')}</span>}
              <button type="button" className="vs-btn" onClick={onClose}>Cancel</button>
              <button type="button" className="vs-btn vs-btn-primary" onClick={startUpload} disabled={!canUpload}>
                {`Upload ${readyCount} file${readyCount === 1 ? '' : 's'}`}
              </button>
            </>
          ) : inFlight ? (
            <>
              <button type="button" className="vs-btn" onClick={cancelRemaining}>Cancel remaining</button>
              <button type="button" className="vs-btn vs-btn-primary" disabled>{doneCount} of {readyCount} done</button>
            </>
          ) : (
            <>
              <span className="vs-modal-note">{doneCount} of {readyCount} uploaded</span>
              <button type="button" className="vs-btn vs-btn-primary" onClick={onUploaded}>Done</button>
            </>
          )}
        </div>
      </div>

      <input
        type="file" ref={fileInputRef} multiple style={{ display: 'none' }}
        onChange={(e) => { addFiles(Array.from(e.target.files)); e.target.value = ''; }}
      />
    </div>
  );
}
