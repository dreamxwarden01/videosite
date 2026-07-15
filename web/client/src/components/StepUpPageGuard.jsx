// The blocking "verify to continue" card shown when a read-gated (scope:'RW') admin
// page's load returns 403 step_up_required. Mirrors the CourseView .vs-cv-gone
// empty-state card. The Verify button re-opens the challenge modal (useStepupGuard's
// `verify`); the redirect ceremony then reloads the page with a fresh window.
const ShieldIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    <rect x="9.5" y="11.5" width="5" height="4" rx="1" stroke="currentColor" strokeWidth="1.6" />
    <path d="M10.5 11.5v-1a1.5 1.5 0 0 1 3 0v1" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

export default function StepUpPageGuard({ blocked, onVerify, children }) {
  if (!blocked) return children;
  return (
    <div className="vs-cv-gone">
      <div className="vs-cv-gone-ico"><ShieldIcon /></div>
      <h2>Verify to continue</h2>
      <p>This page needs a fresh identity check before you can view it.</p>
      <button type="button" className="vs-btn vs-btn-primary" onClick={onVerify}>Verify</button>
    </div>
  );
}
