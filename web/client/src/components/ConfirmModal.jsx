import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';

const ConfirmContext = createContext(null);

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
);

// A promise-returning confirmation dialog, styled on .vs-modal (the worker-key
// modal look). Call as confirm('message') or, for a titled dialog with a verb
// button, confirm({ title, message, confirmLabel, cancelLabel, danger }).
// `danger` (default true) colours the confirm button red; false → blue.
export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null);
  const resolveRef = useRef(null);
  const idRef = useRef(0);          // bumped per open → keys the modal so autoFocus re-runs
  const downOnScrim = useRef(false); // guards backdrop click-to-cancel against a drag-release

  const confirm = useCallback((opts) => {
    const o = typeof opts === 'string' ? { message: opts } : (opts || {});
    return new Promise((resolve) => {
      // Re-entrancy guard: if a dialog is already open, resolve its awaiter
      // (false) instead of orphaning it under an overwritten resolver.
      if (resolveRef.current) resolveRef.current(false);
      resolveRef.current = resolve;
      setState({
        id: idRef.current++,
        title: o.title || 'Are you sure?',
        message: o.message || '',
        confirmLabel: o.confirmLabel || 'Confirm',
        cancelLabel: o.cancelLabel || 'Cancel',
        danger: o.danger !== false,
      });
    });
  }, []);

  const settle = (val) => { resolveRef.current?.(val); resolveRef.current = null; setState(null); };
  const handleConfirm = () => settle(true);
  const handleCancel = () => settle(false);

  // Esc cancels. Capture + stopPropagation so it's the SOLE handler while open —
  // otherwise an invoking modal's own window-level Esc (e.g. CourseEditModal)
  // would also fire and try to close underneath the dialog. No Enter-to-confirm:
  // the confirm button is only autofocused for non-destructive dialogs, so a
  // reflexive Enter on a destructive one lands on Cancel, never the red action.
  useEffect(() => {
    if (!state) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); settle(false); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [state]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state && (
        <div className="vs-scrim vs-scrim-confirm"
          onMouseDown={(e) => { downOnScrim.current = e.target === e.currentTarget; }}
          onClick={(e) => { if (downOnScrim.current && e.target === e.currentTarget) handleCancel(); }}>
          <div key={state.id} className="vs-modal" style={{ maxWidth: 440 }} onClick={e => e.stopPropagation()} role="alertdialog" aria-modal="true">
            <div className="vs-modal-head">
              <h3 className="vs-modal-title">{state.title}</h3>
              <button type="button" className="vs-modal-x" onClick={handleCancel} aria-label="Close"><CloseIcon /></button>
            </div>
            <div className="vs-modal-body">
              <p className="vs-confirm-msg">{state.message}</p>
            </div>
            <div className="vs-modal-foot">
              <button type="button" className="vs-btn" onClick={handleCancel} autoFocus={state.danger}>{state.cancelLabel}</button>
              <button type="button" className={'vs-btn ' + (state.danger ? 'vs-btn-danger' : 'vs-btn-primary')} onClick={handleConfirm} autoFocus={!state.danger}>
                {state.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within ConfirmProvider');
  return ctx;
}
