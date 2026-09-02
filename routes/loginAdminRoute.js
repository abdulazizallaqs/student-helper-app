import { Router } from 'express';
import authController from '../controllers/authController.js';

const router = Router();

// Admin login is now unified into the single /login form (see routes/authRoutes.js
// and controllers/authController.js#login). This route is kept only so old links/
// bookmarks to /admin-login don't 404 - it just forwards to the shared login page.
router.get('/admin-login', (req, res) => {
  res.redirect('/login');
});

// Shared logout for both user and admin sessions.
//
// GET keeps existing links (the admin dashboard's "Logout" anchor, old
// bookmarks) working. POST is what the navbar logout button in every main
// page uses - a state-changing action belongs on POST, where the CSRF origin
// check in middleware/csrf.js actually applies and a link prefetch or an
// <img src="/logout"> on another site cannot sign the user out.
router.get('/logout', authController.logout);
router.post('/logout', authController.logout);

export default router;
