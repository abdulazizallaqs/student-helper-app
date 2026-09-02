import { Router } from 'express';
import authController, { startSession } from '../controllers/authController.js';
import { validateLogin } from '../middleware/validation.js';
import { authLimiter } from '../middleware/rateLimiters.js';
import passport, { isGoogleAuthConfigured } from '../config/googleAuth.js';
import { USER_HOME } from '../config/appRoutes.js';

const router = Router();

// Public landing/splash page.
router.get('/', (req, res) => {
  if (req.session?.user?.username) {
    return res.redirect(USER_HOME);
  }
  res.sendFile(process.cwd() + '/public/views/splash.html');
});

// Login - delegate to controller
router.post('/', authLimiter, validateLogin, authController.login);

// Current session identity (JSON) - used by pages like chat.html that need
// to know "who am I" client-side.
router.get('/api/session/me', authController.getCurrentUser);

// Which sign-in methods this deployment actually offers.
//
// The login page used to show "Sign in with Google" unconditionally. With no
// GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET in .env the button is live but leads
// straight to an error page, which reads as a broken app rather than as a
// feature that was never configured. The page asks this endpoint and hides
// the button when the answer is no.
router.get('/api/auth/providers', (req, res) => {
  res.json({ password: true, google: isGoogleAuthConfigured });
});

// --- Google sign-in --------------------------------------------------------
// Redirect-based OAuth handshake (session: false - passport never touches
// req.session here); the callback below sets req.session.user itself, the
// same shape every other login path uses.
const NOT_CONFIGURED_ERROR = '/login?error=' + encodeURIComponent('Google sign-in is not set up yet.');
const GOOGLE_FAILED_ERROR = '/login?error=' + encodeURIComponent('Google sign-in failed. Please try again or use your username and password.');

const LOGIN_EXPIRED_ERROR = '/login?error=' + encodeURIComponent('That sign-in link expired or was not started here. Please try again.');

// The CSRF state parameter is configured on the strategy itself
// (config/googleAuth.js) - passport-oauth2 only builds its state store in the
// constructor, so setting it here would silently do nothing.
const GOOGLE_OPTIONS = { scope: ['profile', 'email'], session: false };

router.get('/auth/google', (req, res, next) => {
  if (!isGoogleAuthConfigured) {
    return res.redirect(NOT_CONFIGURED_ERROR);
  }
  passport.authenticate('google', GOOGLE_OPTIONS)(req, res, next);
});

router.get('/auth/google/callback', (req, res, next) => {
  if (!isGoogleAuthConfigured) {
    return res.redirect(NOT_CONFIGURED_ERROR);
  }
  passport.authenticate('google', GOOGLE_OPTIONS, async (err, user, info) => {
    if (err || !user) {
      // A failed state check is not the same thing as Google refusing the
      // account, and telling them apart is the difference between "try again"
      // and half an hour of confusion.
      //
      // Passport reports a state mismatch by FAILING rather than erroring, so
      // the reason arrives in `info`, not in `err` - reading only err.message
      // sent every rejected callback to the generic "sign-in failed" message.
      const message = String(err?.message || info?.message || '');
      if (/state|invalid_grant|unable to verify/i.test(message)) {
        console.warn('Google sign-in rejected a callback whose state did not match this session.');
        return res.redirect(LOGIN_EXPIRED_ERROR);
      }
      if (err) console.error('Google sign-in error:', err);
      return res.redirect(GOOGLE_FAILED_ERROR);
    }
    try {
      // Same fresh-session rule as the password login - see startSession().
      await startSession(req, 'user', { id: user.userId, username: user.username });
    } catch (sessionErr) {
      console.error('Google sign-in session error:', sessionErr);
      return res.redirect(GOOGLE_FAILED_ERROR);
    }
    res.redirect(USER_HOME);
  })(req, res, next);
});

export default router;
