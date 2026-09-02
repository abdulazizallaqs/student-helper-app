// Isolated in its own file so authLimiter's in-memory counter starts fresh -
// sharing this with other login tests would make both flaky depending on
// execution order.
import request from 'supertest';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import app from '../../app.js';
import { resetDatabase, closeTestDb } from '../setup/testDb.js';
import { uniqueUser } from '../setup/authHelpers.js';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestDb();
});

describe('login brute-force protection', () => {
  it('locks out further attempts after 5 failed logins from the same client', async () => {
    const user = uniqueUser();
    await request(app).post('/create-account').type('form').send(user);

    const agent = request.agent(app);
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const res = await agent.post('/').type('form').send({ username: user.username, password: 'wrong-password' });
      statuses.push(res.status);
    }

    // First 5 attempts are handled normally (redirect with an error message).
    expect(statuses.slice(0, 5).every((s) => s === 302)).toBe(true);
    // The 6th is rejected by the rate limiter itself.
    expect(statuses[5]).toBe(429);
  });
});
