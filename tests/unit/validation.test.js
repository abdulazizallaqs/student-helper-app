// Unit tests for middleware/validation.js - mounted on tiny standalone Express
// apps (not the real app.js) so these run with no database, no session store,
// and no network at all. They only check that bad input is rejected before it
// would ever reach a controller.
//
// Requests are sent as JSON (not .type('form')) so a validation failure goes
// through handleValidationErrors' isApiRequest branch (a clean 400 JSON body)
// rather than its real-page branch, which redirects with a ?error= message -
// that redirect behavior belongs to the real login/registration pages and is
// covered by tests/integration/auth.test.js, not by this file.
import express from 'express';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { validateRegistration, validateLogin, validateFileUpload } from '../../middleware/validation.js';

function appWith(middlewares) {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.post('/test', ...middlewares, (req, res) => res.status(200).json({ ok: true }));
  return app;
}

describe('validateRegistration', () => {
  const app = appWith(validateRegistration);
  const validBody = {
    name: 'Test Student',
    username: 'test_student1',
    email: 'student@example.com',
    password: 'Passw0rd',
    terms: 'on',
  };

  it('accepts a fully valid registration', async () => {
    const res = await request(app).post('/test').send(validBody);
    expect(res.status).toBe(200);
  });

  it('rejects a password missing an uppercase letter', async () => {
    const res = await request(app).post('/test').send({ ...validBody, password: 'password1' });
    expect(res.status).toBe(400);
  });

  it('rejects a name containing digits', async () => {
    const res = await request(app).post('/test').send({ ...validBody, name: 'Test 123' });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid email', async () => {
    const res = await request(app).post('/test').send({ ...validBody, email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  it('rejects registration when the terms checkbox was not checked', async () => {
    const { terms, ...withoutTerms } = validBody;
    const res = await request(app).post('/test').send(withoutTerms);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/agree/i);
  });
});

describe('validateLogin', () => {
  const app = appWith(validateLogin);

  it('accepts a username and password', async () => {
    const res = await request(app).post('/test').send({ username: 'someone', password: 'anything' });
    expect(res.status).toBe(200);
  });

  it('rejects a missing username', async () => {
    const res = await request(app).post('/test').send({ password: 'anything' });
    expect(res.status).toBe(400);
  });

  it('rejects a missing password', async () => {
    const res = await request(app).post('/test').send({ username: 'someone' });
    expect(res.status).toBe(400);
  });
});

describe('validateFileUpload', () => {
  const app = appWith(validateFileUpload);

  it('accepts a valid title/description/category', async () => {
    const res = await request(app).post('/test').send({
      title: 'Calculus notes',
      description: 'Chapter 3 summary',
      category: '1',
    });
    expect(res.status).toBe(200);
  });

  it('rejects a non-numeric category', async () => {
    const res = await request(app).post('/test').send({
      title: 'Calculus notes',
      description: 'Chapter 3 summary',
      category: 'not-a-number',
    });
    expect(res.status).toBe(400);
  });

  it('rejects an empty title', async () => {
    const res = await request(app).post('/test').send({
      title: '',
      description: 'Chapter 3 summary',
      category: '1',
    });
    expect(res.status).toBe(400);
  });
});
