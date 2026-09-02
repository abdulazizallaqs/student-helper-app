// session.js - session cookie configuration.
//
// Hardened for production deployment. Each setting below is deliberate:
//
//  secret            - NO fallback value in production. The old code used
//                      `process.env.SESSION_SECRET || 'fallback_secret_key'`,
//                      which is fine until the source is published: that
//                      literal then becomes a publicly known signing key, and
//                      anyone could forge a session cookie for ANY account
//                      (admin included) on a server where the env var was
//                      missing. It now refuses to boot in production rather
//                      than silently running on a known-bad key.
//  httpOnly          - JavaScript cannot read the cookie, so an XSS bug
//                      cannot simply exfiltrate the session.
//  sameSite: 'lax'   - the browser will not attach this cookie to cross-site
//                      POST/PUT/DELETE requests, which is what stops another
//                      website from performing actions as a logged-in student
//                      (CSRF). 'lax' rather than 'strict' so that following a
//                      normal link into the app - and the Google OAuth
//                      redirect back to /auth/google/callback - still arrives
//                      logged in.
//  secure            - HTTPS-only, enforced in production only: a `secure`
//                      cookie is silently dropped over plain http://localhost,
//                      which would make local development impossible.
//  saveUninitialized - false: don't mint a session for every crawler that
//                      touches the site, only for people who actually log in.
import session from 'express-session';
import dotenv from 'dotenv';

dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';
const secret = process.env.SESSION_SECRET;

if (!secret) {
  if (isProduction) {
    // Fail fast and loudly. Booting without a real secret is worse than not
    // booting at all - every session would be forgeable.
    throw new Error(
      'SESSION_SECRET is not set. Refusing to start in production without it.\n' +
      'Generate one and put it in your .env, for example:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
    );
  }
  console.warn(
    '\n[session] WARNING: SESSION_SECRET is not set - falling back to an ' +
    'insecure development-only key.\n[session] Set SESSION_SECRET in .env ' +
    'before deploying.\n'
  );
}

// A secret that is still the placeholder shipped in the example .env is, in
// practice, a publicly known signing key - anyone who has seen this repo can
// forge a session cookie for any account. Warn loudly rather than pretend it
// counts as configured.
const PLACEHOLDER_SECRETS = new Set([
  'your_super_secret_key_change_this',
  'changeme',
  'secret',
  'password',
]);
if (secret && PLACEHOLDER_SECRETS.has(secret)) {
  const message =
    'SESSION_SECRET is still the example placeholder value. Anyone who has ' +
    'seen this project can forge a session cookie for ANY account, admin ' +
    'included. Replace it with:\n' +
    '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"';
  if (isProduction) throw new Error(message);
  console.warn('\n[session] WARNING: ' + message + '\n');
}

/**
 * Where sessions are kept.
 *
 * The default express-session store is MemoryStore - every session in this
 * process's heap. That is fine for one developer on one laptop and wrong
 * everywhere else:
 *
 *   - restarting the server logs everyone out, and a free host restarts your
 *     container whenever it feels like it (a deploy, an idle timeout, a node
 *     being recycled). Users experience this as being randomly signed out
 *     mid-task, which is indistinguishable from the login being broken.
 *   - nothing is shared between instances, so the moment there is more than
 *     one, half the requests do not recognise the cookie.
 *   - expired sessions are never reaped, so memory grows until it doesn't.
 *
 * The store is the same database the rest of the app uses, so there is no
 * extra service to run, pay for, or configure - and on the free stack
 * (TiDB Cloud) the database is the only durable thing there is.
 *
 * SESSION_STORE=memory forces the old behaviour, which is occasionally useful
 * when the database is down and you just want the pages to render.
 */
const useMemoryStore = /^(memory|none)$/i.test(process.env.SESSION_STORE || '');

let store;
if (!useMemoryStore) {
    try {
        // models/SessionStore.js - written against the app's own pool rather
        // than pulled in as a dependency. express-mysql-session was used here
        // first; its latest release pins a mysql2 with a high severity
        // advisory, and npm would not dedupe it onto the safe version the app
        // already has. Seventy lines against a stable interface is the cheaper
        // side of that trade.
        const { default: DatabaseSessionStore } = await import('../models/SessionStore.js');
        store = new DatabaseSessionStore({ ttlMs: 86400000 });

        store.on('error', (error) => {
            // A store error must not take the process down - the pages that do
            // not need a session should still render.
            console.error('[session] Session store error:', error.message);
        });
    } catch (error) {
        console.error(
            `[session] Could not start the database session store (${error.message}).\n` +
            '[session] Falling back to in-memory sessions: everyone will be signed out\n' +
            '[session] whenever this process restarts.'
        );
        store = undefined;
    }
}

if (!store && isProduction) {
    console.warn(
        '[session] Using the in-memory session store in production: sessions are ' +
        'lost on every restart, and on a host that recycles containers that means ' +
        'users are signed out at random. Set up the database store.'
    );
}

const sessionMiddleware = session({
  ...(store ? { store } : {}),
  secret: secret || 'insecure-development-only-key',
  resave: false,
  saveUninitialized: false,
  // rolling: the 1-day clock restarts on every request, so somebody actively
  // using the app is not signed out mid-task, while an abandoned session on a
  // shared computer still expires a day after it was last touched.
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    maxAge: 86400000 // 1 day
  },
});

/** Which store ended up in use - for diagnostics. */
export const sessionStoreKind = () => (store ? 'database' : 'memory');

export default sessionMiddleware;
