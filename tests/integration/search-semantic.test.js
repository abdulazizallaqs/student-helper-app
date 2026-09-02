import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Uploads fire a background AI keyword step. This suite seeds rows directly,
// but app.js still imports the service, so keep it off the network.
vi.mock('../../services/aiService.js', () => ({
  default: { generateKeywords: vi.fn().mockResolvedValue('') },
}));

import app from '../../app.js';
import { testPool, resetDatabase, closeTestDb } from '../setup/testDb.js';
import { registerAndLogin } from '../setup/authHelpers.js';

/**
 * End-to-end proof, against a real database, that /search-files does the
 * things the old `WHERE title LIKE '%q%'` could not.
 *
 * Every one of these queries returned an empty list before: the term was
 * never a literal substring of any single column.
 */
let ids = {};

async function seedFile({ title, description, category, username }) {
  const [cat] = await testPool.query(
    'INSERT INTO Categories (name) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
    [category]
  );
  const [user] = await testPool.query(
    'INSERT INTO Users (name, username, email, password) VALUES (?, ?, ?, ?)',
    [username, username, `${username}@example.com`, 'x']
  );
  const [file] = await testPool.query(
    'INSERT INTO Files (title, description, categoryID, uploadedBy) VALUES (?, ?, ?, ?)',
    [title, description, cat.insertId, user.insertId]
  );
  return file.insertId;
}

beforeAll(async () => {
  await resetDatabase();
  ({ agent } = await registerAndLogin(app));
  ids.thermo = await seedFile({
    title: 'Thermodynamics Lecture Notes',
    description: 'Entropy and the second law. | Keywords: thermodynamics entropy carnot cycle',
    category: 'Physics',
    username: 'ali'
  });
  ids.arabicPhysics = await seedFile({
    title: 'ملخص الفيزياء - الفصل الأول',
    description: 'شرح مبسط للحركة والقوى',
    category: 'فيزياء',
    username: 'sara'
  });
  ids.calculus = await seedFile({
    title: 'Calculus Problem Set',
    description: 'Integration by parts | Keywords: calculus integral derivative',
    category: 'Mathematics',
    username: 'omar'
  });
  ids.recipes = await seedFile({
    title: 'Pasta Recipes',
    description: 'Family cookbook',
    category: 'Food',
    username: 'nora'
  });
});

afterAll(async () => {
  await closeTestDb();
});

// Search now requires a session (it reads the whole library and spends an
// embedding call per unique query), so the suite signs in once and searches
// as that student.
let agent;

const search = (query) => agent.get('/search-files').query({ query });

describe('GET /search-files (semantic ranking)', () => {
  it('still finds an exact title match', async () => {
    const res = await search('Thermodynamics');
    expect(res.status).toBe(200);
    expect(res.body[0].id).toBe(ids.thermo);
  });

  it('finds an Arabic file from an English subject name', async () => {
    const res = await search('physics');
    expect(res.body.map((f) => f.id)).toContain(ids.arabicPhysics);
  });

  it('finds an English file from an Arabic subject name', async () => {
    const res = await search('رياضيات');
    expect(res.body.map((f) => f.id)).toContain(ids.calculus);
  });

  it('recovers from a typo the SQL LIKE net cannot catch', async () => {
    // 'thermodyanmics' is not a substring of anything in the row, so the
    // candidate query returns nothing and the fuzzy fallback has to run.
    const res = await search('thermodyanmics');
    expect(res.body[0].id).toBe(ids.thermo);
    expect(res.body[0]._fuzzy).toBe(true);
  });

  it('marks an exact hit as not fuzzy, so the page does not apologise for it', async () => {
    const res = await search('Thermodynamics');
    expect(res.body[0]._fuzzy).toBe(false);
  });

  it('ignores word order and filler words', async () => {
    const a = await search('notes for thermodynamics');
    const b = await search('thermodynamics notes');
    expect(a.body.map((f) => f.id)).toEqual(b.body.map((f) => f.id));
  });

  it('searches the AI keywords stored on the description', async () => {
    const res = await search('carnot');
    expect(res.body.map((f) => f.id)).toEqual([ids.thermo]);
  });

  it('ranks the file that matches every term first', async () => {
    const res = await search('ملخص فيزياء');
    expect(res.body[0].id).toBe(ids.arabicPhysics);
  });

  it('returns an empty list rather than the whole library for a miss', async () => {
    const res = await search('kayaking');
    expect(res.body).toEqual([]);
  });

  it('returns rows in descending score order', async () => {
    const res = await search('notes physics');
    const scores = res.body.map((f) => f._score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('still rejects an over-long query', async () => {
    const res = await search('x'.repeat(5000));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
