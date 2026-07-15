import { useState, useEffect } from 'react';

// Initials fallback for the avatar circle (first letter of first + last word).
export function initials(name) {
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Avatar circle for any user (the current user or an arbitrary list row). Renders
// the uploaded image when `user.avatar` is set, otherwise an initials fallback.
// `name` wins as the label; falls back to the user's display_name/username.
//
// The videosite's /api/avatar/:file route only serves the CALLER's own avatar
// (it mirrors just the signed-in user's picture from the SSO). A row for anyone
// else therefore 404s — so we degrade to initials on image error rather than
// showing a broken glyph. The current user's own row still shows their photo.
export default function Avatar({ user, name, className }) {
  const label = name ?? user?.display_name ?? user?.username ?? '';
  const [failed, setFailed] = useState(false);
  // Reset when the underlying file changes (a reused instance across a page flip).
  useEffect(() => { setFailed(false); }, [user?.avatar]);

  if (user?.avatar && !failed) {
    return (
      <img
        className={className}
        src={`/api/avatar/${encodeURIComponent(user.avatar)}`}
        alt=""
        onError={() => setFailed(true)}
      />
    );
  }
  return <div className={className}>{initials(label)}</div>;
}
