// Covers the fix from the security pass: /uploads/<file> used to be served by
// a plain express.static with no login check at all. These tests seed a file
// directly (bypassing the multipart upload flow, which is covered separately
// in files.test.js) and assert the download itself is session-gated.
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import app from '../../app.js';
import { testPool, resetDatabase, closeTestDb } from '../setup/testDb.js';
import { registerAndLogin } from '../setup/authHelpers.js';

const FIXTURE = path.join(process.cwd(), 'tests', 'fixtures', 'sample.pdf');
let copiedFilePath = null;

beforeEach(async () => {
  await resetDatabase();
  copiedFilePath = null;
});

afterEach(() => {
  if (copiedFilePath && fs.existsSync(copiedFilePath)) {
    fs.unlinkSync(copiedFilePath);
  }
});

afterAll(async () => {
  await closeTestDb();
});

async function seedFile(uploaderId) {
  const [category] = await testPool.query('INSERT INTO Categories (name) VALUES (?)', ['General']);
  const categoryId = category.insertId;
  const title = 'uploads-access-test.pdf';

  const [result] = await testPool.query(
    'INSERT INTO Files (categoryID, title, description, uploadedBy) VALUES (?, ?, ?, ?)',
    [categoryId, title, 'seeded for uploads-access test', uploaderId]
  );
  const fileId = result.insertId;

  copiedFilePath = path.join(process.cwd(), 'public', 'uploads', `${fileId}-${title}`);
  fs.copyFileSync(FIXTURE, copiedFilePath);

  return { fileId, fileName: `${fileId}-${title}` };
}

describe('GET /uploads/:file', () => {
  it('rejects an anonymous request with 401', async () => {
    const { agent, user } = await registerAndLogin(app);
    const [[row]] = await testPool.query('SELECT userId FROM Users WHERE username = ?', [user.username]);
    const { fileName } = await seedFile(row.userId);

    const res = await request(app).get(`/uploads/${fileName}`);
    expect(res.status).toBe(401);
  });

  it('serves the file to a logged-in user', async () => {
    const { agent, user } = await registerAndLogin(app);
    const [[row]] = await testPool.query('SELECT userId FROM Users WHERE username = ?', [user.username]);
    const { fileName } = await seedFile(row.userId);

    const res = await agent.get(`/uploads/${fileName}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/pdf/);
  });
});
