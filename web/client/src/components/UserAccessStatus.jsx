const STATES = {
  active: { label: 'Active', tone: null },
  no_access: { label: 'No access', tone: 'n' },
  disabled: { label: 'Disabled', tone: 'f' },
  locked: { label: 'Locked', tone: 'p' },
  deleted: { label: 'Deleted', tone: 'n' },
  pending: { label: 'Pending update', tone: 'p' },
  unknown: { label: 'Unknown', tone: 'n' },
};

export default function UserAccessStatus({ status, hideActive = false }) {
  const value = Object.hasOwn(STATES, status) ? STATES[status] : STATES.unknown;
  if (status === 'active' && hideActive) return null;
  return value.tone
    ? <span className={`vs-cv-stb vs-cv-stb-${value.tone}`}>{value.label}</span>
    : <span>{value.label}</span>;
}
