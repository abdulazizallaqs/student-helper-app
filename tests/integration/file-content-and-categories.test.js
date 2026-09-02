// Covers the three fixes that touch this area:
//
//  1. GET /file-content/:id - the viewer no longer guesses the upload's URL
//     from the file title, which is why Display.html showed a blank page for
//     any title containing a space, '#' or '/', and why a missing upload was
//     indistinguishable from a rendering failure.
//  2. POST /categories and the `newCategory` field on upload - a student can
//     file a note under a subject that is not in the table yet.
//  3. Session fixation - logging in must issue a NEW session id.
import '../setup/relaxAuthLimiter.js';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';

vi.mock('../../services/aiService.js', () => ({
  default: { generateKeywords: vi.fn().mockResolvedValue('mocked keyword') },
}));

import app from '../../app.js';
import { testPool, resetDatabase, closeTestDb } from '../setup/testDb.js';
import { registerAndLogin, uniqueUser } from '../setup/authHelpers.js';

const FIXTURE = path.join(process.cwd(), 'tests', 'fixtures', 'sample.pdf');
const UPLOADS = path.join(process.cwd(), 'public', 'uploads');
let created = [];

beforeEach(async () => {
  await resetDatabase();
  created = [];
});

afterEach(() => {
  for (const p of created) if (fs.existsSync(p)) fs.unlinkSync(p);
});

afterAll(async () => {
  await closeTestDb();
});

async function seedCategory(name = 'General') {
  const [result] = await testPool.query('INSERT INTO Categories (name) VALUES (?)', [name]);
  return result.insertId;
}

/** Upload a PDF and return its new file id, tracking the blob for cleanup. */
async function upload(agent, fields) {
  const req = agent.post('/upload-note').attach('file', FIXTURE);
  for (const [key, value] of Object.entries(fields)) req.field(key, String(value));
  const res = await req;
  expect(res.status).toBe(302);

  const [[row]] = await testPool.query('SELECT id FROM Files ORDER BY id DESC LIMIT 1');
  const name = fs.readdirSync(UPLOADS).find((f) => f.startsWith(`${row.id}-`));
  if (name) created.push(path.join(UPLOADS, name));
  return row.id;
}

describe('GET /file-content/:id', () => {
  it('refuses an anonymous caller', async () => {
    const res = await request(app).get('/file-content/1');
    expect(res.status).toBe(401);
  });

  it('serves the PDF bytes with an inline PDF content type', async () => {
    const categoryId = await seedCategory();
    const { agent } = await registerAndLogin(app);
    const id = await upload(agent, {
      title: 'Vectors Notes',
      description: 'chapter 2',
      category: categoryId,
    });

    const res = await agent.get(`/file-content/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('inline');
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('serves a title containing spaces and punctuation - the case the old URL guess broke on', async () => {
    const categoryId = await seedCategory();
    const { agent } = await registerAndLogin(app);
    const id = await upload(agent, {
      title: 'Ch 3: waves & optics #final',
      description: 'awkward title on purpose',
      category: categoryId,
    });

    const res = await agent.get(`/file-content/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
  });

  it('says the upload is missing rather than returning an empty body', async () => {
    const categoryId = await seedCategory();
    const { agent } = await registerAndLogin(app);
    const id = await upload(agent, {
      title: 'Ghost Notes',
      description: 'blob will be removed',
      category: categoryId,
    });

    // Simulate an upload whose bytes never made it to disk.
    for (const p of created) if (fs.existsSync(p)) fs.unlinkSync(p);
    created = [];

    const res = await agent.get(`/file-content/${id}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('missingOnDisk');
  });

  it('404s a file id that does not exist', async () => {
    const { agent } = await registerAndLogin(app);
    const res = await agent.get('/file-content/999999');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('notFound');
  });
});

describe('POST /categories', () => {
  it('refuses an anonymous caller', async () => {
    const res = await request(app).post('/categories').send({ name: 'Astronomy' });
    expect(res.status).toBe(401);
  });

  it('creates a category and reuses it when the same name comes back in another case', async () => {
    const { agent } = await registerAndLogin(app);

    const first = await agent.post('/categories').send({ name: 'Astronomy' });
    expect(first.status).toBe(201);
    expect(first.body.category.created).toBe(true);

    const second = await agent.post('/categories').send({ name: '  astronomy ' });
    expect(second.status).toBe(200);
    expect(second.body.category.created).toBe(false);
    expect(second.body.category.id).toBe(first.body.category.id);

    const [rows] = await testPool.query('SELECT COUNT(*) AS c FROM Categories');
    expect(rows[0].c).toBe(1);
  });

  it('rejects a name that is too short', async () => {
    const { agent } = await registerAndLogin(app);
    const res = await agent.post('/categories').send({ name: 'x' });
    expect(res.status).toBe(400);
  });
});

describe('POST /upload-note with a brand new category', () => {
  it('creates the category and files the upload under it', async () => {
    const { agent } = await registerAndLogin(app);

    const id = await upload(agent, {
      title: 'Thermo Notes',
      description: 'first file in a brand new subject',
      newCategory: 'Thermodynamics',
    });

    const res = await agent.get(`/file/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.category).toBe('Thermodynamics');
  });
});

/** Pull the connect.sid value out of a response's Set-Cookie header. */
function sessionId(res) {
  const cookies = res.headers['set-cookie'] || [];
  const cookie = cookies.find((c) => c.startsWith('connect.sid='));
  return cookie ? cookie.split(';')[0].slice('connect.sid='.length) : null;
}

describe('login session handling', () => {
  it('issues a NEW session id on every login, so an existing id is never inherited', async () => {
    // Two accounts, one browser. Logging in as the second must not continue
    // on the session id the first was using - that id is exactly what a
    // session-fixation attack relies on being able to keep.
    const { agent, user: first } = await registerAndLogin(app);
    const sidFirst = sessionId(await agent.post('/').type('form').send({
      username: first.username,
      password: first.password,
    }));
    expect(sidFirst).toBeTruthy();

    const second = uniqueUser();
    await agent.post('/create-account').type('form').send(second);
    const sidSecond = sessionId(await agent.post('/').type('form').send({
      username: second.username,
      password: second.password,
    }));

    expect(sidSecond).toBeTruthy();
    expect(sidSecond).not.toBe(sidFirst);

    const me = await agent.get('/api/session/me');
    expect(me.body.username).toBe(second.username);
  });

  it('does not leave a user identity behind when an admin logs in on the same browser', async () => {
    const { agent } = await registerAndLogin(app);
    await testPool.query('INSERT INTO Admin (username, password) VALUES (?, ?)', ['rootadmin', 'Adm1nPass']);

    await agent.post('/').type('form').send({ username: 'rootadmin', password: 'Adm1nPass' });

    const me = await agent.get('/api/session/me');
    expect(me.status).toBe(200);
    // Both identities used to coexist on one session, satisfying the user
    // guards and the admin guards at the same time.
    expect(me.body.role).toBe('admin');

    const mine = await agent.get('/my-files');
    expect(mine.status).toBe(401);
  });

  it('records WHO is acting, not just that someone is', async () => {
    const { agent, user } = await registerAndLogin(app);
    const me = await agent.get('/api/session/me');

    expect(me.status).toBe(200);
    expect(me.body.role).toBe('user');
    expect(me.body.username).toBe(user.username);
    expect(me.body.id).toEqual(expect.any(Number));
    expect(me.body.loginAt).toEqual(expect.any(String));
  });

  it('POST /logout ends the session', async () => {
    const { agent } = await registerAndLogin(app);
    expect((await agent.get('/api/session/me')).status).toBe(200);

    const out = await agent.post('/logout').set('Accept', 'application/json');
    expect(out.status).toBe(200);
    expect(out.body.success).toBe(true);

    expect((await agent.get('/api/session/me')).status).toBe(401);
  });
});
