import request from 'supertest';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import '../setup/relaxAuthLimiter.js';

import app from '../../app.js';
import { resetDatabase, closeTestDb } from '../setup/testDb.js';
import { registerAndLogin, uniqueUser } from '../setup/authHelpers.js';
import { USER_HOME, RETIRED_PAGES } from '../../config/appRoutes.js';

beforeEach(async () => { await resetDatabase(); });
afterAll(async () => { await closeTestDb(); });

describe('where a signed-in student lands', () => {
    it('sends them to the For Me page after a password login', async () => {
        const user = uniqueUser();
        const agent = request.agent(app);
        await agent.post('/create-account').type('form').send(user);

        const res = await agent.post('/').type('form').send({ username: user.username, password: user.password });
        expect(res.headers.location).toBe('/views/file-page-forme.html');
        expect(res.headers.location).toBe(USER_HOME);
    });

    it('sends an already-signed-in visitor there instead of the splash page', async () => {
        const { agent } = await registerAndLogin(app);
        const res = await agent.get('/');
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe(USER_HOME);
    });

    it('still shows the splash page to a visitor who is not signed in', async () => {
        const res = await request(app).get('/');
        expect(res.status).toBe(200);
        expect(res.text).toContain('<html');
    });

    it('serves that landing page to a signed-in user', async () => {
        const { agent } = await registerAndLogin(app);
        const res = await agent.get(USER_HOME);
        expect(res.status).toBe(200);
        expect(res.text).toContain('For Me');
    });

    it('does not serve it to anyone else', async () => {
        const res = await request(app).get(USER_HOME);
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/login');
    });
});

describe('the retired dashboard', () => {
    it('is gone', async () => {
        const { agent } = await registerAndLogin(app);
        const res = await agent.get('/views/User-Dashboard.html');
        // Not a 404: an old bookmark, an open tab or a phone shortcut still
        // points here, and a redirect is a better answer than a dead page.
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe(USER_HOME);
    });

    it('redirects rather than 404s even for a visitor who is not signed in', async () => {
        const res = await request(app).get('/views/User-Dashboard.html');
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe(USER_HOME);
    });

    it('does not send anyone in a circle', async () => {
        // A retired page whose replacement is itself retired would loop.
        for (const [from, to] of Object.entries(RETIRED_PAGES)) {
            expect(to).not.toBe(from);
            expect(RETIRED_PAGES[to]).toBeUndefined();
        }
    });
});

describe('the landing page carries what the dashboard used to', () => {
    it('offers the topic recommendations', async () => {
        const { agent } = await registerAndLogin(app);
        const res = await agent.get(USER_HOME);
        expect(res.text).toContain('id="recommendations"');
        expect(res.text).toContain('/api/ai/recommend');
    });

    it('offers the search box', async () => {
        const { agent } = await registerAndLogin(app);
        const res = await agent.get(USER_HOME);
        expect(res.text).toContain('input-search');
    });
});
