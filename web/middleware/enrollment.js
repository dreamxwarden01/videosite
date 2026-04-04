const { getPool } = require('../config/database');

// Check if user has access to a course (via enrollment or allCourseAccess)
// Course ID can come from req.params.courseId or req.body.courseId
async function requireCourseAccess(req, res, next) {
    const user = res.locals.user;
    if (!user) {
        if (req.path.startsWith('/api/') || req.xhr) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        return res.redirect('/login?returnTo=' + encodeURIComponent(req.originalUrl));
    }

    // Users with allCourseAccess skip enrollment check
    if (user.permissions.allCourseAccess) {
        return next();
    }

    const courseId = req.params.courseId || req.body.courseId || req.body.course_id;
    if (!courseId) {
        return res.status(400).json({ error: 'Course ID is required' });
    }

    try {
        const pool = getPool();
        const [rows] = await pool.execute(
            'SELECT 1 FROM enrollments WHERE user_id = ? AND course_id = ?',
            [user.user_id, courseId]
        );

        if (rows.length === 0) {
            if (req.path.startsWith('/api/') || req.xhr) {
                return res.status(403).json({ error: 'You are not enrolled in this course' });
            }
            return res.status(403).render('error', {
                title: 'Access Denied',
                message: 'You are not enrolled in this course.'
            });
        }

        next();
    } catch (err) {
        console.error('Enrollment check error:', err);
        res.status(500).json({ error: 'Failed to verify enrollment' });
    }
}

module.exports = { requireCourseAccess };
