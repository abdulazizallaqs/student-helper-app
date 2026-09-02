/**
 * Shared session guard: lets the request through only if a user or admin is logged in.
 * Used to protect routes/static assets that must not be reachable by anonymous visitors -
 * e.g. uploaded files, which used to be served publicly via express.static regardless
 * of login state (anyone who knew/guessed a filename could open it).
 */
export const requireSession = (req, res, next) => {
  if (req.session?.user?.username || req.session?.admin?.username) {
    return next();
  }
  return res.status(401).json({ status: 'fail', message: 'Please log in to access this resource.' });
};

/**
 * Admin-only guard for JSON/API routes (the admin data endpoints in
 * routes/adminRoutes.js). Previously these routes had NO auth check at all -
 * any anonymous visitor could list every user's stats, list every file, or
 * delete any user/file just by knowing the URL. Responds with 401 JSON since
 * these are fetch()-driven endpoints, not page navigations.
 */
export const requireAdminSession = (req, res, next) => {
  if (req.session?.admin?.username) {
    return next();
  }
  return res.status(401).json({ status: 'fail', message: 'Admin login required.' });
};

/**
 * Admin-only guard for page routes (e.g. GET /admin-dashboard). Redirects to
 * the shared login page instead of returning JSON, since this guards a full
 * page navigation rather than a fetch() call.
 */
export const requireAdminPage = (req, res, next) => {
  if (req.session?.admin?.username) {
    return next();
  }
  return res.redirect('/login');
};
