// Human-readable labels + grouping for the raw permission keys
// (services/permissionConstants.js). videosite stores only the keys; this map
// lives on the client so the admin UI can read as sentences grouped by area.
// Any key not covered here falls back to its raw form under "Other" — so a new
// server permission still renders, just unlabelled, until it's added here.

export const PERMISSION_LABELS = {
  allowPlayback: 'Watch videos',
  allCourseAccess: 'Access all courses',
  manageCourse: 'Open the courses admin',
  addCourse: 'Add courses',
  changeCourse: 'Edit courses',
  deleteCourse: 'Delete courses',
  manageEnrolment: 'Manage enrollment',
  uploadVideo: 'Upload videos',
  changeVideo: 'Edit videos',
  deleteVideo: 'Delete videos',
  accessAttachments: 'View materials',
  uploadAttachments: 'Upload materials',
  deleteAttachments: 'Delete materials',
  manageUser: 'Open the users admin',
  changeUser: 'Edit users',
  changeUserPermission: 'Change user permissions',
  manageRoles: 'Manage roles',
  viewPlaybackStat: 'View playback stats',
  manageSite: 'Site settings',
};

// Display order + section grouping. Keys not listed here are appended under
// "Other" by permissionGroups() so nothing is silently dropped.
const GROUPS = [
  { group: 'Playback', keys: ['allowPlayback'] },
  { group: 'Courses', keys: ['manageCourse', 'addCourse', 'changeCourse', 'deleteCourse', 'allCourseAccess'] },
  { group: 'Enrollment', keys: ['manageEnrolment'] },
  { group: 'Videos', keys: ['uploadVideo', 'changeVideo', 'deleteVideo'] },
  { group: 'Materials', keys: ['accessAttachments', 'uploadAttachments', 'deleteAttachments'] },
  { group: 'Users and roles', keys: ['manageUser', 'changeUser', 'changeUserPermission', 'manageRoles'] },
  { group: 'Analytics', keys: ['viewPlaybackStat'] },
  { group: 'Site', keys: ['manageSite'] },
];

export function permissionLabel(key) {
  return PERMISSION_LABELS[key] || key;
}

// missing = [[...alts], ...] from prereqViolations(). Renders a human reason
// using the raw permission KEYS in [brackets] (they match the mono key shown
// under each row), e.g. "Requires [manageCourse] or [manageUser]" (AND across
// groups, "or" within a group).
export function prereqReason(missing) {
  if (!missing || !missing.length) return '';
  const groups = missing.map((g) => g.map((k) => `[${k}]`).join(' or '));
  return 'Requires ' + groups.join(' and ');
}

// Given the API's flat `allPermissions` array, return grouped, ordered sections
// containing only keys the server actually sent. Unknown keys go under "Other".
export function permissionGroups(allPermissions) {
  const present = new Set(allPermissions || []);
  const used = new Set();
  const out = [];
  for (const { group, keys } of GROUPS) {
    const inGroup = keys.filter((k) => present.has(k));
    inGroup.forEach((k) => used.add(k));
    if (inGroup.length) out.push({ group, keys: inGroup });
  }
  const leftovers = (allPermissions || []).filter((k) => !used.has(k));
  if (leftovers.length) out.push({ group: 'Other', keys: leftovers });
  return out;
}
