import request from 'supertest';
import { describe, it, expect, afterAll } from 'vitest';
import app from '../../app.js';
import { closeTestDb } from '../setup/testDb.js';

afterAll(async () => {
  await closeTestDb();
});

describe('legal pages', () => {
  it('serves the privacy policy without requiring login', async () => {
    const res = await request(app).get('/privacy-policy');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/سياسة الخصوصية|privacy/i);
  });

  it('serves the terms of service without requiring login', async () => {
    const res = await request(app).get('/terms-of-service');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/شروط الاستخدام|terms/i);
  });
});
