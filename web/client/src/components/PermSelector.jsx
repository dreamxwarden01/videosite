// A sliding segmented selector. Used for the role Grant/Deny (2-state) and the
// edit-user Inherit/Grant/Deny override (3-state). The active highlight is one
// indicator that slides between segments (via CSS translate on --i).
//
//   value        : the currently-selected option value
//   options      : [{ value, label, tone? }]  tone ∈ grant | deny | inherit
//   onChange     : (value) => void
//   disabled     : whole control read-only (admin can't edit this key)
//   lockedValues : Set of option values that are individually disabled — e.g.
//                  "Deny" on a permission other perms still depend on
//   invalid      : the current value violates a prerequisite (red ring)
export default function PermSelector({ value, options, onChange, disabled, lockedValues, invalid }) {
  const activeIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const locked = lockedValues || EMPTY;
  return (
    <div
      className={'vs-seg2' + (disabled ? ' disabled' : '') + (invalid ? ' invalid' : '')}
      style={{ '--n': options.length, '--i': activeIndex }}
    >
      <div className="vs-seg2-ind" aria-hidden="true" />
      {options.map((o) => {
        const isOn = o.value === value;
        const isLocked = !isOn && locked.has(o.value);
        return (
          <button
            key={o.value}
            type="button"
            className={'vs-seg2-btn' + (isOn ? ' on tone-' + (o.tone || 'inherit') : '')}
            disabled={disabled || isLocked}
            title={isLocked ? 'Other permissions depend on this one' : undefined}
            onClick={() => { if (!disabled && !isLocked && o.value !== value) onChange(o.value); }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const EMPTY = new Set();
