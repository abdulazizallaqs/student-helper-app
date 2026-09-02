import User from '../models/User.js';
import Admin from '../models/Admin.js';
import { AppError } from '../middleware/errorHandler.js';
import { USER_HOME } from '../config/appRoutes.js';

const GENERIC_LOGIN_ERROR = '/login?error=The%20username%20or%20password%20is%20incorrect.';

/**
 * Start a brand-new session for a freshly authenticated identity.
 *
 * WHY: the old code assigned `req.session.user = {...}` onto whatever session
 * the visitor already had. Two problems with that:
 *
 *  1. SESSION FIXATION. An attacker who can get a victim to load the site
 *     with a session id they chose (a link, a shared machine, an XSS that
 *     writes the cookie) keeps that same id after the victim logs in - and is
 *     then logged in as the victim. Regenerating means the id the attacker
 *     knows is never the id the account ends up on.
 *  2. MIXED IDENTITIES. Logging in as an admin on a browser that still had a
 *     user session left BOTH `session.user` and `session.admin` populated, so
 *     the same request satisfied both the user guards and the admin guards at
 *     once. Regenerating guarantees exactly one identity per session.
 *
 * `identity` also records the role and the login time, so every downstream
 * request can answer "who is acting here", not just "is someone logged in".
 */
function startSession(req, kind, identity) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session[kind] = { ...identity, role: kind, loginAt: new Date().toISOString() };
      req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
    });
  });
}

export { startSession };

const authController = {
    /**
     * Handle login for both regular users and admins through the single
     * shared login form. Tries the Users table first; if the username isn't
     * a regular user, falls back to the Admin table. Either way the same
     * generic error message/redirect is used on failure so the response
     * never reveals which table (if either) the username matched.
     */
    login: async (req, res, next) => {
        try {
            const { username, password } = req.body;

            const user = await User.findByUsername(username);
            if (user) {
                // userId is passed so that a legacy plain-text row is upgraded
                // to a bcrypt hash during this login instead of staying plain.
                const isMatch = await User.verifyPassword(password, user.password, user.userId);
                if (!isMatch) {
                    return res.redirect(GENERIC_LOGIN_ERROR);
                }
                await startSession(req, 'user', { id: user.userId, username: user.username });
                return res.redirect(USER_HOME);
            }

            const admin = await Admin.findByUsername(username);
            if (admin) {
                const isMatch = await Admin.verifyPassword(admin, password);
                if (isMatch) {
                    await startSession(req, 'admin', { id: admin.adminId, username: admin.username });
                    return res.redirect('/admin-dashboard');
                }
            }

            return res.redirect(GENERIC_LOGIN_ERROR);
        } catch (error) {
            next(new AppError(error.message, 500));
        }
    },

    /**
     * Handle user registration
     */
    register: async (req, res, next) => {
        try {
            const { name, username, email, password } = req.body;

            // Create user
            await User.create({ name, username, email, password });

            // Success
            res.send(`
        <script>
          alert('Account created successfully! Please login.');
          window.location.href = '/login';
        </script>
      `);
        } catch (error) {
            // Handle duplicate entry
            if (error.message.includes('already exists')) {
                return res.send(`
          <script>
            alert('Username or email already exists!');
            window.location.href = '/create-account';
          </script>
        `);
            }

            next(new AppError(error.message, 500));
        }
    },

    /**
     * Change the logged-in user's own password.
     *
     * The app previously had no way at all for a user to change their
     * password - the profile page showed a password box and a "Change" button
     * that were wired to nothing. That matters beyond convenience: if someone
     * suspects their account is compromised, or the admin-seeded default is
     * still in place, there was no route to fix it.
     *
     * The current password is required. Without that check, any XSS or
     * borrowed/unlocked browser session could silently take permanent
     * ownership of an account by setting a new password.
     */
    changePassword: async (req, res, next) => {
        try {
            const userId = req.session.user?.id;
            if (!userId) {
                return res.status(401).json({ success: false, message: 'Unauthorized' });
            }

            const { currentPassword, newPassword } = req.body;

            const user = await User.findById(userId);
            if (!user) {
                return res.status(404).json({ success: false, message: 'Account not found.' });
            }

            const isMatch = await User.verifyPassword(currentPassword, user.password, user.userId);
            if (!isMatch) {
                return res.status(403).json({
                    success: false,
                    message: 'Your current password is not correct.'
                });
            }

            if (currentPassword === newPassword) {
                return res.status(400).json({
                    success: false,
                    message: 'Your new password must be different from the current one.'
                });
            }

            await User.updatePassword(userId, newPassword);

            // Re-issue the session so any other device holding the old session
            // is logged out - standard practice after a credential change.
            req.session.regenerate((err) => {
                if (err) {
                    console.error('Error regenerating session after password change:', err);
                    return res.status(500).json({
                        success: false,
                        message: 'Password changed, but please log in again.'
                    });
                }
                req.session.user = { id: user.userId, username: user.username };
                res.json({ success: true, message: 'Password changed successfully.' });
            });
        } catch (error) {
            next(new AppError(error.message, 500));
        }
    },

    /**
     * Let a user permanently delete their own account.
     *
     * Only an admin could remove an account before, which is a poor position
     * to be in for anything holding student data - people are entitled to
     * leave. The password is required so a walk-up attacker on an unlocked
     * machine cannot destroy someone's work. Files, comments, favourites and
     * messages are removed with the account by the ON DELETE CASCADE foreign
     * keys already defined in the schema.
     */
    deleteOwnAccount: async (req, res, next) => {
        try {
            const userId = req.session.user?.id;
            if (!userId) {
                return res.status(401).json({ success: false, message: 'Unauthorized' });
            }

            const { password } = req.body;

            const user = await User.findById(userId);
            if (!user) {
                return res.status(404).json({ success: false, message: 'Account not found.' });
            }

            const isMatch = await User.verifyPassword(password, user.password, user.userId);
            if (!isMatch) {
                return res.status(403).json({
                    success: false,
                    message: 'Password is not correct - account was NOT deleted.'
                });
            }

            await User.delete(userId);

            req.session.destroy((err) => {
                if (err) console.error('Error destroying session after account deletion:', err);
                res.clearCookie('connect.sid');
                res.json({ success: true, message: 'Your account and all its data have been deleted.' });
            });
        } catch (error) {
            next(new AppError(error.message, 500));
        }
    },

    /**
     * Return the current session's identity (regular user or admin) as JSON,
     * for pages that need to know "who am I" - e.g. the chat UI, so it can
     * tell its own messages apart from the other user's contact list.
     */
    getCurrentUser: (req, res) => {
        if (req.session?.user?.username) {
            return res.json({
                role: 'user',
                id: req.session.user.id,
                username: req.session.user.username,
                loginAt: req.session.user.loginAt ?? null
            });
        }
        if (req.session?.admin?.username) {
            return res.json({
                role: 'admin',
                id: req.session.admin.id,
                username: req.session.admin.username,
                loginAt: req.session.admin.loginAt ?? null
            });
        }
        return res.status(401).json({ error: 'Unauthorized' });
    },

    /**
     * Handle logout (shared by user and admin sessions)
     */
    logout: (req, res) => {
        req.session.destroy((err) => {
            if (err) {
                console.error('Error destroying session:', err);
            }
            // Without this the (now dead) session cookie stays in the browser
            // and every later request still carries it around.
            res.clearCookie('connect.sid');

            // The logout control in the navbar is a fetch() POST, so answer
            // JSON when the caller asked for it and redirect for plain links.
            if (req.accepts(['html', 'json']) === 'json') {
                return res.json({ success: true, redirect: '/login' });
            }
            res.redirect('/login');
        });
    }
};

export default authController;
