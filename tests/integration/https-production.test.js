import request from 'supertest';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { resetDatabase, closeTestDb } from '../setup/testDb.js';

beforeEach(async () => { await resetDatabase(); vi.resetModules(); });
afterAll(async () => { await closeTestDb(); });

/**
 * In production the app redirects plain HTTP to HTTPS. The platform's health
 * probe arrives over plain HTTP, from inside the network, with no
 * X-Forwarded-Proto header - so without an exemption the probe gets a 308,
 * the platform concludes the app never started, and the deploy fails with
 * nothing in the logs to explain it.
 */
describe('HTTPS redirect in production', () => {
    async function productionApp() {
        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv('SESSION_SECRET', 'a'.repeat(64));
        return (await import('../../app.js')).default;
    }

    it('lets the health probe through over plain HTTP', async () => {
        const app = await productionApp();
        const res = await request(app).get('/healthz');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
    });

    it('still forces every real page onto HTTPS', async () => {
        const app = await productionApp();
        const res = await request(app).get('/login');
        expect(res.status).toBe(308);
        expect(res.headers.location).toMatch(/^https:\/\//);
    });

    it('serves normally once the proxy says the request was HTTPS', async () => {
        const app = await productionApp();
        const res = await request(app).get('/login').set('X-Forwarded-Proto', 'https');
        expect(res.status).toBe(200);
    });
});
