// Cross-Site Request Forgery (CSRF) protection.
//
// THE ATTACK this prevents: a student is logged into Student Helper. They
// visit some other page - a forum post, a phishing email link - which quietly
// contains:
//
//     <form action="https://your-app/file-page-myfile/12" method="POST">
//     <script>document.forms[0].submit()</script>
//
// The browser attaches their Student Helper session cookie to that request
// because cookies are sent based on the DESTINATION, not on who initiated it.
// The server sees a perfectly valid logged-in request and deletes their file.
// Nothing in the app could tell the difference.
//
// This app is defended in two layers:
//
//  1. `sameSite: 'lax'` on the session cookie (routes/session.js) - modern
//     browsers refuse to attach the cookie to cross-site POST/PUT/DELETE at
//     all, so the forged request arrives logged OUT and simply fails.
//
//  2. This middleware - an Origin/Referer check on every state-changing
//     request, as defence in depth for older browsers (and for anything that
//     ignores SameSite).
//
// Why an origin check rather than per-form hidden tokens: this app posts from
// plain HTML forms, fetch() calls and inline handlers across ~20 pages. A
// synchronizer-token scheme would need every one of those touched, and any
// form missed becomes a silent 403 for a real user. The origin check needs no
// changes to any page and cannot be forged - browsers set Origin themselves
// and will not let page JavaScript override it.

// Requests that only read data never change state, so they are not checked.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Builds the set of origins that are allowed to make state-changing requests.
 * The app's own origin always counts; extra ones can be added via the
 * CORS_ORIGIN env var (same list the CORS config in app.js reads), which is
 * what you'd set if a separate frontend or mobile web client is added later.
 */
function allowedOrigins(req) {
  const origins = new Set();

  // The origin this very request was addressed to - i.e. the app itself.
  // req.protocol honours `trust proxy`, so this stays correct behind a
  // reverse proxy terminating HTTPS.
  const host = req.get('host');
  if (host) {
    origins.add(`${req.protocol}://${host}`);
    // A deployment reached over both http and https should not lock itself
    // out mid-redirect.
    origins.add(`https://${host}`);
    origins.add(`http://${host}`);
  }

  (process.env.CORS_ORIGIN || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean)
    .forEach(o => origins.add(o));

  return origins;
}

export const csrfProtection = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) {
    return next();
  }

  const origin = req.get('origin');
  const referer = req.get('referer');

  // No Origin and no Referer: not a browser-initiated cross-site request.
  // Browsers always send at least one of these on a cross-origin form post or
  // fetch, so the absence of both means this is a same-origin request from an
  // older browser, a server-to-server call, curl, or the test suite. Rejecting
  // these would break legitimate clients without blocking any real attack -
  // the attack requires a browser, and a browser would have sent the header.
  if (!origin && !referer) {
    return next();
  }

  const allowed = allowedOrigins(req);

  // An opaque origin arrives as the literal string "null" - from a sandboxed
  // iframe, a data: URL, or a document whose referrer policy stripped the
  // origin. It is never a legitimate same-site request from this app (the
  // app's Referrer-Policy is `same-origin`, so our own pages always identify
  // themselves), and it IS what a sandboxed attacker frame sends, so it is
  // rejected rather than waved through.
  if (origin === 'null') {
    console.warn(`[csrf] Blocked ${req.method} ${req.originalUrl} from an opaque (null) origin`);
    return res.status(403).json({
      status: 'fail',
      message: 'Request blocked: it did not come from this site.'
    });
  }

  // Prefer Origin: it is the header specifically designed for this and is
  // sent on every cross-origin state-changing request.
  let requestOrigin = origin;
  if (!requestOrigin && referer) {
    try {
      requestOrigin = new URL(referer).origin;
    } catch {
      // A malformed Referer is not something a normal browser produces.
      return res.status(403).json({
        status: 'fail',
        message: 'Request blocked: could not verify where it came from.'
      });
    }
  }

  if (allowed.has(requestOrigin)) {
    return next();
  }

  console.warn(
    `[csrf] Blocked ${req.method} ${req.originalUrl} from origin ${requestOrigin}`
  );

  return res.status(403).json({
    status: 'fail',
    message: 'Request blocked: it did not come from this site.'
  });
};

export default csrfProtection;
