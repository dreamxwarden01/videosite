import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useSite } from '../context/SiteContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { apiGet, apiPost, triggerAuthFailure, isSigningOut } from '../api';
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

// pickManifestUrl assembles the manifest URL from the building blocks the
// server returns — videoPath, videoType, r2PublicDomain, hmacToken — instead
// of consuming a pre-built hlsUrl/dashUrl pair. Lets the bundle pick HLS vs
// DASH locally so the server doesn't need to UA-sniff.
//
//   - legacy TS: always master.m3u8. No DASH manifest exists for TS.
//   - CMAF + Apple: master.m3u8; Safari delegates to <video> native HLS.
//   - CMAF + non-Apple: manifest.mpd; Shaka handles the DASH segments.
//
// The networking-engine request filter (registered later) overwrites
// `?verify=` with the freshest token on every request, so the value baked
// into the initial URL is fine to be the first-load token — refresh handles
// long-running playback.
function pickManifestUrl(data) {
  const useDash = data.videoType === 'cmaf' && !isAppleDevice();
  const file = useDash ? 'manifest.mpd' : 'master.m3u8';
  const base = `https://${data.r2PublicDomain}${data.videoPath}${file}`;
  if (!data.hmacToken) return base;
  return `${base}?verify=${encodeURIComponent(data.hmacToken)}`;
}

// isManifestOrInitUrl matches the URLs whose disappearance means the whole
// video is gone (manifests + init segments), as opposed to .m4s media
// segments which Shaka retries and where a permanent loss should stall
// playback at that point rather than tear the player down. Used to gate
// destroyAndShowError on 404 — see handleShakaError below.
function isManifestOrInitUrl(url) {
  if (!url) return false;
  const path = url.split('?')[0].toLowerCase();
  return path.endsWith('.m3u8') || path.endsWith('.mpd') || path.endsWith('.mp4');
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
          if (siteName) document.title = `${d.video.title} - ${siteName}`;
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
    let pagehideHandler = null;
    let metadataHandler = null;
    // Beacon flush — populated inside player.load().then once tracking state
    // is initialized. Used by both the pagehide handler (tab close, full
    // reload) and this effect's cleanup (client-side route nav, e.g. clicking
    // the site title or username). Beacon is fire-and-forget so it survives
    // unmount and unload alike; regular flushNow is reserved for tick/pause
    // where we still care about the response status.
    let flushBeacon = null;

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

      // Adopt the loaded video's actual aspect ratio. The container starts at
      // 16:9 (CSS placeholder) so layout reserves the right amount of space
      // before metadata arrives; once we know the real dims, we override
      // inline so non-16:9 content (1280×832, vertical phone, etc.) renders
      // without baked-in or CSS-imposed letterboxing. Reset on cleanup.
      metadataHandler = () => {
        const c = containerRef.current;
        if (c && videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
          c.style.aspectRatio = `${videoEl.videoWidth} / ${videoEl.videoHeight}`;
        }
      };
      videoEl.addEventListener('loadedmetadata', metadataHandler);

      player.configure('streaming.bufferingGoal', 60);
      player.configure('streaming.rebufferingGoal', 2);

      // Retry policy for flaky / mobile networks.
      //
      // Shaka's defaults (maxAttempts=2, baseDelay=1s) give up after a single
      // retry ~1.5s after the initial failure — easily killed by cell-handoff
      // blackouts (3-5s) or hotspot dropouts. With these values:
      //   - common-case recovery (1-3 retries) completes in ~1-4 seconds
      //   - real outages get ~4 minutes of patient retry before erroring out
      //     (10 retries × ~20s timeout + ~57s of cumulative backoff)
      // baseFactor=1.5 keeps the middle retries dense (matches typical
      // cell-handoff recovery windows) rather than spreading to minutes.
      // stallTimeout=3s and connectionTimeout=5s fail dead connections fast
      // so we get back to retrying on a fresh socket sooner.
      //
      // Applied to both streaming (segments + DRM) and manifest fetches.
      const retryParams = {
        maxAttempts: 11,        // 1 initial + 10 retries
        baseDelay: 500,         // 0.5s before first retry
        backoffFactor: 1.5,     // gentle growth: 0.5→0.75→1.1→1.7→2.5s…
        fuzzFactor: 0.5,        // ±50% jitter to avoid thundering herd
        timeout: 20000,         // 20s per-attempt ceiling
        stallTimeout: 3000,     // 3s of no bytes → retry
        connectionTimeout: 5000, // 5s to open a new TCP+TLS connection
      };
      player.configure('streaming.retryParameters', retryParams);
      player.configure('manifest.retryParameters', retryParams);

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
      //
      // Shaka error code 1001 = BAD_HTTP_STATUS; data layout is
      // [url, status, responseText, headers, method]. We only tear the
      // player down when the missing resource is a manifest (.m3u8/.mpd)
      // or init segment (.mp4) — those mean the whole video is gone. A
      // 404 on an individual .m4s media segment is treated as a transient
      // network condition: Shaka's networking engine will retry per its
      // streaming.retryParameters, and a permanent loss stalls playback
      // at that point rather than killing the session entirely.
      function handleShakaError(err) {
        if (err && err.code === 1001 && err.data && err.data[1] === 404) {
          if (isManifestOrInitUrl(err.data[0])) {
            destroyAndShowError('Video Unavailable', 'This video is no longer available.');
          } else {
            console.warn('Media segment 404, deferring to Shaka retry:', err.data[0]);
          }
          return;
        }
        console.error('Player error:', err);
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

            fetch('/api/watch-progress', {
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

          // Beacon-based flush for page-going-away cases (tab close, full
          // reload, client-side route nav). Uses sendBeacon so the request
          // survives even after the JS context is torn down — a regular
          // fetch would be cancelled when the page unloads.
          //
          // Suppressed when:
          //   - tracking is stopped (401/403/429 already terminated us), or
          //   - the user just clicked Sign Out (cookie's about to die — the
          //     server would 401 the report anyway), or
          //   - there's no accumulated time to credit (sendBeacon costs the
          //     server a parsed request — skip the no-op).
          //
          // Zeroes accumulated up-front like flushNow does. No rollback path:
          // sendBeacon delivery is best-effort and we don't get a response
          // status, so any failure is silently lost (acceptable — this only
          // fires on terminal navigation, no future flush would retry anyway).
          flushBeacon = function () {
            if (t.stopped || destroyedRef.current || isSigningOut()) return;
            const delta = Math.max(0, t.accumulated);
            if (delta <= 0) return;
            t.accumulated = 0;
            const pos = videoEl.currentTime;
            const body = JSON.stringify({
              video_id: parseInt(videoId),
              position: pos,
              delta,
            });
            try {
              const blob = new Blob([body], { type: 'application/json' });
              if (navigator.sendBeacon && navigator.sendBeacon('/api/watch-progress', blob)) {
                return;
              }
            } catch {}
            // sendBeacon unavailable, threw, or refused (queue full / payload
            // too large) — fall back to keepalive fetch so the request still
            // outlives the page. Errors swallowed: nothing useful to do here.
            try {
              fetch('/api/watch-progress', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
                keepalive: true,
              }).catch(() => {});
            } catch {}
          };

          // pagehide fires for tab close, window close, full-page nav
          // (window.location.href), and bfcache transitions. More reliable
          // than beforeunload across browsers, especially on mobile Safari.
          pagehideHandler = flushBeacon;
          window.addEventListener('pagehide', pagehideHandler);

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
      // Last-chance flush for client-side route nav (header site title,
      // username link, sidebar links, programmatic Navigate). Page stays
      // alive after unmount, but we still use the beacon path because the
      // tracking state is captured in this effect's closure — once cleanup
      // returns it's gone, and the response status wouldn't be actionable
      // (we're navigating away). Must run BEFORE destroyedRef is flipped
      // since flushBeacon short-circuits on it. No-op if Sign Out fired
      // (isSigningOut latched) or tracking already terminated (t.stopped).
      try { flushBeacon?.(); } catch {}
      destroyedRef.current = true;
      if (refreshIntervalId) clearInterval(refreshIntervalId);
      if (tickIntervalId) clearInterval(tickIntervalId);
      if (refreshPlayHandler) videoEl.removeEventListener('play', refreshPlayHandler);
      if (refreshVisHandler) document.removeEventListener('visibilitychange', refreshVisHandler);
      if (tickVisHandler) document.removeEventListener('visibilitychange', tickVisHandler);
      if (pauseHandler) videoEl.removeEventListener('pause', pauseHandler);
      if (pagehideHandler) window.removeEventListener('pagehide', pagehideHandler);
      if (metadataHandler) videoEl.removeEventListener('loadedmetadata', metadataHandler);
      // Clear the inline aspect-ratio override so the next mount starts fresh
      // from the 16:9 CSS placeholder (avoids carrying the previous video's
      // aspect into the new video's initial render).
      if (containerRef.current) containerRef.current.style.aspectRatio = '';
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

  // Media Session metadata — drives iOS Control Center / Dynamic Island,
  // Android notification shade, and any connected Bluetooth display. Shaka
  // doesn't populate this on its own, so we set it explicitly once we have
  // the video metadata and (optionally) a signed poster URL.
  //
  // artwork is omitted when the video lacks a poster; iOS falls back to a
  // generic icon in that case. The poster URL uses the per-file HMAC token
  // — same secret as playback, separate signature scope (handled by the
  // OR branch in the Cloudflare WAF rule).
  //
  // Cleanup clears metadata on unmount so navigating away doesn't leave
  // the previous video lingering in Control Center.
  useEffect(() => {
    if (!data || !data.video) return;
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const { video, posterToken, r2PublicDomain } = data;
    const artwork = [];
    // Path is `/posters/{course_id}/{video_id}.jpg` — matches what the
    // server signs the token against. Server no longer ships posterPath
    // since the client has both ids on hand.
    if (posterToken && r2PublicDomain && video.course_id && video.video_id) {
      artwork.push({
        src: `https://${r2PublicDomain}/posters/${video.course_id}/${video.video_id}.jpg?verify=${posterToken}`,
        sizes: '640x360',
        type: 'image/jpeg',
      });
    }
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: video.title || '',
        artist: video.course_name || '',
        album: video.week ? `Week ${video.week}` : '',
        artwork,
      });
    } catch {
      // MediaMetadata may not exist on older browsers — gracefully skip.
    }
    return () => {
      try { navigator.mediaSession.metadata = null; } catch {}
    };
  }, [data]);

  // Media Session action handlers + position state. These are what make
  // the lock-screen / Control Center / Dynamic Island / Android
  // notification controls actually do something:
  //
  //   - play / pause    : the obvious buttons.
  //   - seekto          : the scrubber on the lock screen (iOS) and the
  //                       progress bar on Android's media notification.
  //   - seekforward /   : the skip-±10s buttons (or ±15s, or whatever
  //     seekbackward      the OS surfaces). Spec says we honour the
  //                       seekOffset the OS passes; we default to 10 s
  //                       if it's missing (per the MDN reference impl).
  //
  // setPositionState drives the elapsed-time / progress display. It has
  // to be refreshed on every playback transition (play, pause, seek,
  // ratechange, loadedmetadata) — otherwise the OS scrubber drifts away
  // from the real currentTime. We avoid touching it until duration is
  // a finite positive number; for VOD that's settled by the time
  // loadedmetadata fires, but Shaka can momentarily report Infinity
  // while it's switching periods.
  //
  // setActionHandler with `null` removes the handler; we do that on
  // cleanup so navigating away doesn't leave the previous video's
  // play/pause wired to a stale ref.
  useEffect(() => {
    if (!data || !data.video) return;
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const v = videoRef.current;
    if (!v) return;
    const ms = navigator.mediaSession;

    const updatePosition = () => {
      try {
        if ('setPositionState' in ms
            && typeof v.duration === 'number'
            && isFinite(v.duration)
            && v.duration > 0) {
          ms.setPositionState({
            duration: v.duration,
            playbackRate: v.playbackRate || 1,
            position: Math.min(Math.max(v.currentTime || 0, 0), v.duration),
          });
        }
      } catch {
        // Some Chromium builds throw if position state is set too
        // aggressively (rate limit). Silently swallow — the next
        // event will retry.
      }
    };

    const setHandler = (action, handler) => {
      try { ms.setActionHandler(action, handler); } catch {}
    };

    setHandler('play', () => {
      // play() returns a promise that can reject if the browser blocks
      // playback (autoplay policy mid-session); ignore the rejection so
      // the OS button just no-ops instead of throwing.
      const p = v.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    });
    setHandler('pause', () => v.pause());
    setHandler('seekto', (details) => {
      if (!details || typeof details.seekTime !== 'number') return;
      if (details.fastSeek && typeof v.fastSeek === 'function') {
        v.fastSeek(details.seekTime);
      } else {
        v.currentTime = details.seekTime;
      }
      updatePosition();
    });
    setHandler('seekforward', (details) => {
      const off = (details && details.seekOffset) || 10;
      const target = Math.min((v.currentTime || 0) + off, v.duration || Infinity);
      v.currentTime = target;
      updatePosition();
    });
    setHandler('seekbackward', (details) => {
      const off = (details && details.seekOffset) || 10;
      v.currentTime = Math.max((v.currentTime || 0) - off, 0);
      updatePosition();
    });

    // Position state events. timeupdate fires ~4x/sec during playback;
    // setPositionState rate-limits internally on Chrome, so the
    // overhead is negligible.
    v.addEventListener('play', updatePosition);
    v.addEventListener('pause', updatePosition);
    v.addEventListener('seeked', updatePosition);
    v.addEventListener('ratechange', updatePosition);
    v.addEventListener('loadedmetadata', updatePosition);
    v.addEventListener('timeupdate', updatePosition);

    return () => {
      v.removeEventListener('play', updatePosition);
      v.removeEventListener('pause', updatePosition);
      v.removeEventListener('seeked', updatePosition);
      v.removeEventListener('ratechange', updatePosition);
      v.removeEventListener('loadedmetadata', updatePosition);
      v.removeEventListener('timeupdate', updatePosition);
      setHandler('play', null);
      setHandler('pause', null);
      setHandler('seekto', null);
      setHandler('seekforward', null);
      setHandler('seekbackward', null);
    };
  }, [data]);

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
          {/* `playsInline` is the iOS Safari kill switch for background
              audio: without it, locking the screen or app-switching
              hard-pauses the <video> the moment the document hides.
              `autoPlay` only fires on mobile when the video is muted, but
              the attribute is still useful for desktop and for the first
              play-after-user-tap on mobile (the tap counts as the user
              gesture that authorizes subsequent programmatic playback). */}
          <video ref={videoRef} id="video-element" autoPlay playsInline />
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
          {video.description && (
            <p className="mt-2" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {video.description}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
