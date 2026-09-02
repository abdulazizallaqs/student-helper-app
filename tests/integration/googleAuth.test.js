// Sign in with Google, exercised end to end.
//
// The reported symptom was "login with Google does not work". On this
// deployment the cause is configuration - GOOGLE_CLIENT_ID and
// GOOGLE_CLIENT_SECRET are absent from .env, so the feature disables itself.
// That is not something code can fix, but it IS something code can be wrong
// about too, so this file proves the flow itself is sound:
//
//   * with no credentials  -> the button is not offered and /auth/google
//                             explains itself instead of 500ing
//   * with credentials     -> the whole handshake runs, against a stub that
//                             stands in for accounts.google.com, and ends
//                             with a real logged-in session
//
// passport-google-oauth20 lets the three Google URLs be overridden, which is
// what makes the second half testable without touching the internet.
import '../setup/relaxAuthLimiter.js';
import request from 'supertest';
import express from 'express';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { testPool, resetDatabase, closeTestDb } from '../setup/testDb.js';

beforeEach(async () => {
  await resetDatabase();
  vi.resetModules();
});

afterAll(async () => {
  await closeTestDb();
});

describe('when Google sign-in is not configured', () => {
  it('reports google:false so the login page can hide the button', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', '');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', '');
    const { default: app } = await import('../../app.js');

    const res = await request(app).get('/api/auth/providers');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ password: true, google: false });
  });

  it('explains itself instead of crashing when /auth/google is opened anyway', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', '');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', '');
    const { default: app } = await import('../../app.js');

    const res = await request(app).get('/auth/google');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/login?error=');
    expect(decodeURIComponent(res.headers.location)).toMatch(/not set up/i);
  });
});

describe('when Google sign-in IS configured', () => {
  /**
   * A stand-in for accounts.google.com: it issues a token and returns one
   * fixed profile. Started on an ephemeral port so nothing external is
   * touched and the test cannot be flaky on someone else's network.
   */
  async function startFakeGoogle(profile) {
    const fake = express();
    fake.use(express.urlencoded({ extended: true }));
    fake.use(express.json());

    fake.post('/token', (req, res) => {
      res.json({ access_token: 'fake-access-token', token_type: 'Bearer', expires_in: 3600 });
    });
    fake.get('/userinfo', (req, res) => res.json(profile));

    const server = await new Promise((resolve) => {
      const s = fake.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address();
    return { server, base: `http://127.0.0.1:${port}` };
  }

  /**
   * Walk the real handshake: ask for the redirect (which plants the CSRF state
   * in this agent's session), then come back to the callback carrying the same
   * state, exactly as a browser returning from Google would.
   *
   * These tests used to call the callback directly with only a code. That
   * passed, and it should not have - it is precisely the request an attacker
   * sends a victim. It only passed because the state parameter was configured
   * in the wrong place and verified nothing.
   */
  async function completeGoogleSignIn(app, agent) {
    const start = await agent.get('/auth/google');
    const state = new URL(start.headers.location).searchParams.get('state');
    expect(state, 'the redirect to Google must carry a CSRF state').toBeTruthy();
    return agent.get(`/auth/google/callback?code=fake-auth-code&state=${encodeURIComponent(state)}`);
  }

  async function loadAppWithGoogle(base) {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client-id.apps.googleusercontent.com');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-client-secret');
    vi.stubEnv('GOOGLE_AUTHORIZATION_URL', `${base}/authorize`);
    vi.stubEnv('GOOGLE_TOKEN_URL', `${base}/token`);
    vi.stubEnv('GOOGLE_USERINFO_URL', `${base}/userinfo`);
    return (await import('../../app.js')).default;
  }

  it('offers the button and redirects to Google with the right parameters', async () => {
    const { server, base } = await startFakeGoogle({});
    try {
      const app = await loadAppWithGoogle(base);

      const providers = await request(app).get('/api/auth/providers');
      expect(providers.body.google).toBe(true);

      const res = await request(app).get('/auth/google');
      expect(res.status).toBe(302);

      const target = new URL(res.headers.location);
      expect(target.origin + target.pathname).toBe(`${base}/authorize`);
      expect(target.searchParams.get('client_id')).toBe('test-client-id.apps.googleusercontent.com');
      expect(target.searchParams.get('response_type')).toBe('code');
      expect(target.searchParams.get('scope')).toContain('email');
      // The redirect_uri must be absolute and must match what is registered
      // in the Google console character for character, or Google answers
      // redirect_uri_mismatch - the single most common setup failure.
      expect(target.searchParams.get('redirect_uri')).toMatch(/^https?:\/\/.+\/auth\/google\/callback$/);
    } finally {
      server.close();
    }
  });

  it('creates the account on first sign-in and ends with a real session', async () => {
    const { server, base } = await startFakeGoogle({
      sub: '1234567890',
      name: 'Layla Al Otaibi',
      email: 'layla@example.com',
      email_verified: true,
    });
    try {
      const app = await loadAppWithGoogle(base);
      const agent = request.agent(app);

      const res = await completeGoogleSignIn(app, agent);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/views/file-page-forme.html');

      // A real user row, and a session that every other guard accepts.
      const [rows] = await testPool.query('SELECT * FROM Users WHERE email = ?', ['layla@example.com']);
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('Layla Al Otaibi');

      const me = await agent.get('/api/session/me');
      expect(me.status).toBe(200);
      expect(me.body.role).toBe('user');
      expect(me.body.id).toBe(rows[0].userId);

      // Session-backed pages work for a Google user exactly as for any other.
      expect((await agent.get('/my-files')).status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('signs an existing account in rather than creating a duplicate', async () => {
    const { server, base } = await startFakeGoogle({
      sub: '999',
      name: 'Returning Student',
      email: 'returning@example.com',
    });
    try {
      await testPool.query(
        'INSERT INTO Users (name, username, email, password) VALUES (?, ?, ?, ?)',
        ['Returning Student', 'returning', 'returning@example.com', '$2b$10$abcdefghijklmnopqrstuv']
      );

      const app = await loadAppWithGoogle(base);
      const agent = request.agent(app);
      const res = await completeGoogleSignIn(app, agent);

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/views/file-page-forme.html');

      const [rows] = await testPool.query('SELECT * FROM Users WHERE email = ?', ['returning@example.com']);
      expect(rows).toHaveLength(1);

      const me = await agent.get('/api/session/me');
      expect(me.body.username).toBe('returning');
    } finally {
      server.close();
    }
  });

  it('refuses a callback that was not started in this browser', async () => {
    // THE ATTACK: the attacker begins a Google sign-in for their own account,
    // stops before the last step, and sends the victim the callback link. If
    // it is accepted, the victim is silently signed in AS THE ATTACKER, and
    // every note they upload afterwards lands in the attacker's account.
    //
    // Reproduced against this app before the fix: this exact request returned
    // 302 to the landing page and /api/session/me then answered 200 with the
    // attacker's identity.
    const { server, base } = await startFakeGoogle({
      sub: '666', name: 'Attacker Owned', email: 'attacker@example.com',
    });
    try {
      const app = await loadAppWithGoogle(base);
      const victim = request.agent(app);

      const res = await victim.get('/auth/google/callback?code=stolen-code');

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('/login?error=');
      expect((await victim.get('/api/session/me')).status).toBe(401);

      const [rows] = await testPool.query('SELECT * FROM Users WHERE email = ?', ['attacker@example.com']);
      expect(rows).toHaveLength(0);
    } finally {
      server.close();
    }
  });

  it('refuses a callback carrying someone else\'s state', async () => {
    const { server, base } = await startFakeGoogle({
      sub: '667', name: 'Attacker Owned', email: 'attacker2@example.com',
    });
    try {
      const app = await loadAppWithGoogle(base);

      // The attacker starts their own sign-in and captures the state.
      const attacker = request.agent(app);
      const started = await attacker.get('/auth/google');
      const attackerState = new URL(started.headers.location).searchParams.get('state');

      // The victim, in their own browser, is handed that link.
      const victim = request.agent(app);
      const res = await victim.get(`/auth/google/callback?code=stolen-code&state=${attackerState}`);

      expect(res.headers.location).toContain('/login?error=');
      expect((await victim.get('/api/session/me')).status).toBe(401);
    } finally {
      server.close();
    }
  });

  it('tells the user the link expired rather than blaming Google', async () => {
    const { server, base } = await startFakeGoogle({ sub: '1', email: 'x@example.com' });
    try {
      const app = await loadAppWithGoogle(base);
      const res = await request(app).get('/auth/google/callback?code=c&state=not-a-real-state');
      expect(decodeURIComponent(res.headers.location)).toMatch(/expired|not started here/i);
    } finally {
      server.close();
    }
  });

  it('gives each sign-in attempt a fresh, unguessable state', async () => {
    const { server, base } = await startFakeGoogle({});
    try {
      const app = await loadAppWithGoogle(base);
      const states = [];
      for (let i = 0; i < 3; i += 1) {
        const res = await request.agent(app).get('/auth/google');
        states.push(new URL(res.headers.location).searchParams.get('state'));
      }
      expect(new Set(states).size).toBe(3);
      states.forEach((state) => expect(state.length).toBeGreaterThanOrEqual(16));
    } finally {
      server.close();
    }
  });

  it('sends the user back to login with a message when Google refuses', async () => {
    const { server, base } = await startFakeGoogle({});
    try {
      const app = await loadAppWithGoogle(base);
      // Google appends ?error=access_denied when the person cancels consent.
      const res = await request(app).get('/auth/google/callback?error=access_denied');

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('/login?error=');
      expect(decodeURIComponent(res.headers.location)).toMatch(/google sign-in failed/i);
    } finally {
      server.close();
    }
  });
});
