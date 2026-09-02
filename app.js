import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config'; // Load environment variables
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import cors from 'cors';

import passport from 'passport';
import sessionMiddleware from './routes/session.js'; // Import session middleware
import authRoutes from './routes/authRoutes.js';
import accountRoutes from './routes/accountRoutes.js';
import fileRoutes from './routes/fileRoutes.js';
import chatRoutes from './routes/chatRoutes.js';
import favoritRoutes from './routes/favoritRoutes.js';
import loginAdminRoute from './routes/loginAdminRoute.js';
import msgRoute from './routes/messageRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import aiRoutes from './routes/aiRoutes.js';
import aiViewRoute from './routes/aiViewRoute.js';
import legalRoutes from './routes/legalRoutes.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { generalLimiter } from './middleware/rateLimiters.js';
import { requireSession, requireAdminPage } from './middleware/auth.js';
import { csrfProtection } from './middleware/csrf.js';
import { RETIRED_PAGES } from './config/appRoutes.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const isProduction = process.env.NODE_ENV === 'production';

// In production the app sits behind a reverse proxy (nginx, IIS, a cloud load
// balancer) that terminates HTTPS. Without this, Express sees every request as
// plain http: req.protocol is wrong, req.secure is always false, the `secure`
// session cookie is never sent, and the rate limiters see the proxy's IP
// instead of the visitor's - so one abusive client could exhaust the limit for
// everybody.
if (isProduction) {
  app.set('trust proxy', 1);
}

// Force HTTPS in production. Session cookies are marked `secure`, so a plain
// http request would arrive with no session at all; redirecting is clearer
// than silently appearing logged out.
//
// /healthz is exempt, and that exemption is load-bearing. Render, Northflank
// and every other platform terminate TLS at their edge and probe the container
// directly over plain HTTP, with no X-Forwarded-Proto header - so req.secure is
// false and this middleware answered the probe with a 308. The platform wants a
// 200, sees a redirect, decides the app never came up, and either fails the
// deploy or restarts it forever. Nothing in the logs says why, because from the
// app's side nothing is wrong.
//
// The endpoint returns no data worth protecting - uptime and a mode string - so
// answering it over the internal HTTP hop costs nothing.
const HTTPS_EXEMPT = new Set(['/healthz']);

if (isProduction) {
  app.use((req, res, next) => {
    if (req.secure || HTTPS_EXEMPT.has(req.path)) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Don't 301 a POST - the body would be dropped. Tell the caller plainly.
      return res.status(403).json({
        status: 'fail',
        message: 'HTTPS is required for this request.'
      });
    }
    return res.redirect(308, `https://${req.get('host')}${req.originalUrl}`);
  });
}

// Security middleware - Helmet
// Security headers. The app still relies on inline <script> blocks and onclick=""
// handlers in several views, so script-src/style-src allow 'unsafe-inline' for now -
// fully tightening this requires moving those handlers into external files
// (tracked as a follow-up, not done here to avoid breaking every page at once).
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      // object-src / frame-src govern <embed>, <object> and <iframe>. This
      // used to be object-src 'none', which silently blocked the PDF viewer
      // on Display.html - the page loaded, the <embed> stayed blank, and
      // nothing was reported anywhere. Same-origin only, so this still blocks
      // an injected <object> pointing at another site.
      objectSrc: ["'self'"],
      frameSrc: ["'self'", "blob:"],
      frameAncestors: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  // Helmet's default is `no-referrer`, which has a side effect that is easy
  // to miss: with no referrer information allowed, Chrome sends
  // `Origin: null` on ordinary same-origin HTML form submissions. That makes
  // a legitimate login indistinguishable from a cross-site attack, and the
  // CSRF middleware (correctly) rejected it - logging in became impossible in
  // a real browser while every supertest check still passed, because
  // supertest does not implement referrer policy.
  //
  // `same-origin` keeps the privacy property that matters (no referrer is
  // ever sent to another site) while still identifying our own requests to
  // ourselves, so the CSRF origin check works as intended.
  referrerPolicy: { policy: 'same-origin' },
}));

// CORS configuration. '*' combined with credentials:true is an invalid combination
// (browsers reject sending credentials to a wildcard origin), so this was silently
// not doing what it looked like. Default is same-origin only (this app serves its
// own frontend); set CORS_ORIGIN to a comma-separated allowlist if a separate
// frontend or mobile client needs cross-origin access later.
const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins.length > 0 ? allowedOrigins : false,
  credentials: true,
  optionsSuccessStatus: 200
}));

// Compression middleware - Compress all responses
app.use(compression());

// General rate limiting - protects every route from abuse/scraping. This used to be
// entirely commented out ("DISABLED FOR DEVELOPMENT"). Login and AI endpoints layer
// their own stricter limiters on top (see middleware/rateLimiters.js).
app.use(generalLimiter);

// Logging middleware.
//
// `combined` records the IP and the URL but nothing about WHO made the
// request, so the access log could not answer "who deleted this file?" -
// only "someone from this IP did". The session already carries the acting
// identity; this surfaces it in the log as e.g. `user:14/ahmad` or
// `admin:1/admin`, and `-` when nobody is logged in.
//
// It must be registered AFTER the session middleware to see req.session, so
// the app.use(morgan(...)) call itself was moved below it.
morgan.token('actor', (req) => {
  if (req.session?.user?.username) return `user:${req.session.user.id}/${req.session.user.username}`;
  if (req.session?.admin?.username) return `admin:${req.session.admin.id}/${req.session.admin.username}`;
  return '-';
});

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Session has to be parsed before we can gate anything on req.session below.
app.use(sessionMiddleware);

// Access log, with the acting identity attached (see the morgan.token above).
app.use(morgan(
  ':remote-addr :actor ":method :url HTTP/:http-version" :status :res[content-length] :response-time ms'
));

// CSRF: reject state-changing requests that a browser tells us came from
// another site. Sits directly after the session so that a blocked request is
// rejected before any route can act on the logged-in user, and after the body
// parsers so POST bodies are already available to the handlers that survive.
// See middleware/csrf.js for why this is an origin check rather than
// per-form hidden tokens.
app.use(csrfProtection);

/**
 * Health check, for the hosting platform.
 *
 * Render, Northflank and friends poll a URL to decide whether a container came
 * up and whether to keep it in rotation. Pointing them at a real page is
 * tempting and wrong: those pages read the session store and the database, so
 * a slow query makes the platform think the app is dead and restart it - the
 * one thing guaranteed to turn a small problem into an outage.
 *
 * This answers from memory alone: no database, no session, no auth. It says
 * only "the process is up and Express is routing", which is exactly the
 * question a health check is asking.
 */
app.get('/healthz', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    storage: process.env.FILE_STORAGE || 'disk'
  });
});

// Google sign-in (config/googleAuth.js) uses passport only for the OAuth
// handshake (session: false everywhere) - this just wires up req.login/etc.
// that passport.authenticate() needs; no passport.session() is used, since
// the app tracks the logged-in user itself via req.session.user.
app.use(passport.initialize());

// Uploaded files require a logged-in session. This has to run BEFORE the general
// static middleware below (which serves the whole /public folder, including
// /public/uploads) - otherwise that middleware answers first and this check never
// runs. Previously /uploads/<file> was reachable by anyone who knew or guessed a
// filename, with no login check at all.
app.use('/uploads', requireSession);

// Second lock on the same door. The upload filter (routes/fileRoutes.js) now
// rejects anything whose extension is not one of the safe ones, but this path
// hands a stored file straight to express.static, which picks its Content-Type
// from the extension - so one bad file that got in before the filter existed,
// or by any route the filter does not cover, would still be executed by the
// browser as a page on this origin.
//
// Nothing in the UI links to /uploads directly (the viewer reads a file through
// /file-content/:id, which sends its own allowlisted content type), so forcing
// every response here to download rather than render costs nothing and closes
// the category of bug rather than one instance of it.
app.use('/uploads', (req, res, next) => {
  res.setHeader('Content-Disposition', 'attachment');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // An HTML file served from this origin could otherwise script against the
  // session of whoever opened it; a sandboxed CSP makes the response inert
  // even if a browser is somehow persuaded to render it.
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  next();
});

// Same problem, one level up: express.static serves /public, and every view
// lives at /public/views/*.html - so ANY page was reachable by its direct
// static URL regardless of the guards defined further down this file.
// `GET /views/admin-dashboard.html` returned the admin dashboard to an
// anonymous visitor, and `GET /views/ai-buddy.html` likewise, because static
// answered first and app.get('/admin-dashboard', requireAdminPage, ...) below
// never ran. Only these few pages are public; everything else in views/
// requires a session, and the admin dashboard requires an admin session.
const PUBLIC_VIEWS = new Set([
  'splash.html',
  'user-login.html',
  'create-account.html',
  'admin-login-page.html',
  'privacy-policy.html',
  'terms-of-service.html',
]);

app.use('/views', (req, res, next) => {
  // DECODE FIRST. express.static decodes the URL before it looks for the file,
  // so comparing the raw path here compared a different string than the one
  // that actually gets served: `/views/admin%2Ddashboard.html` did not match
  // the literal 'admin-dashboard.html', fell through as an ordinary page, and
  // express.static then decoded it and handed the admin dashboard to any
  // logged-in student. A malformed escape is rejected outright rather than
  // guessed at.
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(req.path);
  } catch {
    return res.status(400).send('Bad request');
  }

  // A backslash is a path separator on Windows, so basename() would keep it
  // as part of the name here while the filesystem would not.
  const page = path.basename(decodedPath.replace(/\\/g, '/'));

  // A page that has been removed keeps answering, as a redirect. Bookmarks,
  // open tabs and phone home-screen shortcuts all still point at
  // User-Dashboard.html; sending them to the page that replaced it is kinder
  // than a 404, and stops "the app is broken" reports after a rename. A plain
  // 302 rather than a 301: browsers cache a permanent redirect hard, and that
  // is a painful thing to undo if the page ever comes back.
  const replacement = RETIRED_PAGES[`/views/${page}`];
  if (replacement) {
    return res.redirect(replacement);
  }

  // Non-HTML assets under /views (if any) and public pages pass straight through.
  if (!page.endsWith('.html') || PUBLIC_VIEWS.has(page)) {
    return next();
  }

  if (page === 'admin-dashboard.html') {
    return requireAdminPage(req, res, next);
  }

  if (req.session?.user?.username || req.session?.admin?.username) {
    return next();
  }

  return res.redirect('/login');
});

app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  // console.log('Session Middleware:', req.session); // Log session for every request
  next();
});


// Routes
app.use('/', authRoutes);
app.use('/', accountRoutes);
app.use('/', fileRoutes);
app.use('/', chatRoutes);
app.use('/', favoritRoutes);
app.use('/', loginAdminRoute);
app.use('/', msgRoute);
app.use('/', adminRoutes);
app.use('/', aiRoutes);
app.use('/', aiViewRoute);
app.use('/', legalRoutes);

// Login route
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'views', 'user-login.html'));
});

app.use((req, res, next) => {
  if (req.session?.user?.username || req.session?.admin?.username) {
    // console.log('Session is valid for user:', req.session.user);
    next();
  } else {
    // console.log('No valid session. Redirecting to login.');
    // Only redirect if trying to access protected routes, not static files or login
    // /search-files used to be on this list. It is not public any more: it
    // reads the whole library and, since search became semantic, every unique
    // query costs a Gemini embedding call. Anonymous access to it meant
    // anonymous access to both.
    if (req.path === '/' || req.path === '/login' || req.path === '/create-account' || req.path.startsWith('/public') || req.path === '/admin-login' || req.path === '/privacy-policy' || req.path === '/terms-of-service') {
      return next();
    }
    res.redirect('/login'); // Redirect to login page
  }
});


// Add-file route
app.get('/add-file', (req, res) => {
  if (req.session.user && req.session.user.username) {
    res.sendFile(path.join(__dirname, 'public', 'views', 'add-file.html'));
  } else {
    res.redirect('/login');
  }
});

////////sending to show...html<>
app.get('/views/file-page-myfile.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'views', 'file-page-myfile.html'));
});

app.get('/views/favorite.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'views', 'favorite.html'));
});


// Admin dashboard (protected route - requires an authenticated admin session)
app.get('/admin-dashboard', requireAdminPage, (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public/views/admin-dashboard.html'));
});

app.get('/chat', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public/views/chat.html'));
});

app.get('/profile', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public/views/profile.html'));
});


// Handle 404 - Route not found
app.use(notFoundHandler);

// Global error handler (must be last)
app.use(errorHandler);


const PORT = process.env.PORT || 3002;

// The test suite imports this module and wraps `app` with supertest directly -
// it does not need (and must not trigger) a real listening server, which would
// fight the test runner for the port and never shut down cleanly.
/**
 * Warn loudly at boot about settings that are fine locally but dangerous once
 * the app is reachable from the internet. Printed rather than fatal (except
 * SESSION_SECRET, which routes/session.js already refuses to start without),
 * so a misconfigured production box is noisy instead of quietly insecure.
 */
async function warnAboutInsecureDefaults() {
  const warnings = [];

  if (isProduction && !process.env.SESSION_SECRET) {
    warnings.push('SESSION_SECRET is not set.');
  }

  // The seeded admin/admin login is the first thing anyone tries on a public
  // site. Admin.verifyPassword upgrades it to a hash on first use, so check
  // both the plain-text row and the hash.
  try {
    const { default: db } = await import('./models/db.js');
    const [rows] = await db.query('SELECT password FROM Admin WHERE username = ?', ['admin']);
    if (rows.length) {
      const stored = rows[0].password || '';
      const bcrypt = (await import('bcrypt')).default;
      const isDefault = /^\$2[aby]\$/.test(stored)
        ? await bcrypt.compare('admin', stored)
        : stored === 'admin';
      if (isDefault) {
        // In production this is not a warning, it is a breach waiting for
        // whoever finds the site first: admin/admin is the first thing anyone
        // tries, and the admin account can delete any user and any file. A
        // warning printed to a log nobody reads is not a control, so the
        // server refuses to come up instead.
        if (isProduction) {
          console.error('\n' + '='.repeat(64));
          console.error(' REFUSING TO START');
          console.error('  The admin account still has the default password "admin".');
          console.error('  Set a real one, then start again:');
          console.error('      node scripts/setAdminPassword.js');
          console.error('='.repeat(64) + '\n');
          process.exit(1);
        }
        warnings.push(
          'The admin account still uses the default password "admin". ' +
          'Change it with:  node scripts/setAdminPassword.js'
        );
      }
    }
  } catch {
    // A database that isn't reachable yet is reported elsewhere; this check
    // must never stop the server from starting.
  }

  // Uploads on a throwaway filesystem is the single easiest way to deploy this
  // and have it look fine for a day. Nothing breaks at boot; files just start
  // disappearing after the first redeploy, and the app reports them as
  // "listed in the database but not on the server" - which reads like data
  // loss, because it is.
  try {
    const { storageMode } = await import('./services/fileStorage.js');
    if (isProduction && storageMode() === 'disk') {
      warnings.push(
        'FILE_STORAGE is "disk". If this host does not give you a persistent ' +
        'volume (Render free, Vercel and most free tiers do not), every uploaded ' +
        'file is lost on the next deploy or restart. Set FILE_STORAGE=database.'
      );
    }
  } catch { /* the storage layer reports its own problems */ }

  if (warnings.length) {
    console.warn('\n' + '='.repeat(64));
    console.warn(' SECURITY WARNING' + (isProduction ? ' (PRODUCTION)' : ''));
    warnings.forEach(w => console.warn('  - ' + w));
    console.warn('='.repeat(64) + '\n');
  }
}

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    warnAboutInsecureDefaults();
  });
}

export default app;










