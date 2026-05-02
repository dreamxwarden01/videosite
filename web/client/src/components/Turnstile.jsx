import { useEffect, useRef, useCallback } from 'react';
import { useSite } from '../context/SiteContext';

/**
 * Cloudflare Turnstile widget wrapper.
 * Props:
 *   onToken(token)   — called when token is received
 *   onExpire()       — called when token expires
 *   onError()        — called on widget error
 *   resetRef         — mutable ref; set resetRef.current = resetFn for external reset
 */
export default function Turnstile({ onToken, onExpire, onError, resetRef }) {
  const { turnstileSiteKey } = useSite();
  const containerRef = useRef(null);
  const widgetIdRef = useRef(null);

  const reset = useCallback(() => {
    if (widgetIdRef.current != null && window.turnstile) {
      window.turnstile.reset(widgetIdRef.current);
    }
  }, []);

  // Expose reset function via ref
  useEffect(() => {
    if (resetRef) resetRef.current = reset;
  }, [reset, resetRef]);

  useEffect(() => {
    if (!turnstileSiteKey || !containerRef.current) return;

    function renderWidget() {
      if (!window.turnstile || !containerRef.current) return;
      // Clear any previously rendered widget
      if (widgetIdRef.current != null) {
        try { window.turnstile.remove(widgetIdRef.current); } catch {}
      }
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: turnstileSiteKey,
        callback: (token) => onToken?.(token),
        'expired-callback': () => onExpire?.(),
        'error-callback': () => onError?.(),
      });
    }

    // Turnstile script might not be loaded yet
    if (window.turnstile) {
      renderWidget();
    } else {
      const interval = setInterval(() => {
        if (window.turnstile) {
          clearInterval(interval);
          renderWidget();
        }
      }, 100);
      return () => clearInterval(interval);
    }

    return () => {
      if (widgetIdRef.current != null && window.turnstile) {
        try { window.turnstile.remove(widgetIdRef.current); } catch {}
        widgetIdRef.current = null;
      }
    };
  }, [turnstileSiteKey]); // Only re-render if sitekey changes

  if (!turnstileSiteKey) return null;

  // Label appears the moment we know the widget will render (i.e., site
  // key is set), not after the widget has actually loaded. So if Turnstile
  // is enabled but the script is still downloading, the user already sees
  // the label and an empty placeholder area below it.
  return (
    <>
      <div className="turnstile-label">Let us know you are human</div>
      <div ref={containerRef} style={{ marginBottom: '16px' }} />
    </>
  );
}
