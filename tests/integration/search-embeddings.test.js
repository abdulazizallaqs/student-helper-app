import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * The semantic half of search, end to end against a real database.
 *
 * The one thing stubbed is the call to Google. Everything else is the real
 * path: services/searchIndexer.js writes vectors through models/FileEmbedding.js
 * into a real FileEmbeddings table, and GET /search-files reads them back,
 * blends them with the keyword score and returns the ranking.
 *
 * The stub gives each text a vector by topic, which is exactly what a real
 * embedding model does - just deterministically, so these assertions are
 * about the ranking code and never about whether Google was having a good day.
 */
const TOPICS = {
    plants: ['photosynthesis', 'chlorophyll', 'plant', 'plants', 'leaf', 'sunlight', 'food', 'grow'],
    rocks: ['igneous', 'basalt', 'rock', 'rocks', 'volcano', 'mineral'],
    money: ['inflation', 'economy', 'price', 'prices', 'currency', 'market']
};
const AXES = Object.keys(TOPICS);

/**
 * A unit vector pointing at whichever topic the text mentions most.
 *
 * There is one dimension per topic plus a final "none of the above" axis, so
 * text that matches no topic is orthogonal to every topic rather than
 * accidentally parallel to the last one.
 */
function fakeVector(text) {
    const words = String(text).toLowerCase().split(/[^a-z]+/);
    const raw = AXES.map((axis) => words.filter((word) => TOPICS[axis].includes(word)).length);
    const length = Math.hypot(...raw);
    if (!length) return [...AXES.map(() => 0), 1];
    return [...raw.map((value) => value / length), 0];
}

vi.mock('../../services/embeddingService.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        // The maths (cosine, pack/unpack, normalise) stays real; only the
        // network calls are replaced.
        isEmbeddingEnabled: () => true,
        // Three dimensions, not the real 768 - models/FileEmbedding.js stores and
        // looks up vectors by dimensionality, so the stub has to declare its own.
        embeddingDimensions: () => AXES.length + 1,
        embedQuery: async (text) => fakeVector(text),
        embedDocument: async (text) => fakeVector(text),
        embedDocuments: async (texts) => texts.map((text) => fakeVector(text)),
        default: {
            ...actual.default,
            isEmbeddingEnabled: () => true,
            embedQuery: async (text) => fakeVector(text),
            embedDocument: async (text) => fakeVector(text)
        }
    };
});

vi.mock('../../services/aiService.js', () => ({
    default: { generateKeywords: vi.fn().mockResolvedValue('') }
}));

import app from '../../app.js';
import { testPool, resetDatabase, closeTestDb } from '../setup/testDb.js';
import { registerAndLogin } from '../setup/authHelpers.js';
import { indexFile, indexMissing } from '../../services/searchIndexer.js';
import FileEmbedding from '../../models/FileEmbedding.js';

const ids = {};

async function seedFile({ title, description, category, username }) {
    const [cat] = await testPool.query(
        'INSERT INTO Categories (name) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)', [category]);
    const [user] = await testPool.query(
        'INSERT INTO Users (name, username, email, password) VALUES (?, ?, ?, ?)',
        [username, username, `${username}@example.com`, 'x']);
    const [file] = await testPool.query(
        'INSERT INTO Files (title, description, categoryID, uploadedBy) VALUES (?, ?, ?, ?)',
        [title, description, cat.insertId, user.insertId]);
    return file.insertId;
}

beforeAll(async () => {
    await resetDatabase();
    ({ agent } = await registerAndLogin(app));
    ids.photosynthesis = await seedFile({
        title: 'Photosynthesis', description: 'Chlorophyll and the light reactions.',
        category: 'Biology', username: 'ali'
    });
    ids.volcano = await seedFile({
        title: 'Igneous Rocks', description: 'Basalt, granite and how a volcano builds them.',
        category: 'Geology', username: 'sara'
    });
    ids.inflation = await seedFile({
        title: 'Inflation Explained', description: 'Why prices rise across an economy.',
        category: 'Economics', username: 'omar'
    });
    await indexMissing({ batchSize: 10, pauseMs: 0 });
});

afterAll(async () => {
    await closeTestDb();
});

// Search now requires a session (it reads the whole library and spends an
// embedding call per unique query), so the suite signs in once and searches
// as that student.
let agent;

const search = (query) => agent.get('/search-files').query({ query });

describe('the index', () => {
    it('embeds every file that had none', async () => {
        const stats = await FileEmbedding.stats();
        expect(stats.total).toBe(3);
        expect(stats.embedded).toBe(3);
        expect(stats.missing).toBe(0);
    });

    it('is idempotent - a second run has nothing to do', async () => {
        const again = await indexMissing({ batchSize: 10, pauseMs: 0 });
        expect(again.indexed).toBe(0);
    });

    it('re-indexing one file replaces its vector rather than duplicating it', async () => {
        await indexFile(ids.photosynthesis);
        const [[{ n }]] = await testPool.query(
            'SELECT COUNT(*) AS n FROM FileEmbeddings WHERE fileId = ?', [ids.photosynthesis]);
        expect(Number(n)).toBe(1);
    });
});

describe('GET /search-files with meaning', () => {
    it('finds a file that shares no word with the query', async () => {
        // Not one of "how", "do", "plants", "make", "food" appears in the
        // Photosynthesis row. Under keyword search alone this returns nothing.
        const res = await search('how do plants make food');
        expect(res.status).toBe(200);
        expect(res.body.map((f) => f.id)).toContain(ids.photosynthesis);
    });

    it('tells the page that result arrived by meaning, not by words', async () => {
        const res = await search('how do plants make food');
        const hit = res.body.find((f) => f.id === ids.photosynthesis);
        expect(hit._semantic).toBe(true);
        expect(hit._similarity).toBeGreaterThan(0.6);
    });

    it('does not drag in files about other subjects', async () => {
        const res = await search('how do plants make food');
        expect(res.body.map((f) => f.id)).not.toContain(ids.inflation);
        expect(res.body.map((f) => f.id)).not.toContain(ids.volcano);
    });

    it('still puts an exact title match first', async () => {
        const res = await search('Inflation Explained');
        expect(res.body[0].id).toBe(ids.inflation);
        expect(res.body[0]._semantic).toBe(false);
    });

    it('answers with an empty list when nothing matches either way', async () => {
        const res = await search('kayaking');
        expect(res.body).toEqual([]);
    });

    it('never returns the raw vector to the browser', async () => {
        const res = await search('how do plants make food');
        for (const row of res.body) {
            expect(row._vector).toBeUndefined();
            expect(row.vector).toBeUndefined();
        }
    });

    it('deleting a file takes its vector with it', async () => {
        const doomed = await seedFile({
            title: 'Temporary Volcano Notes', description: 'basalt', category: 'Geology', username: 'tempuser'
        });
        await indexFile(doomed);
        expect((await FileEmbedding.findByFileIds([doomed])).size).toBe(1);

        await testPool.query('DELETE FROM Files WHERE id = ?', [doomed]);
        expect((await FileEmbedding.findByFileIds([doomed])).size).toBe(0);
    });
});
