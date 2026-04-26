import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useSite } from '../context/SiteContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { apiGet, apiPost, triggerAuthFailure } from '../api';
import LoadingSpinner from '../components/LoadingSpinner';

// isAppleDevice returns true for clients whose video stack prefers HLS over
// DASH: iOS/iPadOS Safari (all browsers on iOS share WebKit), macOS Safari,
// and iPadOS 13+ which masquerades as "Macintosh" but reports maxTouchPoints.
// Everywhere else we prefer DASH so Shaka Player handles the media itself
// (Chromium, Firefox, Edge, Chrome on Android).
//
// This branch only matters for CMAF videos — TS videos always load the HLS
// master URL regardless of UA (no DASH manifest exists for them).
function isAppleDevice() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ advertises itself as Macintosh but is still Safari/WebKit
  // under the hood and supports native HLS the same way.
  if (/Macintosh/.test(ua) && typeof navigator !== 'undefined'
      && navigator.maxTouchPoints > 1) return true;
  // Safari on macOS — positive Safari token, rule out the other big
  // Safari-derivative UAs that also include the "Safari" substring.
  if (/Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox|FxiOS/.test(ua)) return true;
  return false;
}

// pickManifestUrl chooses HLS or DASH based on videoType + UA.
//   - legacy TS: always the HLS master URL (hlsUrl). No DASH for TS.
//   - CMAF + Apple: HLS master URL; Safari delegates to <video> native HLS.
//   - CMAF + non-Apple: DASH MPD URL; Shaka handles the segments directly.
//
// Falls back to hlsUrl if dashUrl is missing — protects the page in the
// transitional window where a server response may not yet include the field.
function pickManifestUrl(data) {
  if (data.videoType === 'cmaf' && !isAppleDevice() && data.dashUrl) {
    return data.dashUrl;
  }
  return data.hlsUrl;
}

export default function WatchPage() {
  const { videoId } = useParams();
  const { siteName } = useSite();
  const { refresh } = useAuth();
  const { showToast } = useToast();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [theaterActive, setTheaterActive] = useState(false);

  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const playerRef = useRef(null);
  const destroyedRef = useRef(false);
  const tokenRef = useRef('');
  const validityRef = useRef(0);

  // Watch-tracking state lives in a ref so flush triggers outside the Shaka
  // effect (pause listener, back-button onClick) can reach it.
  //   accumulated — real-time-elapsed seconds not yet credited to the server
  //   inflight    — true while a POST is outstanding (single-flight lock)
  //   stopped     — set on 401/403/429, kills further flushes for the session
  //   lastWall    — wall-clock ms of the previous tick
  //   lastPos     — video currentTime at the previous tick
  const trackingRef = useRef({
    accumulated: 0,
    inflight: false,
    stopped: false,
    lastWall: 0,
    lastPos: 0,
  });
  // Populated once the video element exists (inside player.load().then).
  // Calling it triggers a flush of whatever is in `accumulated`, respecting
  // the in-flight lock.
  const flushWatchRef = useRef(null);

  // Fetch video data
  useEffect(() => {
    (async () => {
      try {
        const { data: d, ok } = await apiGet(`/api/watch/${videoId}`);
        if (ok && d) {
          setData(d);
          tokenRef.current = d.hmacToken || '';
          validityRef.current = d.tokenValiditySeconds || 0;
          document.title = `${d.video.title} - ${siteName}`;
        } else {
          setError(d?.error || 'Failed to load video.');
          // If the server says playback was rejected for this user, the
          // in-memory AuthContext copy of the user is stale. Re-fetch so
          // the AppShell banner and course-list greyout appear without
          // requiring a sign out / sign in cycle.
          if (d?.code === 'no_playback_permission') {
            refresh();
          }
        }
      } catch {
        setError('Failed to load video.');
      }
      setLoading(false);
    })();
  }, [videoId, siteName, refresh]);

  // Destroy and show error
  const destroyAndShowError = useCallback((title, message) => {
    if (destroyedRef.current) return;
    destroyedRef.current = true;
    try { playerRef.current?.destroy(); } catch {}
    if (containerRef.current) {
      containerRef.current.innerHTML =
        `<div class="player-error-overlay"><h2>${title}</h2><p>${message}</p></div>`;
    }
  }, []);

  // Init Shaka Player
  useEffect(() => {
    if (!data || !videoRef.current) return;
    const shaka = window.shaka;
    if (!shaka) return;

    shaka.polyfill.installAll();
    if (!shaka.Player.isBrowserSupported()) {
      setError('Your browser does not support video playback.');
      return;
    }

    // Per-effect cleanup state. `cancelled` covers the race between this
    // effect's async `.then` callbacks resolving and the cleanup function
    // running (e.g., StrictMode mount/unmount/mount in dev — without this,
    // the first run's `.then` would still mount a UI overlay AFTER cleanup
    // destroyed its player, leaving two stacked control bars).
    //
    // `destroyedRef` is reset on each effect entry so terminal-error state
    // from a previous instance (e.g., 401 during a prior refresh) doesn't
    // poison the current player.
    destroyedRef.current = false;
    let cancelled = false;
    let ui = null;
    let refreshIntervalId = null;
    let tickIntervalId = null;
    let refreshPlayHandler = null;
    let refreshVisHandler = null;
    let tickVisHandler = null;
    let pauseHandler = null;

    const videoEl = videoRef.current;
    const player = new shaka.Player();
    playerRef.current = player;

    player.attach(videoEl).then(() => {
      if (cancelled) return;
      ui = new shaka.ui.Overlay(player, containerRef.current, videoEl);
      const isTouchDevice = navigator.maxTouchPoints > 0;
      ui.configure({
        playbackRates: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5],
        enableKeyboardPlaybackControls: false,
        singleClickForPlayAndPause: !isTouchDevice,
        seekOnTaps: isTouchDevice,
        doubleClickForFullscreen: !isTouchDevice,
      });

      player.configure('streaming.bufferingGoal', 60);
      player.configure('streaming.rebufferingGoal', 2);

      // HMAC token request filter
      if (tokenRef.current && data.r2PublicDomain) {
        const networkEngine = player.getNetworkingEngine();

        networkEngine.registerRequestFilter((type, request) => {
          if (!tokenRef.current) return;
          const url = request.uris[0];
          if (!url || !url.includes(data.r2PublicDomain)) return;
          request.uris = request.uris.map(uri => {
            try {
              const urlObj = new URL(uri);
              urlObj.searchParams.set('verify', tokenRef.current);
              return urlObj.toString();
            } catch {
              if (uri.includes('?verify=')) return uri.replace(/verify=[^&]+/, 'verify=' + encodeURIComponent(tokenRef.current));
              return uri + (uri.includes('?') ? '&' : '?') + 'verify=' + encodeURIComponent(tokenRef.current);
            }
          });
        });

        // Proactive token refresh
        let refreshing = false;

        function tokenAge() {
          if (!tokenRef.current || !validityRef.current) return 0;
          const dash = tokenRef.current.indexOf('-');
          if (dash === -1) return 0;
          const issuedAt = parseInt(tokenRef.current.substring(0, dash), 10);
          if (isNaN(issuedAt)) return 0;
          return Math.floor(Date.now() / 1000) - issuedAt;
        }

        function needsRefresh() {
          return tokenRef.current && validityRef.current > 0 && tokenAge() > validityRef.current / 2;
        }

        // Single-flight refresh: try/finally guarantees `refreshing` is
        // released regardless of which terminal status fires (401/403/404/
        // 429), so the lock can never wedge on.
        async function refreshToken() {
          if (refreshing) return;
          refreshing = true;
          try {
            for (let attempt = 0; attempt <= 5; attempt++) {
              try {
                if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 1000));
                const resp = await fetch('/api/refresh-token/' + data.video.video_id);
                if (resp.ok) {
                  const d = await resp.json();
                  if (d.token) tokenRef.current = d.token;
                  if (d.tokenValiditySeconds > 0) validityRef.current = d.tokenValiditySeconds;
                  return;
                }
                if (resp.status === 401) { triggerAuthFailure(); return; }
                if (resp.status === 429) { destroyAndShowError('Too Many Requests', 'You are being rate limited.'); return; }
                if (resp.status === 404) { destroyAndShowError('Video Unavailable', 'This video is no longer available.'); return; }
                if (resp.status === 403) { destroyAndShowError('Access Denied', 'You no longer have permission.'); return; }
              } catch {}
            }
          } finally {
            refreshing = false;
          }
        }

        function checkAndRefresh() {
          if (cancelled || destroyedRef.current) return;
          if (needsRefresh()) refreshToken();
        }

        // Poll every 5s. Skip only when nothing is happening (tab hidden AND
        // playback paused/ended) — a paused-but-focused user can still scrub
        // the seek bar, which triggers segment fetches that need a fresh
        // token. The `play` and `visibilitychange` listeners give immediate
        // detection on resume / refocus on top of the 5s baseline.
        refreshIntervalId = setInterval(() => {
          if (document.hidden && (videoEl.paused || videoEl.ended)) return;
          checkAndRefresh();
        }, 5000);

        refreshPlayHandler = checkAndRefresh;
        videoEl.addEventListener('play', refreshPlayHandler);
        refreshVisHandler = () => { if (!document.hidden) checkAndRefresh(); };
        document.addEventListener('visibilitychange', refreshVisHandler);
      }

      // Error handling
      function handleShakaError(err) {
        if (err && err.code === 1001 && err.data && err.data[1] === 404) {
          destroyAndShowError('Video Unavailable', 'This video is no longer available.');
        } else {
          console.error('Player error:', err);
        }
      }

      player.addEventListener('error', (event) => handleShakaError(event.detail));

      // Load manifest — HLS for TS + Apple clients; DASH for CMAF elsewhere.
      const manifestUrl = pickManifestUrl(data);
      player.load(manifestUrl, data.resumePosition > 0 ? data.resumePosition : undefined)
        .then(() => {
          if (cancelled) return;
          // Start watch tracking. Reset the shared ref so a second load of this
          // page (route change back to the same video) starts clean.
          const t = trackingRef.current;
          t.accumulated = 0;
          t.inflight = false;
          t.stopped = false;
          t.lastWall = Date.now();
          t.lastPos = videoEl.currentTime;

          // flushNow — the single send path. Called by the 1s tick when
          // accumulated crosses the threshold, by the videoEl 'pause' event,
          // and by the back-button onClick.
          //
          // Optimistic zeroing: we snapshot `accumulated` as `delta` and set
          // accumulated to 0 before the fetch. A pause/back that fires while
          // a request is in flight sees accumulated already at (or near) 0
          // and the in-flight guard short-circuits it anyway — no double-count.
          //
          // We send exactly the real seconds accumulated (float, no rounding)
          // so quick pause/unpause cycles don't bleed up to 0.5s per flush.
          // We also send even when delta is 0 (pause fired with nothing new
          // watched) so the server refreshes last_position — the user may
          // have scrubbed while paused and we want that saved.
          //
          // Network error rolls the seconds back. HTTP error statuses
          // (401/403/429) are terminal: tracking stops, rollback doesn't
          // matter because no future flush will fire. 422 means the server
          // rejected the payload as malformed — shouldn't happen with an
          // unmodified client; we silently drop the flush (no rollback, no
          // retry) so a tampered client can't game the retry path. Any
          // other non-2xx also falls through as a silent drop.
          function flushNow() {
            if (t.stopped || destroyedRef.current || t.inflight) return;

            const delta = Math.max(0, t.accumulated);
            t.inflight = true;
            t.accumulated = 0;
            const pos = videoEl.currentTime;

            fetch('/api/updatewatch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                video_id: parseInt(videoId),
                position: pos,
                delta,
              }),
            })
              .then(resp => {
                if (resp.status === 401) { t.stopped = true; triggerAuthFailure(); }
                else if (resp.status === 429) { t.stopped = true; destroyAndShowError('Too Many Requests', 'Rate limited.'); }
                else if (resp.status === 403) { t.stopped = true; destroyAndShowError('Access Denied', 'Permission revoked.'); }
              })
              .catch(() => {
                // Network failure — put the seconds back so the next flush
                // picks them up. Adds zero if this was a position-only flush,
                // which is the correct no-op.
                t.accumulated += delta;
              })
              .finally(() => { t.inflight = false; });
          }

          flushWatchRef.current = flushNow;

          function tick() {
            if (t.stopped || destroyedRef.current) return;
            const now = Date.now();
            const pos = videoEl.currentTime;
            const wallDelta = (now - t.lastWall) / 1000;
            const posMoved = pos !== t.lastPos;
            t.lastWall = now;
            t.lastPos = pos;

            if (!videoEl.paused && !videoEl.ended && posMoved && wallDelta > 0) {
              t.accumulated += wallDelta;
            }

            if (t.accumulated >= 10) flushNow();
          }

          tickIntervalId = setInterval(tick, 1000);
          tickVisHandler = () => { if (!document.hidden) tick(); };
          document.addEventListener('visibilitychange', tickVisHandler);
          // Flush on pause so a user who watches 7s and pauses doesn't lose
          // those seconds. Also fires at end-of-stream, which is fine.
          pauseHandler = flushNow;
          videoEl.addEventListener('pause', pauseHandler);
        })
        .catch(handleShakaError);
    });

    return () => {
      cancelled = true;
      destroyedRef.current = true;
      if (refreshIntervalId) clearInterval(refreshIntervalId);
      if (tickIntervalId) clearInterval(tickIntervalId);
      if (refreshPlayHandler) videoEl.removeEventListener('play', refreshPlayHandler);
      if (refreshVisHandler) document.removeEventListener('visibilitychange', refreshVisHandler);
      if (tickVisHandler) document.removeEventListener('visibilitychange', tickVisHandler);
      if (pauseHandler) videoEl.removeEventListener('pause', pauseHandler);
      try { ui?.destroy(); } catch {}
      try { player.destroy(); } catch {}
    };
  }, [data, videoId, destroyAndShowError]);

  // Keyboard controls
  useEffect(() => {
    if (!data) return;

    function handleKeyDown(e) {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const videoEl = videoRef.current;
      if (!videoEl) return;

      if (e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault(); e.stopPropagation();
        videoEl.paused ? videoEl.play() : videoEl.pause();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        videoEl.currentTime = Math.min(videoEl.currentTime + 5, videoEl.duration || Infinity);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        videoEl.currentTime = Math.max(videoEl.currentTime - 10, 0);
      } else if (e.key === 't' || e.key === 'T') {
        setTheaterActive(v => !v);
      } else if (e.key === 'Escape') {
        if (!document.fullscreenElement) setTheaterActive(false);
      }
    }

    function handleKeyUp(e) {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault(); e.stopPropagation();
      }
    }

    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('keyup', handleKeyUp, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('keyup', handleKeyUp, true);
    };
  }, [data]);

  // Theater mode body class
  useEffect(() => {
    document.body.classList.toggle('theater-mode', theaterActive);
    return () => document.body.classList.remove('theater-mode');
  }, [theaterActive]);

  if (loading) return <LoadingSpinner />;

  if (error) {
    return (
      <div style={{ textAlign: 'center', paddingTop: '40px' }}>
        <h2>Error</h2>
        <p className="text-muted">{error}</p>
        <Link to="/" className="btn btn-primary" style={{ marginTop: '16px' }}>
          Back to Home
        </Link>
      </div>
    );
  }

  const { video } = data;
  const backUrl = `/course/${video.course_id}`;

  return (
    <div className="player-container">
      <div className="player-nav-bar">
        <Link
          to={backUrl}
          className="player-back-link"
          onClick={() => { flushWatchRef.current?.(); }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M10 12L6 8l4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          {video.course_name}
        </Link>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
          <span className="player-nav-title">{video.title}</span>
          <button
            className="theater-toggle-btn"
            title={theaterActive ? 'Exit theater mode (t)' : 'Theater mode (t)'}
            onClick={() => setTheaterActive(v => !v)}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <rect x="1" y="3" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" fill="none"/>
              <rect x="3" y="5" width="10" height="6" rx="0.5" stroke="currentColor" strokeWidth="1" fill="none" strokeDasharray="2 1"/>
            </svg>
          </button>
        </div>
      </div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="video-player" ref={containerRef} data-shaka-player-container>
          <video ref={videoRef} id="video-element" autoPlay />
        </div>
      </div>
      <div className="player-scroll">
        <div className="card mt-2">
          <h2>{video.title}</h2>
          <p className="text-muted text-sm mt-1">
            {video.week && <>Week {video.week} &middot; </>}
            {video.lecture_date && <>{video.lecture_date.slice(0, 10)} &middot; </>}
            {video.duration_seconds > 0 && (
              <>{Math.floor(video.duration_seconds / 3600)}h {Math.floor((video.duration_seconds % 3600) / 60)}m</>
            )}
          </p>
          {video.description && <p className="mt-2">{video.description}</p>}
        </div>
      </div>
    </div>
  );
}
