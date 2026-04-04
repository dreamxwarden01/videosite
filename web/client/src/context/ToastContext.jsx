import { createContext, useContext, useState, useCallback, useRef } from 'react';

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null);
  const timerRef = useRef(null);

  const showToast = useCallback((message, type = 'error') => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast({ message, type, hiding: false });
    timerRef.current = setTimeout(() => {
      setToast(prev => prev ? { ...prev, hiding: true } : null);
      setTimeout(() => setToast(null), 300);
    }, 5000);
  }, []);

  const dismissToast = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast(prev => prev ? { ...prev, hiding: true } : null);
    setTimeout(() => setToast(null), 300);
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {toast && (
        <div className="toast-container">
          <div
            className={`toast toast-${toast.type}${toast.hiding ? ' toast-hide' : ''}`}
            onClick={dismissToast}
          >
            {toast.message}
          </div>
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
