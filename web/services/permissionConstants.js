// Single source of truth for the permission key list. Lives in its own file
// so both permissionService (DB writes / mutations) and permissionCache
// (Redis reads / invalidation) can import without a circular dependency.

// Identity keys (changeOwnPassword, toggleOwnMfa, inviteUser, requireMFA) and
// local account lifecycle keys (addUser, deleteUser) were removed with the
// SSO migration — identity and account creation/removal live at the SSO.
// Stale role_permissions rows for removed keys are filtered out harmlessly
// by permissionCache's ALLOWED_PERMISSION_SET.
const ALL_PERMISSIONS = [
    'allowPlayback',
    'allCourseAccess',
    'manageCourse',
    'addCourse',
    'changeCourse',
    'deleteCourse',
    'manageEnrolment',
    'uploadVideo',
    'changeVideo',
    'deleteVideo',
    'manageUser',
    'changeUser',
    'viewPlaybackStat',
    'changeUserPermission',
    'manageSite',
    'manageRoles',
    'accessAttachments',
    'uploadAttachments',
    'deleteAttachments',
];

// Permission prerequisites (a shallow DAG). Each dependent maps to a list of
// GROUPS; a group is a set of alternatives satisfied by ANY one member (OR
// within a group), and ALL groups must be satisfied (AND across groups). So a
// permission may only be granted when every one of its groups has at least one
// granted member. Enforced on every role/override save (validatePermissionSet)
// and mirrored in the client permission editors.
const PERMISSION_PREREQS = {
    addCourse:            [['allCourseAccess'], ['manageCourse']],
    changeCourse:         [['manageCourse']],
    deleteCourse:         [['manageCourse']],
    uploadVideo:          [['manageCourse']],
    changeVideo:          [['manageCourse']],
    deleteVideo:          [['manageCourse']],
    uploadAttachments:    [['manageCourse'], ['accessAttachments']],
    deleteAttachments:    [['manageCourse'], ['accessAttachments']],
    manageEnrolment:      [['allCourseAccess']],
    viewPlaybackStat:     [['manageCourse', 'manageUser']],
    changeUser:           [['manageUser']],
    changeUserPermission: [['manageUser']],
};

// Given an EFFECTIVE { key: bool } permission map, return prerequisite
// violations: [{ key, missing: [[...alts], ...] }] — one entry per granted
// permission that has ≥1 unsatisfied prerequisite group. Empty array = valid.
// Stateless about how the set was reached, so it catches every path (granted a
// dependent without its prereq, or denied a prereq a dependent still needs).
function validatePermissionSet(effective) {
    const violations = [];
    for (const [key, groups] of Object.entries(PERMISSION_PREREQS)) {
        if (!effective[key]) continue;
        const missing = groups.filter((group) => !group.some((alt) => effective[alt]));
        if (missing.length) violations.push({ key, missing });
    }
    return violations;
}

module.exports = { ALL_PERMISSIONS, PERMISSION_PREREQS, validatePermissionSet };
