// Google sign-in, wired into the app's existing session-based auth rather
// than passport's own session system: the OAuth handshake is delegated to
// passport (session: false everywhere), and once Google hands back a
// profile, the callback route sets req.session.user itself - exactly like
// controllers/authController.js#login does for username/password logins.
// This keeps every existing requireSession/requireAdminSession check working
// unchanged for Google-authenticated users too.
//
// Requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (from a Google Cloud
// OAuth 2.0 Client ID, "Web application" type) in .env. Without them, the
// feature quietly disables itself (isGoogleAuthConfigured is false) instead
// of crashing the app - see routes/authRoutes.js.
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import crypto from 'crypto';
import User from '../models/User.js';

const clientID = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
// A relative callback URL only works if passport-google-oauth20 resolves it
// against the request; it doesn't - Google requires an absolute, exact-match
// redirect URI registered in the Cloud Console. Default to localhost for
// local dev; set GOOGLE_CALLBACK_URL explicitly for any deployed environment.
const callbackURL = process.env.GOOGLE_CALLBACK_URL || `http://localhost:${process.env.PORT || 3002}/auth/google/callback`;

// Google's own endpoints, overridable. Two reasons they are not hardcoded:
// the integration test points them at a local stand-in so the whole handshake
// can be exercised without the internet (tests/integration/googleAuth.test.js),
// and a deployment behind a corporate identity proxy can redirect them. Left
// unset - the normal case - passport uses Google's real URLs.
const endpointOverrides = {};
if (process.env.GOOGLE_AUTHORIZATION_URL) endpointOverrides.authorizationURL = process.env.GOOGLE_AUTHORIZATION_URL;
if (process.env.GOOGLE_TOKEN_URL) endpointOverrides.tokenURL = process.env.GOOGLE_TOKEN_URL;
if (process.env.GOOGLE_USERINFO_URL) endpointOverrides.userProfileURL = process.env.GOOGLE_USERINFO_URL;

export const isGoogleAuthConfigured = Boolean(clientID && clientSecret);

/** The exact redirect URI Google must have registered. Used by diagnostics. */
export const googleCallbackURL = callbackURL;

/**
 * Turn a Google display name / email into a URL- and DB-safe username
 * candidate. Uniqueness (via numeric suffixes) is handled by the caller.
 */
function usernameCandidate(profile, email) {
    const source = profile.displayName || (email ? email.split('@')[0] : '') || 'user';
    const cleaned = source.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
    return cleaned || 'user';
}

if (isGoogleAuthConfigured) {
    passport.use(new GoogleStrategy(
        {
            clientID,
            clientSecret,
            callbackURL,
            // state MUST be set HERE, on the strategy, not in the
            // passport.authenticate() call in routes/authRoutes.js.
            //
            // passport-oauth2 builds its state store in the CONSTRUCTOR: with
            // `state: true` it installs a SessionStore that puts a random
            // value in the session before redirecting and checks it on the way
            // back. Pass the same option to authenticate() instead and the
            // store stays the default NullStore, which verifies nothing - the
            // redirect carries no state parameter at all and the callback
            // accepts any code that arrives. Confirmed by test: a callback
            // with no state logged the visitor straight in.
            //
            // What that allows: an attacker begins a Google sign-in for their
            // OWN account, stops before the last step, and sends the victim
            // the resulting callback link. The victim's browser finishes it
            // and the victim is now signed in AS THE ATTACKER, so every note
            // they upload and every message they send lands in an account the
            // attacker controls.
            state: true,
            ...endpointOverrides
        },
        async (accessToken, refreshToken, profile, done) => {
            try {
                const email = profile.emails?.[0]?.value;
                if (!email) {
                    return done(null, false, { message: 'Your Google account has no email address to sign in with.' });
                }

                let user = await User.findByEmail(email);

                if (!user) {
                    const name = (profile.displayName || 'Student').slice(0, 100);
                    const baseUsername = usernameCandidate(profile, email);
                    // Never used to log in with a password - just satisfies the
                    // NOT NULL/UNIQUE-safe column, bcrypt-hashed like any other
                    // password (see User.create).
                    const randomPassword = crypto.randomBytes(24).toString('hex');

                    let username = baseUsername;
                    for (let attempt = 0; attempt <= 5; attempt += 1) {
                        try {
                            user = await User.create({ name, username, email, password: randomPassword });
                            break;
                        } catch (error) {
                            const isLastAttempt = attempt === 5;
                            if (isLastAttempt || !error.message.includes('already exists')) throw error;
                            username = `${baseUsername}${Math.floor(Math.random() * 10000)}`;
                        }
                    }
                }

                return done(null, user);
            } catch (error) {
                return done(error);
            }
        }
    ));
}

export default passport;
