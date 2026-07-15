// A course's per-item numbering term. Stored lowercase ('week', 'chapter', …)
// and shown capitalized next to each item's number (e.g. "Week 3"). Null or
// unknown falls back to the generic "Module".
export function moduleTerm(label) {
  if (!label || typeof label !== 'string') return 'Module';
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// The curated set offered in the admin Add/Edit course forms. Kept in sync with
// the server allowlist in routes/api/admin.js.
export const MODULE_LABELS = ['week', 'chapter', 'module', 'unit', 'lesson', 'section', 'part', 'topic'];
