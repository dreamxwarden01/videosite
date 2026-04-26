// Single source of truth for the permission key list. Lives in its own file
// so both permissionService (DB writes / mutations) and permissionCache
// (Redis reads / invalidation) can import without a circular dependency.

const ALL_PERMISSIONS = [
    'allowPlayback',
    'changeOwnPassword',
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
    'addUser',
    'changeUser',
    'deleteUser',
    'viewPlaybackStat',
    'clearPlaybackStat',
    'changeUserPermission',
    'manageSite',
    'manageRoles',
    'inviteUser',
    'requireMFA',
    'manageSiteMFA',
    'accessAttachments',
    'uploadAttachments',
    'deleteAttachments',
];

module.exports = { ALL_PERMISSIONS };
