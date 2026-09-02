import rateLimit from 'express-rate-limit';

// General API rate limiter - protects the whole app from abuse/scraping.
// Was previously commented out entirely ("DISABLED FOR DEVELOPMENT").
//
// TWO THINGS WERE WRONG HERE and they broke the messaging page.
//
//  1. The limiter counted EVERY request, static assets included. One page
//     load of the app is ~10 requests (css, js, fonts, icons) before the
//     user has done anything, so a few minutes of normal browsing spent a
//     large part of the budget.
//  2. chat.js polls the open conversation every few seconds. At 4s that is
//     225 requests per 15 minutes on its own. Combined with (1), the 300
//     budget was exhausted well inside the window - after which EVERY
//     request 429'd, including `POST /add-msg`. The chat UI only logged that
//     to the console, so the visible symptom was exactly "I send a message
//     and nothing appears".
//
// Static assets are now skipped (they are served straight off disk and are
// not what abuse protection is for) and the default budget is raised. The
// endpoints worth protecting - login, AI, uploads - have their own stricter
// limiters below.
const STATIC_ASSET = /\.(css|js|mjs|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot)$/i;

export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX || '1200', 10),
  skip: (req) => req.method === 'GET' && STATIC_ASSET.test(req.path),
  message: { status: 'fail', message: 'Too many requests from this IP, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter limiter for login endpoints (user + admin) - prevents brute force guessing.
// NOTE: both authController.login and loginAdminRoute respond with a redirect
// (a 2xx/3xx status) on a WRONG password too, not a 4xx - so this deliberately
// does not use `skipSuccessfulRequests`, which would key off HTTP status and
// end up never counting a failed login attempt at all.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  // Configurable so a test file that legitimately needs more than 5 real
  // logins within one run (e.g. several independent seeded users) can raise
  // this via AUTH_RATE_LIMIT_MAX without weakening the production default -
  // see tests/setup/relaxAuthLimiter.js. tests/integration/authRateLimit.test.js
  // verifies the real max:5 lockout behavior and never sets this override.
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX || '5', 10),
  message: { status: 'fail', message: 'Too many login attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// AI endpoints call the paid Gemini API - keep per-IP usage bounded so a single
// user (or a bot) can't run up the bill.
export const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: parseInt(process.env.AI_RATE_LIMIT_MAX || '30', 10),
  message: { status: 'fail', message: 'AI request limit reached for this hour, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
