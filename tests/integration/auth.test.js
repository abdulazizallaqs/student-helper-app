import request from 'supertest';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import app from '../../app.js';
import { resetDatabase, closeTestDb } from '../setup/testDb.js';
import { uniqueUser, registerAndLogin } from '../setup/authHelpers.js';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestDb();
});

describe('registration', () => {
  it('creates an account with valid data', async () => {
    const user = uniqueUser();
    const res = await request(app).post('/create-account').type('form').send(user);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/created successfully/i);
  });

  it('rejects registration without agreeing to the terms', async () => {
    // Form submissions (not JSON/file-upload requests) are redirected back
    // with a friendly ?error= message rather than a raw 400, matching every
    // other form-validation failure in this app (see handleValidationErrors).
    const { terms, ...user } = uniqueUser();
    const res = await request(app).post('/create-account').type('form').send(user);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error');
  });

  it('rejects a duplicate username with a friendly message (not a 500)', async () => {
    const user = uniqueUser();
    const first = await request(app).post('/create-account').type('form').send(user);
    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/create-account')
      .type('form')
      .send(uniqueUser({ username: user.username }));

    expect(second.status).toBeLessThan(500);
    expect(second.text).toMatch(/already exists/i);
  });
});

describe('login', () => {
  it('logs in with correct credentials and redirects to the dashboard', async () => {
    const user = uniqueUser();
    await request(app).post('/create-account').type('form').send(user);

    const res = await request(app).post('/').type('form').send({ username: user.username, password: user.password });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/views/file-page-forme.html');
  });

  it('rejects an incorrect password without revealing whether the username exists', async () => {
    const user = uniqueUser();
    await request(app).post('/create-account').type('form').send(user);

    const res = await request(app).post('/').type('form').send({ username: user.username, password: 'WrongPass1' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error');

    const unknown = await request(app).post('/').type('form').send({ username: 'no-such-user', password: 'WrongPass1' });
    expect(unknown.headers.location).toBe(res.headers.location);
  });

  it('registerAndLogin helper produces a session that can reach a protected page', async () => {
    const { agent } = await registerAndLogin(app);
    const res = await agent.get('/add-file');
    expect(res.status).toBe(200);
  });
});
