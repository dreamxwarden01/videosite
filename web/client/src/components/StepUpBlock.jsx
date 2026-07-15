// The "verify to continue" reminder, rendered INSIDE a page's own white card
// (replacing the form/list/pagination), not as a separate full-page card. Fills and
// centres in either a flex-row card (flex:1) or a block card (min-height).
const ShieldIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" width="30" height="30">
    <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    <rect x="9.5" y="11.5" width="5" height="4" rx="1" stroke="currentColor" strokeWidth="1.5" />
    <path d="M10.5 11.5v-1a1.5 1.5 0 0 1 3 0v1" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);

export default function StepUpBlock({ onVerify }) {
  return (
    <div className="vs-su-inline">
      <div className="vs-su-inline-ico"><ShieldIcon /></div>
      <h3>Verify to continue</h3>
      <p>This needs a fresh identity check before you can continue.</p>
      <button type="button" className="vs-btn vs-btn-primary" onClick={onVerify}>Verify</button>
    </div>
  );
}

// Loading text shown in the same card slot (no spinner icon).
export function CardLoading() {
  return <div className="vs-card-msg">Loading…</div>;
}
