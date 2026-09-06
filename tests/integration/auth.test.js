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

  // The interface of this app is Arabic. The name field used to be validated
  // with /^[a-zA-Z\s]+$/, so a student typing their own name in Arabic was
  // bounced with "Name can only contain letters and spaces" - a message that
  // is not just unhelpful but wrong, because what they typed WAS letters.
  it.each([
    ['Arabic', 'عبدالعزيز اللاقص'],
    ['Arabic with three words', 'نورة العتيبي محمد'],
    ['accented Latin', 'José Álvarez'],
    ['apostrophe and hyphen', "Ali O'Brien-Smith"],
    ['a trailing initial', 'Ahmed K.'],
  ])('accepts a name in %s', async (_label, name) => {
    const res = await request(app)
      .post('/create-account')
      .type('form')
      .send(uniqueUser({ name }));
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/created successfully/i);
  });

  // Widening the alphabet must not widen it to everything: the field still
  // has to reject the payload shapes that make a name dangerous or nonsense.
  it.each([
    ['markup', '<script>alert(1)</script>'],
    ['digits', 'Ahmed123'],
    ['symbols', 'Bad$Name'],
  ])('still rejects a name containing %s', async (_label, name) => {
    const res = await request(app)
      .post('/create-account')
      .type('form')
      .send(uniqueUser({ name }));
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
