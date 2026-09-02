import '../setup/useDatabaseStorage.js';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import '../setup/relaxAuthLimiter.js';

vi.mock('../../services/aiService.js', () => ({
    default: { generateKeywords: vi.fn().mockResolvedValue('') }
}));

import app from '../../app.js';
import { testPool, resetDatabase, closeTestDb } from '../setup/testDb.js';
import { registerAndLogin } from '../setup/authHelpers.js';
import * as storage from '../../services/fileStorage.js';
import FileBlob, { CHUNK_BYTES } from '../../models/FileBlob.js';

/**
 * Uploads kept in the database rather than on disk.
 *
 * This is what makes the app work on a free host, where the filesystem is
 * thrown away on every deploy. FILE_STORAGE=database is set by the first
 * import above, before services/fileStorage.js reads it - so these are the
 * real code paths, not a simulation of them.
 */
const PDF = path.join(process.cwd(), 'tests', 'fixtures', 'sample.pdf');
const UPLOADS = path.join(process.cwd(), 'public', 'uploads');

beforeEach(async () => { await resetDatabase(); });
afterAll(async () => { await closeTestDb(); });

async function seedCategory(name = 'General') {
    const [r] = await testPool.query('INSERT INTO Categories (name) VALUES (?)', [name]);
    return r.insertId;
}

async function upload(agent, categoryId, title = 'Lecture Notes', file = PDF) {
    return agent.post('/upload-note')
        .field('title', title).field('description', 'x')
        .field('category', String(categoryId)).attach('file', file);
}

describe('the storage layer is in database mode', () => {
    it('reports it', () => {
        expect(storage.storageMode()).toBe('database');
        expect(storage.usesDatabase()).toBe(true);
    });
});

describe('uploading', () => {
    it('stores the bytes in the database and NOT on disk', async () => {
        const categoryId = await seedCategory();
        const { agent } = await registerAndLogin(app);
        const before = fs.existsSync(UPLOADS) ? fs.readdirSync(UPLOADS) : [];

        const res = await upload(agent, categoryId);
        expect(res.status).toBeLessThan(400);

        const [[file]] = await testPool.query('SELECT id FROM Files ORDER BY id DESC LIMIT 1');
        const meta = await FileBlob.findMeta(file.id);
        expect(meta).toBeTruthy();
        expect(meta.byteSize).toBe(fs.statSync(PDF).size);
        expect(meta.mimeType).toBe('application/pdf');

        // Nothing new on disk - that is the whole point.
        const after = fs.existsSync(UPLOADS) ? fs.readdirSync(UPLOADS) : [];
        expect(after).toEqual(before);
    });

    it('reads back byte for byte', async () => {
        const categoryId = await seedCategory();
        const { agent } = await registerAndLogin(app);
        await upload(agent, categoryId);
        const [[file]] = await testPool.query('SELECT id FROM Files ORDER BY id DESC LIMIT 1');

        const stored = await storage.open(file.id);
        expect(Buffer.compare(stored.buffer, fs.readFileSync(PDF))).toBe(0);
    });
});

describe('files larger than a single database row', () => {
    // TiDB caps one row at 6 MiB and will not let the serverless tier raise
    // it, so a file has to be split. This is the test that would have caught
    // "works locally on MySQL, rejects every upload over 6 MB in production".
    it('splits a multi-megabyte file into chunks and rebuilds it exactly', async () => {
        const categoryId = await seedCategory();
        const { agent } = await registerAndLogin(app);
        const [[user]] = await testPool.query('SELECT userId FROM Users LIMIT 1');

        // 7 MiB of non-repeating bytes - larger than the row cap, and random
        // enough that a chunk written in the wrong order would be obvious.
        const big = Buffer.alloc(7 * 1024 * 1024);
        for (let i = 0; i < big.length; i += 1) big[i] = (i * 7 + (i >> 8)) & 0xff;

        const [row] = await testPool.query(
            'INSERT INTO Files (title, description, categoryID, uploadedBy) VALUES (?, ?, ?, ?)',
            ['Big.pdf', 'x', categoryId, user.userId]
        );

        await FileBlob.put(row.insertId, big, { filename: 'Big.pdf', mimeType: 'application/pdf' });

        const meta = await FileBlob.findMeta(row.insertId);
        expect(meta.chunkCount).toBe(7);
        expect(meta.byteSize).toBe(big.length);

        // Every stored piece must stay well under the 6 MiB ceiling.
        const [chunks] = await testPool.query(
            'SELECT seq, LENGTH(bytes) AS size FROM FileBlobChunks WHERE fileId = ? ORDER BY seq', [row.insertId]);
        expect(chunks).toHaveLength(7);
        chunks.forEach((c) => expect(c.size).toBeLessThanOrEqual(CHUNK_BYTES));

        expect(Buffer.compare(await FileBlob.read(row.insertId), big)).toBe(0);
    });

    it('re-storing a file replaces its chunks rather than mixing them', async () => {
        const categoryId = await seedCategory();
        await registerAndLogin(app);
        const [[user]] = await testPool.query('SELECT userId FROM Users LIMIT 1');
        const [row] = await testPool.query(
            'INSERT INTO Files (title, description, categoryID, uploadedBy) VALUES (?, ?, ?, ?)',
            ['R.pdf', 'x', categoryId, user.userId]);

        await FileBlob.put(row.insertId, Buffer.alloc(3 * 1024 * 1024, 1), { filename: 'R.pdf', mimeType: 'application/pdf' });
        await FileBlob.put(row.insertId, Buffer.alloc(1024, 2), { filename: 'R.pdf', mimeType: 'application/pdf' });

        const meta = await FileBlob.findMeta(row.insertId);
        expect(meta.chunkCount).toBe(1);
        const back = await FileBlob.read(row.insertId);
        expect(back.length).toBe(1024);
        expect(back.every((b) => b === 2)).toBe(true);
    });
});

describe('serving a stored file', () => {
    it('sends it with the right type to a logged-in user', async () => {
        const categoryId = await seedCategory();
        const { agent } = await registerAndLogin(app);
        await upload(agent, categoryId);
        const [[file]] = await testPool.query('SELECT id FROM Files ORDER BY id DESC LIMIT 1');

        const res = await agent.get(`/file-content/${file.id}`).buffer().parse((r, cb) => {
            const chunks = [];
            r.on('data', (c) => chunks.push(c));
            r.on('end', () => cb(null, Buffer.concat(chunks)));
        });

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('application/pdf');
        expect(res.headers['content-disposition']).toContain('inline');
        expect(Buffer.compare(res.body, fs.readFileSync(PDF))).toBe(0);
    });

    it('refuses an anonymous request', async () => {
        const categoryId = await seedCategory();
        const { agent } = await registerAndLogin(app);
        await upload(agent, categoryId);
        const [[file]] = await testPool.query('SELECT id FROM Files ORDER BY id DESC LIMIT 1');
        expect((await request(app).get(`/file-content/${file.id}`)).status).toBe(401);
    });

    it('says so plainly when a row has no stored contents', async () => {
        const categoryId = await seedCategory();
        const { agent } = await registerAndLogin(app);
        const [[user]] = await testPool.query('SELECT userId FROM Users LIMIT 1');
        const [row] = await testPool.query(
            'INSERT INTO Files (title, description, categoryID, uploadedBy) VALUES (?, ?, ?, ?)',
            ['Ghost.pdf', 'x', categoryId, user.userId]);

        const res = await agent.get(`/file-content/${row.insertId}`);
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('missingOnDisk');
    });
});

describe('the AI reads the stored bytes', () => {
    it('extracts text from a file that exists only in the database', async () => {
        // The AI features read the PDF to summarise and quiz it. Before the
        // storage layer they read a path, which in this mode finds nothing -
        // every summary would have come back "no text could be read".
        const categoryId = await seedCategory();
        const { agent } = await registerAndLogin(app);
        await upload(agent, categoryId);
        const [[file]] = await testPool.query('SELECT id FROM Files ORDER BY id DESC LIMIT 1');

        const { extractFileText } = await import('../../routes/aiRoutes.js');
        const text = await extractFileText(file.id);
        expect(typeof text).toBe('string');
        expect(text.length).toBeGreaterThan(0);
    });
});

describe('deleting', () => {
    it('removes the bytes along with the row', async () => {
        const categoryId = await seedCategory();
        const { agent } = await registerAndLogin(app);
        await upload(agent, categoryId);
        const [[file]] = await testPool.query('SELECT id FROM Files ORDER BY id DESC LIMIT 1');
        expect(await FileBlob.exists(file.id)).toBe(true);

        const res = await agent.delete(`/file-page-myfile/${file.id}`);
        expect(res.status).toBe(200);
        expect(await FileBlob.exists(file.id)).toBe(false);

        const [chunks] = await testPool.query('SELECT * FROM FileBlobChunks WHERE fileId = ?', [file.id]);
        expect(chunks).toHaveLength(0);
    });

    it('leaves no orphan chunks when the row is deleted directly', async () => {
        const categoryId = await seedCategory();
        const { agent } = await registerAndLogin(app);
        await upload(agent, categoryId);
        const [[file]] = await testPool.query('SELECT id FROM Files ORDER BY id DESC LIMIT 1');

        await testPool.query('DELETE FROM Files WHERE id = ?', [file.id]);

        const [blobs] = await testPool.query('SELECT * FROM FileBlobs WHERE fileId = ?', [file.id]);
        const [chunks] = await testPool.query('SELECT * FROM FileBlobChunks WHERE fileId = ?', [file.id]);
        expect(blobs).toHaveLength(0);
        expect(chunks).toHaveLength(0);
    });
});

describe('surviving a restart', () => {
    it('a file uploaded before a wipe of public/uploads still opens', async () => {
        // This is the failure mode on a free host, reproduced: the container
        // is replaced, the disk comes back empty, and the app carries on.
        const categoryId = await seedCategory();
        const { agent } = await registerAndLogin(app);
        await upload(agent, categoryId);
        const [[file]] = await testPool.query('SELECT id FROM Files ORDER BY id DESC LIMIT 1');

        if (fs.existsSync(UPLOADS)) {
            for (const name of fs.readdirSync(UPLOADS)) fs.rmSync(path.join(UPLOADS, name), { force: true });
        }

        const res = await agent.get(`/file-content/${file.id}`);
        expect(res.status).toBe(200);
    });
});
