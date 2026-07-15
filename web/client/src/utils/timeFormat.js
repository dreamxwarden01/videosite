// Time formatting for playback stats (course modal + edit-user section).
// The server stores UTC; the browser converts to the viewer's local zone.

// Accumulated watch time. Drops a zero smaller unit and never zero-pads it:
//   44m 00s → "44m", 3h 00m → "3h", 45m 05s → "45m 5s", 8s → "8s".
// Videos here run 2-3h, so at the hour scale we show h + m (no seconds).
export function fmtWatch(seconds) {
  const s = Math.round(Number(seconds) || 0);
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const x = s % 60;
    return x === 0 ? `${m}m` : `${m}m ${x}s`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// Clock time for durations + resume positions: hh:mm:ss over an hour, else
// mm:ss. Always zero-padded (it reads as a timestamp, not a quantity).
export function fmtClock(seconds) {
  const s = Math.round(Number(seconds) || 0);
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const x = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(x)}` : `${m}:${pad(x)}`;
}

// Relative "last watched": "just now" (<1 min), then min / hr / days ago.
export function relTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const sec = Math.max(0, (Date.now() - then) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} hr ago`;
  const days = Math.floor(sec / 86400);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// Exact local timestamp for the tooltip: "2026/07/11 10:37:06 PM PDT".
// timeZoneName 'short' yields the abbreviation, or "GMT+8" when none exists.
export function exactTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: true, timeZoneName: 'short',
    }).formatToParts(d);
    const o = {};
    for (const p of parts) o[p.type] = p.value;
    return `${o.year}/${o.month}/${o.day} ${o.hour}:${o.minute}:${o.second} ${o.dayPeriod} ${o.timeZoneName}`;
  } catch {
    return d.toString();
  }
}
