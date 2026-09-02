import request from 'supertest';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';

// The upload flow fires a background AI keyword-extraction step. Mock it so
// this test suite never makes a real Gemini API call (no network dependency,
// no cost, no flakiness) - the endpoint already treats AI failures as
// non-fatal, so this only changes what actually gets called, not the
// contract being tested.
vi.mock('../../services/aiService.js', () => ({
  default: {
    generateKeywords: vi.fn().mockResolvedValue('mocked keyword'),
  },
}));

import app from '../../app.js';
import { testPool, resetDatabase, closeTestDb } from '../setup/testDb.js';
import { registerAndLogin } from '../setup/authHelpers.js';
import fs from 'fs';

const FIXTURE = path.join(process.cwd(), 'tests', 'fixtures', 'sample.pdf');
let uploadedFilePaths = [];

beforeEach(async () => {
  await resetDatabase();
  uploadedFilePaths = [];
});

afterEach(() => {
  for (const p of uploadedFilePaths) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
});

afterAll(async () => {
  await closeTestDb();
});

async function seedCategory(name = 'General') {
  const [result] = await testPool.query('INSERT INTO Categories (name) VALUES (?)', [name]);
  return result.insertId;
}

describe('GET /categories', () => {
  it('lists categories to a logged-in student', async () => {
    await seedCategory('Math');
    await seedCategory('Physics');

    const { agent } = await registerAndLogin(app);
    const res = await agent.get('/categories');
    expect(res.status).toBe(200);
    expect(res.body.map((c) => c.name).sort()).toEqual(['Math', 'Physics']);
  });

  it('does not list them to an anonymous caller', async () => {
    await seedCategory('Math');
    const res = await request(app).get('/categories');
    expect(res.status).toBe(401);
  });
});

describe('POST /upload-note', () => {
  it('rejects an anonymous upload with 401', async () => {
    const categoryId = await seedCategory();
    const res = await request(app)
      .post('/upload-note')
      .field('title', 'Anon Notes')
      .field('description', 'should be rejected')
      .field('category', String(categoryId))
      .attach('file', FIXTURE);

    expect(res.status).toBe(401);
  });

  it('lets a logged-in user upload a PDF and see it in /my-files', async () => {
    const categoryId = await seedCategory();
    const { agent } = await registerAndLogin(app);

    const uploadRes = await agent
      .post('/upload-note')
      .field('title', 'Vectors Notes')
      .field('description', 'Chapter 2 - vectors and matrices')
      .field('category', String(categoryId))
      .attach('file', FIXTURE);

    expect(uploadRes.status).toBe(302);

    const myFilesRes = await agent.get('/my-files');
    expect(myFilesRes.status).toBe(200);
    expect(myFilesRes.body.some((f) => f.title.startsWith('Vectors Notes'))).toBe(true);

    // Track the file written to public/uploads/ so afterEach cleans it up.
    const uploadsDir = path.join(process.cwd(), 'public', 'uploads');
    for (const name of fs.readdirSync(uploadsDir)) {
      if (name.includes('Vectors Notes')) {
        uploadedFilePaths.push(path.join(uploadsDir, name));
      }
    }
  });

  it('rejects a file type that is not in the allowed list', async () => {
    const categoryId = await seedCategory();
    const { agent } = await registerAndLogin(app);
    const badFixture = path.join(process.cwd(), 'tests', 'fixtures', 'sample.txt');

    const res = await agent
      .post('/upload-note')
      .field('title', 'Bad File')
      .field('description', 'wrong type')
      .field('category', String(categoryId))
      .attach('file', badFixture);

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('GET /search-files', () => {
  it('finds an uploaded file by title', async () => {
    const categoryId = await seedCategory();
    const { agent } = await registerAndLogin(app);

    await agent
      .post('/upload-note')
      .field('title', 'Searchable Thermodynamics Notes')
      .field('description', 'entropy and heat')
      .field('category', String(categoryId))
      .attach('file', FIXTURE);

    const uploadsDir = path.join(process.cwd(), 'public', 'uploads');
    for (const name of fs.readdirSync(uploadsDir)) {
      if (name.includes('Searchable Thermodynamics Notes')) {
        uploadedFilePaths.push(path.join(uploadsDir, name));
      }
    }

    const res = await agent.get('/search-files').query({ query: 'Thermodynamics' });
    expect(res.status).toBe(200);
    expect(res.body.some((f) => f.title.includes('Thermodynamics'))).toBe(true);
  });

  it('refuses an anonymous search', async () => {
    // Search reads the whole library and, since it became semantic, spends a
    // Gemini embedding call per unique query. Neither is something a stranger
    // should be able to do.
    const res = await request(app).get('/search-files').query({ query: 'anything' });
    expect(res.status).toBe(401);
  });
});
