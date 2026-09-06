import '../setup/relaxAuthLimiter.js';
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

  // ---- PDF only ----------------------------------------------------------
  //
  // Images, Word documents and zips used to be accepted. Every one of them was
  // a half-supported path - unreadable in the viewer, invisible to the search
  // indexer, refused by every AI tool - so a student who uploaded .docx notes
  // got a file the app could not do anything with. One format handled properly
  // beats five handled partly.
  //
  // Three separate checks, because the first two are only claims the uploader
  // makes about the file, and a claim is not a fact.

  it('rejects an image, which used to be allowed', async () => {
    const categoryId = await seedCategory();
    const { agent } = await registerAndLogin(app);

    // A real 1x1 PNG, correctly named and correctly typed. Nothing about this
    // upload is a lie - it is simply no longer a format this app takes.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );

    const res = await agent
      .post('/upload-note')
      .field('title', 'Diagram')
      .field('description', 'a genuine png')
      .field('category', String(categoryId))
      .attach('file', png, { filename: 'diagram.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/only pdf/i);

    const [rows] = await testPool.query('SELECT id FROM Files');
    expect(rows.length).toBe(0);
  });

  it('rejects a file whose BYTES are not a PDF, however it is labelled', async () => {
    // The check that actually matters. `contentType` is a header the client
    // wrote and the filename is a string it chose - both are free to lie:
    //
    //     curl -F 'file=@payload.html;type=application/pdf' -F 'title=notes.pdf'
    //
    // passes a type-and-extension filter without difficulty. A PDF begins
    // %PDF-, and this one does not.
    const categoryId = await seedCategory();
    const { agent } = await registerAndLogin(app);
    const disguised = Buffer.from('<html><script>alert(document.cookie)</script></html>', 'utf8');

    const res = await agent
      .post('/upload-note')
      .field('title', 'Sneaky Notes')
      .field('description', 'html wearing a pdf name')
      .field('category', String(categoryId))
      .attach('file', disguised, { filename: 'notes.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('notAPdf');

    const [rows] = await testPool.query('SELECT id FROM Files');
    expect(rows.length).toBe(0);
  });

  it('leaves nothing behind in public/uploads when it rejects a disguised file', async () => {
    // A rejected upload has already been streamed to disk by multer in disk
    // mode. Failing to remove it means every attack attempt leaves a file in
    // a directory the app serves.
    const categoryId = await seedCategory();
    const { agent } = await registerAndLogin(app);
    const uploadsDir = path.join(process.cwd(), 'public', 'uploads');
    const before = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : [];

    await agent
      .post('/upload-note')
      .field('title', 'Leftover Check')
      .field('description', 'should not survive')
      .field('category', String(categoryId))
      .attach('file', Buffer.from('PK not a pdf'), {
        filename: 'leftover.pdf',
        contentType: 'application/pdf',
      });

    const after = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : [];
    expect(after).toEqual(before);
  });

  it('still accepts a real PDF', async () => {
    const categoryId = await seedCategory();
    const { agent } = await registerAndLogin(app);

    const res = await agent
      .post('/upload-note')
      .field('title', 'Genuine Notes')
      .field('description', 'a real pdf, the only thing that gets through')
      .field('category', String(categoryId))
      .attach('file', FIXTURE);

    expect(res.status).toBe(302);

    const uploadsDir = path.join(process.cwd(), 'public', 'uploads');
    for (const name of fs.readdirSync(uploadsDir)) {
      if (name.includes('Genuine Notes')) uploadedFilePaths.push(path.join(uploadsDir, name));
    }

    const myFiles = await agent.get('/my-files');
    expect(myFiles.body.some((f) => f.title.startsWith('Genuine Notes'))).toBe(true);
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
