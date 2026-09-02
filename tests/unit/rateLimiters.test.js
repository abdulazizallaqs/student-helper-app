// Unit tests for middleware/rateLimiters.js. authLimiter's cap (5 requests /
// 15 min) is small enough to actually trigger in a test; generalLimiter and
// aiLimiter are only checked structurally (firing 300+ requests per test run
// would be wasteful and slow).
import express from 'express';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { generalLimiter, authLimiter, aiLimiter } from '../../middleware/rateLimiters.js';

describe('rate limiter middleware shape', () => {
  it('exports callable Express middleware for each limiter', () => {
    expect(typeof generalLimiter).toBe('function');
    expect(typeof authLimiter).toBe('function');
    expect(typeof aiLimiter).toBe('function');
  });
});

describe('authLimiter', () => {
  it('blocks with 429 after 5 requests from the same client within the window', async () => {
    const app = express();
    app.use(authLimiter);
    app.get('/login-attempt', (req, res) => res.status(200).json({ ok: true }));

    const agent = request.agent(app);
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const res = await agent.get('/login-attempt');
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });
});
