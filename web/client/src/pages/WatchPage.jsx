import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useSite } from '../context/SiteContext';
import { useToast } from '../context/ToastContext';
import { apiGet, apiPost, triggerAuthFailure } from '../api';
import LoadingSpinner from '../components/LoadingSpinner';

export default function WatchPage() {
  const { videoId } = useParams();
  const { siteName } = useSite();
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
        }
      } catch {
        setError('Failed to load video.');
      }
      setLoading(false);
    })();
  }, [videoId, siteName]);

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

    const videoEl = videoRef.current;
    const player = new shaka.Player();
    playerRef.current = player;

    player.attach(videoEl).then(() => {
      const ui = new shaka.ui.Overlay(player, containerRef.current, videoEl);
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

        async function refreshToken() {
          if (refreshing) return;
          refreshing = true;
          for (let attempt = 0; attempt <= 5; attempt++) {
            try {
              if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 1000));
              const resp = await fetch('/api/videos/' + data.video.video_id + '/refresh-token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
              });
              if (resp.ok) {
                const d = await resp.json();
                if (d.token) tokenRef.current = d.token;
                if (d.tokenValiditySeconds > 0) validityRef.current = d.tokenValiditySeconds;
                break;
              }
              if (resp.status === 401) { triggerAuthFailure(); return; }
              if (resp.status === 429) { destroyAndShowError('Too Many Requests', 'You are being rate limited.'); return; }
              if (resp.status === 404) { destroyAndShowError('Video Unavailable', 'This video is no longer available.'); return; }
              if (resp.status === 403) { destroyAndShowError('Access Denied', 'You no longer have permission.'); return; }
            } catch {}
          }
          refreshing = false;
        }

        function checkAndRefresh() {
          if (destroyedRef.current) return;
          if (needsRefresh()) refreshToken();
        }

        const refreshInterval = setInterval(() => {
          if (videoEl.paused || videoEl.ended) return;
          checkAndRefresh();
        }, 60000);

        videoEl.addEventListener('play', checkAndRefresh);
        const visHandler = () => { if (!document.hidden) checkAndRefresh(); };
        document.addEventListener('visibilitychange', visHandler);
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

      // Load manifest
      player.load(data.videoUrl, data.resumePosition > 0 ? data.resumePosition : undefined)
        .then(() => {
          // Start watch tracking
          let lastWall = Date.now();
          let lastPos = videoEl.currentTime;
          let accumulated = 0;
          let stopped = false;

          function tick() {
            if (stopped || destroyedRef.current) return;
            const now = Date.now();
            const pos = videoEl.currentTime;
            const wallDelta = (now - lastWall) / 1000;
            const posMoved = pos !== lastPos;
            lastWall = now;
            lastPos = pos;

            if (!videoEl.paused && !videoEl.ended && posMoved && wallDelta > 0) {
              accumulated += wallDelta;
            }

            while (accumulated >= 10) {
              accumulated -= 10;
              fetch('/api/updatewatch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ video_id: parseInt(videoId), position: pos })
              }).then(resp => {
                if (resp.status === 401) { stopped = true; triggerAuthFailure(); }
                else if (resp.status === 429) { stopped = true; destroyAndShowError('Too Many Requests', 'Rate limited.'); }
                else if (resp.status === 403) { stopped = true; destroyAndShowError('Access Denied', 'Permission revoked.'); }
              }).catch(() => {});
            }
          }

          const trackingInterval = setInterval(tick, 1000);
          const visTrack = () => { if (!document.hidden) tick(); };
          document.addEventListener('visibilitychange', visTrack);
        })
        .catch(handleShakaError);
    });

    return () => {
      destroyedRef.current = true;
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
      </div>
    );
  }

  const { video } = data;
  const backUrl = `/course/${video.course_id}`;

  return (
    <div className="player-container">
      <div className="player-nav-bar">
        <Link to={backUrl} className="player-back-link">
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
