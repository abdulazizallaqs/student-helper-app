import request from 'supertest';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import app from '../../app.js';
import { testPool, resetDatabase, closeTestDb } from '../setup/testDb.js';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestDb();
});

async function seedLegacyPlaintextAdmin(username, password) {
  const [result] = await testPool.query('INSERT INTO Admin (username, password) VALUES (?, ?)', [username, password]);
  return result.insertId;
}

describe('admin login', () => {
  it('logs in with a legacy plaintext password and upgrades it to a bcrypt hash', async () => {
    await seedLegacyPlaintextAdmin('root_admin', 'oldPlainPassword');

    const res = await request(app).post('/').type('form').send({ username: 'root_admin', password: 'oldPlainPassword' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin-dashboard');

    const [[row]] = await testPool.query('SELECT password FROM Admin WHERE username = ?', ['root_admin']);
    expect(row.password).not.toBe('oldPlainPassword');
    expect(row.password).toMatch(/^\$2[aby]\$/);
  });

  it('logs in with an already-hashed password on a second attempt (no double-hashing)', async () => {
    await seedLegacyPlaintextAdmin('root_admin2', 'oldPlainPassword');
    await request(app).post('/').type('form').send({ username: 'root_admin2', password: 'oldPlainPassword' });

    const res = await request(app).post('/').type('form').send({ username: 'root_admin2', password: 'oldPlainPassword' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin-dashboard');
  });

  it('rejects a wrong password and leaves the stored password untouched', async () => {
    await seedLegacyPlaintextAdmin('root_admin3', 'oldPlainPassword');

    const res = await request(app).post('/').type('form').send({ username: 'root_admin3', password: 'wrong' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error');

    const [[row]] = await testPool.query('SELECT password FROM Admin WHERE username = ?', ['root_admin3']);
    expect(row.password).toBe('oldPlainPassword');
  });

  it('rejects an unknown admin username', async () => {
    const res = await request(app).post('/').type('form').send({ username: 'nobody', password: 'whatever' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error');
  });
});
