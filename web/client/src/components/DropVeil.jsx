const UploadIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5" /><path d="M12 3v13" /></svg>
);
const BlockIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="m5.6 5.6 12.8 12.8" /></svg>
);

/**
 * The full-window drop target that pairs with useFullWindowDrop. The hook owns
 * the listeners; this only paints. `pointer-events: none` on .vs-dropveil keeps
 * the veil from swallowing the drag events the window listeners need to see.
 */
export default function DropVeil({ active, refusing, title, hint }) {
  if (!active) return null;
  return (
    <div className={'vs-dropveil' + (refusing ? ' refuse' : '')}>
      <div className="vs-dropveil-box">
        <div className="vs-dropveil-ico">{refusing ? <BlockIcon /> : <UploadIcon />}</div>
        <p className="vs-dropveil-t">{title}</p>
        <p className="vs-dropveil-h">{hint}</p>
      </div>
    </div>
  );
}
