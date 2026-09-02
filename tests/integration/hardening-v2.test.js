import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import '../setup/relaxAuthLimiter.js';

import app from '../../app.js';
import { testPool, resetDatabase, closeTestDb } from '../setup/testDb.js';
import { registerAndLogin } from '../setup/authHelpers.js';

/**
 * Regressions for the four holes found in the pre-release audit. Each of these
 * was reproduced against the running app before it was closed.
 */

const UPLOADS = path.join(process.cwd(), 'public', 'uploads');
const PDF = path.join(process.cwd(), 'tests', 'fixtures', 'sample.pdf');
let planted = [];

function uploadsSnapshot() {
    return fs.existsSync(UPLOADS) ? fs.readdirSync(UPLOADS).sort() : [];
}

beforeEach(async () => {
    await resetDatabase();
    planted = [];
});

afterEach(() => {
    for (const p of planted) if (fs.existsSync(p)) fs.unlinkSync(p);
});

afterAll(async () => { await closeTestDb(); });

async function seedCategory(name = 'General') {
    const [r] = await testPool.query('INSERT INTO Categories (name) VALUES (?)', [name]);
    return r.insertId;
}

function track(before) {
    for (const name of uploadsSnapshot()) {
        if (!before.includes(name)) planted.push(path.join(UPLOADS, name));
    }
}

describe('stored XSS through the upload form', () => {
    it('rejects an HTML file that claims to be a PDF', async () => {
        // multer's fileFilter used to trust file.mimetype, which is a header
        // the uploading client writes. An attacker uploaded an HTML page as
        // "application/pdf" with the title "notes.html"; it was stored as
        // <id>-notes.html and express.static handed it back as text/html from
        // this origin, so its inline script ran with the viewer's session.
        const categoryId = await seedCategory();
        const { agent } = await registerAndLogin(app);
        const before = uploadsSnapshot();

        const res = await agent
            .post('/upload-note')
            .field('title', 'lecture-notes.html')
            .field('description', 'looks harmless')
            .field('category', String(categoryId))
            .attach('file', Buffer.from('<script>alert(1)</script>'), {
                filename: 'evil.html', contentType: 'application/pdf'
            });

        track(before);
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/\.pdf extension/i);
        expect(uploadsSnapshot()).toEqual(before);
    });

    it('rejects a disallowed type with a 400, not a 500 stack trace', async () => {
        const categoryId = await seedCategory();
        const { agent } = await registerAndLogin(app);
        const before = uploadsSnapshot();

        const res = await agent
            .post('/upload-note')
            .field('title', 'script')
            .field('description', 'x')
            .field('category', String(categoryId))
            .attach('file', Buffer.from('#!/bin/sh'), { filename: 'x.sh', contentType: 'text/x-sh' });

        track(before);
        expect(res.status).toBe(400);
        expect(res.text).not.toMatch(/at .*\.js:\d+/);
    });

    it('still accepts a real PDF', async () => {
        const categoryId = await seedCategory();
        const { agent } = await registerAndLogin(app);
        const before = uploadsSnapshot();

        const res = await agent
            .post('/upload-note')
            .field('title', 'Real Notes')
            .field('description', 'x')
            .field('category', String(categoryId))
            .attach('file', PDF);

        track(before);
        expect(res.status).toBeLessThan(400);
    });

    it('serves anything under /uploads as a download that cannot script', async () => {
        const categoryId = await seedCategory();
        const { agent } = await registerAndLogin(app);
        const before = uploadsSnapshot();
        await agent.post('/upload-note')
            .field('title', 'Real Notes').field('description', 'x')
            .field('category', String(categoryId)).attach('file', PDF);
        track(before);

        const stored = uploadsSnapshot().find((n) => !before.includes(n));
        const res = await agent.get(`/uploads/${encodeURIComponent(stored)}`);
        expect(res.status).toBe(200);
        expect(res.headers['content-disposition']).toBe('attachment');
        expect(res.headers['content-security-policy']).toContain('sandbox');
        expect(res.headers['x-content-type-options']).toBe('nosniff');
    });
});

describe('writing to disk without a session', () => {
    it('does not let an anonymous POST leave a file behind', async () => {
        // multer streams the body to public/uploads/ while parsing, so with
        // the session check inside the controller an anonymous 10 MB POST was
        // written to disk before it was refused.
        const before = uploadsSnapshot();

        const res = await request(app)
            .post('/upload-note')
            .field('title', 'anon')
            .field('description', 'x')
            .field('category', '1')
            .attach('file', PDF);

        track(before);
        expect(res.status).toBe(401);
        expect(uploadsSnapshot()).toEqual(before);
    });
});

describe('endpoints that spend money or read the library', () => {
    it('refuses an anonymous search', async () => {
        const res = await request(app).get('/search-files').query({ query: 'physics' });
        expect(res.status).toBe(401);
    });

    it('refuses anonymous file metadata', async () => {
        const res = await request(app).get('/file/1');
        expect(res.status).toBe(401);
    });

    it('refuses an anonymous category listing', async () => {
        const res = await request(app).get('/categories');
        expect(res.status).toBe(401);
    });

    it('still serves all three to a signed-in student', async () => {
        await seedCategory('Physics');
        const { agent } = await registerAndLogin(app);
        expect((await agent.get('/categories')).status).toBe(200);
        expect((await agent.get('/search-files').query({ query: 'physics' })).status).toBe(200);
    });
});

describe('the /views guard and percent-encoding', () => {
    it('does not hand the admin dashboard to a student who escapes a character', async () => {
        // express.static decodes the URL before resolving the file, but the
        // guard compared the raw path - so /views/admin%2Ddashboard.html did
        // not match 'admin-dashboard.html', fell through, and was then served.
        const { agent } = await registerAndLogin(app);

        const plain = await agent.get('/views/admin-dashboard.html');
        const encoded = await agent.get('/views/admin%2Ddashboard.html');

        expect(plain.status).toBe(302);
        expect(encoded.status).toBe(302);
        expect(encoded.text).not.toContain('Admin Dashboard');
    });

    it('blocks an encoded private page for an anonymous visitor too', async () => {
        const res = await request(app).get('/views/ai%2Dbuddy.html');
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/login');
    });

    it('rejects a malformed escape instead of guessing', async () => {
        const res = await request(app).get('/views/%E0%A4%A.html');
        expect(res.status).toBe(400);
    });

    it('still serves the genuinely public pages', async () => {
        for (const page of ['user-login.html', 'create-account.html', 'privacy-policy.html']) {
            const res = await request(app).get(`/views/${page}`);
            expect(res.status).toBe(200);
        }
    });
});

describe('the published example environment file', () => {
    it('ships no real API key', () => {
        // .env.example is committed; .env is not. A working key was sitting in
        // the example file, which would have been published with the repo.
        const example = fs.readFileSync(path.join(process.cwd(), '.env.example'), 'utf-8');
        for (const line of example.split('\n')) {
            const [key, ...rest] = line.split('=');
            if (!/KEY|SECRET|PASSWORD|TOKEN/i.test(key)) continue;
            const value = rest.join('=').trim();
            expect(value === '' || /^(your_|<|changeme|example)/i.test(value)).toBe(true);
        }
        expect(example).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
        expect(example).not.toMatch(/AQ\.[A-Za-z0-9_-]{20,}/);
    });
});
