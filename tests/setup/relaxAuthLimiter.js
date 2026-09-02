// Side-effect-only module: raises the login rate limiter's ceiling for test
// files that legitimately perform more than 5 real logins in one run (e.g.
// several independently seeded users), without weakening the production
// default (middleware/rateLimiters.js's authLimiter still defaults to 5).
//
// Import this FIRST, before importing app.js - ES module imports execute in
// the order they appear, and middleware/rateLimiters.js reads this env var
// only once, at import time, to build its authLimiter instance.
//
// tests/integration/authRateLimit.test.js deliberately does NOT import this,
// so it still exercises the real production max:5 lockout behavior.
process.env.AUTH_RATE_LIMIT_MAX = process.env.AUTH_RATE_LIMIT_MAX || '1000';
