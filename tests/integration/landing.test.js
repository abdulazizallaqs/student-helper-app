import request from 'supertest';
import fs from 'fs';
import path from 'path';
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


    it('sends the old third file listing to "For Me" as well', async () => {
        // File-page.html was a third way into the same files, beside the
        // "For Me" and "My Files" tabs - and the navbar's file icon pointed at
        // it, so which of the three you were looking at was largely luck.
        // "For Me" is the landing page after sign-in and is now the only file
        // entrance; "My Files" is one tap from it.
        const { agent } = await registerAndLogin(app);
        const res = await agent.get('/views/File-page.html');
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe(USER_HOME);
    });

    it('leaves no link in any page still pointing at a retired page', async () => {
        // A redirect keeps old bookmarks working; it is not a licence to leave
        // stale links in the app's own navigation, which would send a student
        // through a pointless extra hop on every press of the file icon.
        const viewsDir = path.join(process.cwd(), 'public', 'views');
        const offenders = [];

        for (const name of fs.readdirSync(viewsDir)) {
            if (!name.endsWith('.html')) continue;
            const html = fs.readFileSync(path.join(viewsDir, name), 'utf8');
            for (const retired of Object.keys(RETIRED_PAGES)) {
                const page = retired.split('/').pop();
                // href/src only. A comment that explains where something moved
                // FROM is documentation, not a stale link, and failing on it
                // would push people to delete the explanation to get green.
                const linked = new RegExp(`(?:href|src|action)\\s*=\\s*["'][^"']*${page.replace('.', '\\.')}`, 'i');
                if (linked.test(html)) offenders.push(`${name} -> ${page}`);
            }
        }

        expect(offenders).toEqual([]);
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
