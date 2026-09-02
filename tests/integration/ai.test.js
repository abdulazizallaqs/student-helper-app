// This file now performs more than five real logins in one run, which the
// production login limiter (max 5 / 15 min) would block. Must be imported
// BEFORE app.js - see the note in relaxAuthLimiter.js.
import '../setup/relaxAuthLimiter.js';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';

// No test in this file should ever reach the real Gemini API - mock the
// whole service so these tests are fast, free, and deterministic.
// The named exports matter as much as the default one: routes/aiRoutes.js
// does `error instanceof AiError` when a call fails, and `instanceof
// undefined` is a TypeError - a mock missing them would turn every AI error
// into a crash inside the error handler.
// The class is declared INSIDE the factory on purpose: vi.mock is hoisted to
// the top of the file, so a class declared above it is still in its temporal
// dead zone when the factory runs.
vi.mock('../../services/aiService.js', () => ({
  AiError: class AiError extends Error {
    constructor(message, { status = 502, code = 'ai_error', detail = '' } = {}) {
      super(message);
      this.name = 'AiError';
      this.status = status;
      this.code = code;
      this.detail = detail;
    }
  },
  isAiConfigured: true,
  describeApiKey: () => ({ ok: true, kind: 'standard', message: 'mocked' }),
  listAvailableModels: vi.fn().mockResolvedValue(['gemini-test']),
  activeModelName: () => 'gemini-test',
  default: {
    generateQuiz: vi.fn().mockResolvedValue([
      { question: 'What is covered in these notes?', options: ['A', 'B', 'C', 'D'], correctIndex: 0 },
    ]),
    generateFlashcards: vi.fn().mockResolvedValue([{ front: 'Term', back: 'Definition' }]),
    generateChatResponse: vi.fn().mockResolvedValue('a plain text reply'),
    summarizeText: vi.fn().mockResolvedValue('a plain text summary'),
    getRecommendations: vi.fn().mockResolvedValue('["algebra"]'),
    generateKeywords: vi.fn().mockResolvedValue('kw'),
    selfTest: vi.fn().mockResolvedValue({ ok: true, model: 'gemini-test', reply: 'OK' }),
  },
}));

import app from '../../app.js';
import { testPool, resetDatabase, closeTestDb } from '../setup/testDb.js';
import { registerAndLogin } from '../setup/authHelpers.js';

const PDF_FIXTURE = path.join(process.cwd(), 'tests', 'fixtures', 'sample.pdf');
const TXT_FIXTURE = path.join(process.cwd(), 'tests', 'fixtures', 'sample.txt');
let filesToCleanUp = [];

beforeEach(async () => {
  await resetDatabase();
  filesToCleanUp = [];
});

afterEach(() => {
  for (const p of filesToCleanUp) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
});

afterAll(async () => {
  await closeTestDb();
});

async function seedFile(uploaderId, { title, fixture }) {
  const [category] = await testPool.query('INSERT INTO Categories (name) VALUES (?)', ['General']);
  const [result] = await testPool.query(
    'INSERT INTO Files (categoryID, title, description, uploadedBy) VALUES (?, ?, ?, ?)',
    [category.insertId, title, 'seeded for ai test', uploaderId]
  );
  const fileId = result.insertId;
  const diskPath = path.join(process.cwd(), 'public', 'uploads', `${fileId}-${title}`);
  fs.copyFileSync(fixture, diskPath);
  filesToCleanUp.push(diskPath);
  return fileId;
}

describe('POST /api/ai/quiz/:fileId', () => {
  it('requires a session', async () => {
    const res = await request(app).post('/api/ai/quiz/1');
    expect(res.status).toBe(401);
  });

  it('404s for a file that does not exist', async () => {
    const { agent } = await registerAndLogin(app);
    const res = await agent.post('/api/ai/quiz/999999');
    expect(res.status).toBe(404);
  });

  it('returns 400 for a file type other than PDF', async () => {
    const { agent, user } = await registerAndLogin(app);
    const [[row]] = await testPool.query('SELECT userId FROM Users WHERE username = ?', [user.username]);
    const fileId = await seedFile(row.userId, { title: 'notes.txt', fixture: TXT_FIXTURE });

    const res = await agent.post(`/api/ai/quiz/${fileId}`);
    expect(res.status).toBe(400);
  });

  it('returns a generated quiz for a seeded PDF', async () => {
    const { agent, user } = await registerAndLogin(app);
    const [[row]] = await testPool.query('SELECT userId FROM Users WHERE username = ?', [user.username]);
    const fileId = await seedFile(row.userId, { title: 'notes.pdf', fixture: PDF_FIXTURE });

    const res = await agent.post(`/api/ai/quiz/${fileId}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.quiz)).toBe(true);
    expect(res.body.quiz[0]).toHaveProperty('question');
    expect(res.body.quiz[0]).toHaveProperty('options');
  });
});

describe('AI text endpoints return PLAIN TEXT, not HTML', () => {
  // The chat and summary endpoints used to run the model's reply through
  // markdown-it and return HTML, while both pages insert the value with
  // textContent (correctly - an AI reply is untrusted). The result was that
  // every answer appeared on screen as literal markup: "<p>Here is...</p>".
  it('POST /api/ai/chat returns text with no HTML tags', async () => {
    const { agent } = await registerAndLogin(app);
    const res = await agent.post('/api/ai/chat').send({ message: 'hello' });

    expect(res.status).toBe(200);
    expect(res.body.response).toBe('a plain text reply');
    expect(res.body.response).not.toMatch(/<\/?[a-z][\s\S]*>/i);
  });

  it('POST /api/ai/summarize returns text with no HTML tags', async () => {
    const { agent } = await registerAndLogin(app);
    const res = await agent.post('/api/ai/summarize').send({ text: 'some long notes' });

    expect(res.status).toBe(200);
    expect(res.body.summary).toBe('a plain text summary');
    expect(res.body.summary).not.toMatch(/<\/?[a-z][\s\S]*>/i);
  });

  it('rejects an empty chat message before calling the model', async () => {
    const { agent } = await registerAndLogin(app);
    const res = await agent.post('/api/ai/chat').send({ message: '   ' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/ai/summarize/:fileId - the card "Sum" button', () => {
  it('requires a session', async () => {
    const res = await request(app).post('/api/ai/summarize/1');
    expect(res.status).toBe(401);
  });

  it('404s a file that does not exist', async () => {
    const { agent } = await registerAndLogin(app);
    const res = await agent.post('/api/ai/summarize/999999');
    expect(res.status).toBe(404);
  });

  it('summarizes the FILE itself, not the one-line description', async () => {
    const { agent, user } = await registerAndLogin(app);
    const [[row]] = await testPool.query('SELECT userId FROM Users WHERE username = ?', [user.username]);
    const fileId = await seedFile(row.userId, { title: 'lecture.pdf', fixture: PDF_FIXTURE });

    const res = await agent.post(`/api/ai/summarize/${fileId}`).send({ fallbackText: 'seeded for ai test' });

    expect(res.status).toBe(200);
    expect(res.body.summary).toBe('a plain text summary');
    expect(res.body.title).toBe('lecture.pdf');
    // 'file' means the PDF's own text was extracted and summarized - the old
    // button only ever sent the card's description.
    expect(res.body.source).toBe('file');
  });

  it('falls back to the supplied text for a file with no extractable text', async () => {
    const { agent, user } = await registerAndLogin(app);
    const [[row]] = await testPool.query('SELECT userId FROM Users WHERE username = ?', [user.username]);
    const fileId = await seedFile(row.userId, { title: 'scan.txt', fixture: TXT_FIXTURE });

    const res = await agent.post(`/api/ai/summarize/${fileId}`)
      .send({ fallbackText: 'A long-enough description to summarize.' });

    expect(res.status).toBe(200);
    expect(res.body.source).toBe('description');
  });
});

describe('AI errors reach the browser, not just the server log', () => {
  // Every AI problem in this project so far has been diagnosed by reading one
  // line in the terminal that nobody looking at the page can see.
  it('includes the underlying detail in development', async () => {
    const aiService = (await import('../../services/aiService.js')).default;
    const { AiError } = await import('../../services/aiService.js');
    aiService.summarizeText.mockRejectedValueOnce(
      new AiError('Google rejected the request (HTTP 400). Unknown name "foo".',
        { status: 502, code: 'bad_request', detail: '{"error":{"message":"Unknown name \"foo\"."}}' })
    );

    const { agent } = await registerAndLogin(app);
    const res = await agent.post('/api/ai/summarize').send({ text: 'notes' });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('bad_request');
    expect(res.body.message).toContain('400');
    expect(res.body.detail).toContain('Unknown name');
  });

  it('withholds the detail in production', async () => {
    // Asserted against the rule itself rather than a live production server:
    // in production the app refuses plain-HTTP requests, so supertest cannot
    // even register a user to reach an AI route.
    const { buildAiErrorBody } = await import('../../routes/aiRoutes.js');
    const { AiError } = await import('../../services/aiService.js');

    const failure = new AiError('Google rejected the request.', {
      status: 502, code: 'bad_request', detail: 'internal-host-name and project id',
    });

    const dev = buildAiErrorBody(failure, true);
    expect(dev.body.detail).toContain('internal-host-name');

    // An upstream body can name internal hosts and project ids.
    const prod = buildAiErrorBody(failure, false);
    expect(prod.status).toBe(502);
    expect(prod.body.message).toBe('Google rejected the request.');
    expect(prod.body.detail).toBeUndefined();
  });

  it('reports a bug in our own code as internal, not as an upstream failure', async () => {
    const { buildAiErrorBody } = await import('../../routes/aiRoutes.js');
    const { status, body } = buildAiErrorBody(new TypeError('x is not a function'), true);

    expect(status).toBe(500);
    expect(body.error).toBe('internal');
    expect(body.detail).toContain('x is not a function');
  });
});

describe('GET /api/ai/health', () => {
  it('requires a session', async () => {
    const res = await request(app).get('/api/ai/health');
    expect(res.status).toBe(401);
  });

  it('reports the key and model state to a logged-in user', async () => {
    const { agent } = await registerAndLogin(app);
    const res = await agent.get('/api/ai/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ keyOk: true, reachable: true, model: 'gemini-test' });
    // The key itself must never be echoed back.
    expect(JSON.stringify(res.body)).not.toMatch(/AIza|AQ\./);
  });
});

describe('POST /api/ai/flashcards/:fileId', () => {
  it('returns generated flashcards for a seeded PDF', async () => {
    const { agent, user } = await registerAndLogin(app);
    const [[row]] = await testPool.query('SELECT userId FROM Users WHERE username = ?', [user.username]);
    const fileId = await seedFile(row.userId, { title: 'notes2.pdf', fixture: PDF_FIXTURE });

    const res = await agent.post(`/api/ai/flashcards/${fileId}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.flashcards)).toBe(true);
    expect(res.body.flashcards[0]).toHaveProperty('front');
    expect(res.body.flashcards[0]).toHaveProperty('back');
  });
});
