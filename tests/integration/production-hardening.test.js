// Tests for the production-hardening pass: CSRF protection, session cookie
// flags, the secret-fallback removal, password change and account deletion.
//
// Each of these covers something that was a publish blocker.
import '../setup/relaxAuthLimiter.js';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import app from '../../app.js';
import { testPool, resetDatabase, closeTestDb } from '../setup/testDb.js';
import { registerAndLogin } from '../setup/authHelpers.js';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestDb();
});

async function userIdOf(username) {
  const [[row]] = await testPool.query('SELECT userId FROM Users WHERE username = ?', [username]);
  return row.userId;
}

async function seedFileForUser(uploaderId, title = 'Notes.pdf') {
  const [category] = await testPool.query('INSERT INTO Categories (name) VALUES (?)', ['General']);
  const [result] = await testPool.query(
    'INSERT INTO Files (categoryID, title, description, uploadedBy) VALUES (?, ?, ?, ?)',
    [category.insertId, title, 'seeded', uploaderId]
  );
  return result.insertId;
}

// ---------------------------------------------------------------------------
describe('CSRF protection', () => {
  // The attack: a logged-in student visits evil.com, which auto-submits a
  // form at this app. The browser attaches their session cookie because
  // cookies go by destination, and the server happily deletes their file.
  it('blocks a state-changing request that claims to come from another site', async () => {
    const { agent, user } = await registerAndLogin(app);
    const uid = await userIdOf(user.username);
    const fileId = await seedFileForUser(uid);

    const res = await agent
      .delete(`/file-page-myfile/${fileId}`)
      .set('Origin', 'https://evil.example.com');

    expect(res.status).toBe(403);

    // Most importantly: the file must still be there.
    const [[row]] = await testPool.query('SELECT COUNT(*) AS c FROM Files WHERE id = ?', [fileId]);
    expect(row.c).toBe(1);
  });

  it('blocks a cross-site POST identified only by Referer', async () => {
    const { agent, user } = await registerAndLogin(app);
    const uid = await userIdOf(user.username);
    const fileId = await seedFileForUser(uid);

    const res = await agent
      .post('/add-chat')
      .set('Referer', 'https://evil.example.com/attack.html')
      .send({ fileId, chatText: 'posted by an attacker' });

    expect(res.status).toBe(403);

    const [[row]] = await testPool.query('SELECT COUNT(*) AS c FROM chats WHERE fileID = ?', [fileId]);
    expect(row.c).toBe(0);
  });

  it('allows the same request when it comes from this site', async () => {
    const { agent, user } = await registerAndLogin(app);
    const uid = await userIdOf(user.username);
    const fileId = await seedFileForUser(uid);

    const res = await agent
      .post('/add-chat')
      .set('Origin', 'http://127.0.0.1')
      .set('Host', '127.0.0.1')
      .send({ fileId, chatText: 'a legitimate comment' });

    expect(res.status).toBe(200);
  });

  it('does not interfere with ordinary reads', async () => {
    const { agent } = await registerAndLogin(app);
    const res = await agent.get('/msg').set('Origin', 'https://evil.example.com');
    // GET changes nothing, so it is not blocked by CSRF rules.
    expect(res.status).toBe(200);
  });

  it('blocks an opaque ("null") origin, which is what a sandboxed frame sends', async () => {
    const { agent, user } = await registerAndLogin(app);
    const uid = await userIdOf(user.username);
    const fileId = await seedFileForUser(uid);

    const res = await agent
      .delete(`/file-page-myfile/${fileId}`)
      .set('Origin', 'null');

    expect(res.status).toBe(403);
    const [[row]] = await testPool.query('SELECT COUNT(*) AS c FROM Files WHERE id = ?', [fileId]);
    expect(row.c).toBe(1);
  });

  // Regression for a bug this pass introduced and then fixed. Helmet's default
  // Referrer-Policy is `no-referrer`, and under it Chrome sends `Origin: null`
  // on ordinary same-origin HTML form posts - which made the CSRF check reject
  // real logins. Every supertest check still passed, because supertest does not
  // implement referrer policy; only a real browser caught it. The policy must
  // therefore stay one that lets our own pages identify themselves to us.
  it('uses a Referrer-Policy that still identifies same-origin requests', async () => {
    const res = await request(app).get('/login');
    const policy = res.headers['referrer-policy'];

    expect(policy, 'Referrer-Policy header should be set').toBeDefined();
    expect(
      policy,
      'no-referrer makes Chrome send Origin: null on form posts, which breaks login'
    ).not.toBe('no-referrer');
    expect(['same-origin', 'strict-origin-when-cross-origin', 'origin-when-cross-origin'])
      .toContain(policy);
  });
});

// ---------------------------------------------------------------------------
describe('session cookie hardening', () => {
  it('marks the session cookie HttpOnly and SameSite', async () => {
    const { user } = await registerAndLogin(app);
    const agent = request.agent(app);
    const res = await agent.post('/').type('form')
      .send({ username: user.username, password: user.password });

    const cookies = res.headers['set-cookie'] || [];
    const sessionCookie = cookies.find(c => c.startsWith('connect.sid'));

    expect(sessionCookie, 'a session cookie should be issued on login').toBeDefined();
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
  });

  it('does not create a session for a visitor who never logs in', async () => {
    const res = await request(app).get('/login');
    const cookies = res.headers['set-cookie'] || [];
    expect(cookies.find(c => c.startsWith('connect.sid'))).toBeUndefined();
  });

  it('has no hardcoded session-secret fallback left in the source', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'routes', 'session.js'), 'utf8'
    );
    // Strip comments first - the file explains the old bug by name, and the
    // point is that no such literal survives in the executable code.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter(line => !line.trim().startsWith('//'))
      .join('\n');

    // The published-source problem: a literal fallback key anyone can read.
    expect(code).not.toMatch(/fallback_secret_key/);
    // And it must refuse to boot in production without a real secret.
    expect(code).toMatch(/NODE_ENV === 'production'/);
    expect(code).toMatch(/throw new Error/);
  });
});

// ---------------------------------------------------------------------------
describe('password change', () => {
  it('lets a user change their own password and log in with the new one', async () => {
    const { agent, user } = await registerAndLogin(app);

    const res = await agent.post('/change-password').send({
      currentPassword: user.password,
      newPassword: 'BrandNew1',
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // The old password must stop working...
    const oldLogin = await request(app).post('/').type('form')
      .send({ username: user.username, password: user.password });
    expect(oldLogin.headers.location).toContain('error');

    // ...and the new one must work.
    const newLogin = await request(app).post('/').type('form')
      .send({ username: user.username, password: 'BrandNew1' });
    expect(newLogin.headers.location).toBe('/views/file-page-forme.html');
  });

  it('refuses to change the password without the correct current one', async () => {
    const { agent, user } = await registerAndLogin(app);

    const res = await agent.post('/change-password').send({
      currentPassword: 'NotMyPassword1',
      newPassword: 'BrandNew1',
    });

    expect(res.status).toBe(403);

    // The original password must still work.
    const login = await request(app).post('/').type('form')
      .send({ username: user.username, password: user.password });
    expect(login.headers.location).toBe('/views/file-page-forme.html');
  });

  it('enforces password strength on the new password', async () => {
    const { agent, user } = await registerAndLogin(app);
    const res = await agent.post('/change-password').send({
      currentPassword: user.password,
      newPassword: '123456',
    });
    expect(res.status).toBe(400);
  });

  it('requires a session', async () => {
    const res = await request(app).post('/change-password')
      .send({ currentPassword: 'x', newPassword: 'BrandNew1' });
    expect(res.status).toBe(401);
  });

  it('never stores the new password in plain text', async () => {
    const { agent, user } = await registerAndLogin(app);
    await agent.post('/change-password').send({
      currentPassword: user.password,
      newPassword: 'BrandNew1',
    });

    const [[row]] = await testPool.query(
      'SELECT password FROM Users WHERE username = ?', [user.username]
    );
    expect(row.password).not.toBe('BrandNew1');
    expect(row.password).toMatch(/^\$2[aby]\$/); // a bcrypt hash
  });
});

// ---------------------------------------------------------------------------
describe('account deletion', () => {
  it('lets a user delete their own account and takes their data with it', async () => {
    const { agent, user } = await registerAndLogin(app);
    const uid = await userIdOf(user.username);
    await seedFileForUser(uid);

    const res = await agent.delete('/delete-account').send({ password: user.password });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const [[users]] = await testPool.query(
      'SELECT COUNT(*) AS c FROM Users WHERE userId = ?', [uid]);
    expect(users.c).toBe(0);

    // ON DELETE CASCADE should have removed their files too.
    const [[files]] = await testPool.query(
      'SELECT COUNT(*) AS c FROM Files WHERE uploadedBy = ?', [uid]);
    expect(files.c).toBe(0);
  });

  it('refuses to delete the account without the correct password', async () => {
    const { agent, user } = await registerAndLogin(app);
    const uid = await userIdOf(user.username);

    const res = await agent.delete('/delete-account').send({ password: 'WrongPass1' });

    expect(res.status).toBe(403);
    const [[row]] = await testPool.query(
      'SELECT COUNT(*) AS c FROM Users WHERE userId = ?', [uid]);
    expect(row.c).toBe(1);
  });

  it('requires a session', async () => {
    const res = await request(app).delete('/delete-account').send({ password: 'x' });
    expect(res.status).toBe(401);
  });

  it('ends the session so the account cannot keep browsing', async () => {
    const { agent, user } = await registerAndLogin(app);
    await agent.delete('/delete-account').send({ password: user.password });

    const after = await agent.get('/msg');
    expect(after.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe('legacy plain-text passwords', () => {
  // The old verifyPassword ended with `return password === hash`, so a
  // plain-text row stayed usable forever and was never upgraded.
  it('accepts a legacy plain-text password once, then rewrites it as a hash', async () => {
    const { user } = await registerAndLogin(app);
    const uid = await userIdOf(user.username);

    // Simulate a legacy row by writing the password back as plain text.
    await testPool.query('UPDATE Users SET password = ? WHERE userId = ?', ['LegacyPass1', uid]);

    const login = await request(app).post('/').type('form')
      .send({ username: user.username, password: 'LegacyPass1' });
    expect(login.headers.location).toBe('/views/file-page-forme.html');

    // It must now be stored hashed, not plain.
    const [[row]] = await testPool.query('SELECT password FROM Users WHERE userId = ?', [uid]);
    expect(row.password).not.toBe('LegacyPass1');
    expect(row.password).toMatch(/^\$2[aby]\$/);

    // And the same password still logs in against the new hash.
    const again = await request(app).post('/').type('form')
      .send({ username: user.username, password: 'LegacyPass1' });
    expect(again.headers.location).toBe('/views/file-page-forme.html');
  });
});
