import '../setup/relaxAuthLimiter.js';
import request from 'supertest';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import app from '../../app.js';
import { testPool, resetDatabase, closeTestDb } from '../setup/testDb.js';
import { registerAndLogin } from '../setup/authHelpers.js';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestDb();
});

describe('GET /api/session/me', () => {
  it('requires a session', async () => {
    const res = await request(app).get('/api/session/me');
    expect(res.status).toBe(401);
  });

  it('returns the logged-in user\'s identity', async () => {
    const { agent, user } = await registerAndLogin(app);
    const res = await agent.get('/api/session/me');
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('user');
    expect(res.body.username).toBe(user.username);
    expect(typeof res.body.id).toBe('number');
  });
});

describe('GET /messages/conversations', () => {
  it('requires a session', async () => {
    const res = await request(app).get('/messages/conversations');
    expect(res.status).toBe(401);
  });

  it('is empty before any messages are exchanged', async () => {
    const { agent } = await registerAndLogin(app);
    const res = await agent.get('/messages/conversations');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('lists the other party after a message is sent, with a preview of the latest message', async () => {
    const a = await registerAndLogin(app);
    const b = await registerAndLogin(app);
    const [[bRow]] = await testPool.query('SELECT userId FROM Users WHERE username = ?', [b.user.username]);

    await a.agent.post('/add-msg').send({ receiver: bRow.userId, content: 'Hey there!' });

    const aConvos = await a.agent.get('/messages/conversations');
    expect(aConvos.status).toBe(200);
    expect(aConvos.body.length).toBe(1);
    expect(aConvos.body[0].username).toBe(b.user.username);
    expect(aConvos.body[0].lastMessage).toBe('Hey there!');

    // The recipient sees the same conversation from their side too.
    const bConvos = await b.agent.get('/messages/conversations');
    expect(bConvos.status).toBe(200);
    expect(bConvos.body.length).toBe(1);
    expect(bConvos.body[0].username).toBe(a.user.username);
  });

  it('shows only the most recent message as the preview, newest conversation first', async () => {
    const a = await registerAndLogin(app);
    const b = await registerAndLogin(app);
    const c = await registerAndLogin(app);
    const [[bRow]] = await testPool.query('SELECT userId FROM Users WHERE username = ?', [b.user.username]);
    const [[cRow]] = await testPool.query('SELECT userId FROM Users WHERE username = ?', [c.user.username]);

    await a.agent.post('/add-msg').send({ receiver: bRow.userId, content: 'first to b' });
    await a.agent.post('/add-msg').send({ receiver: cRow.userId, content: 'first to c' });
    await a.agent.post('/add-msg').send({ receiver: bRow.userId, content: 'second to b' });

    const res = await a.agent.get('/messages/conversations');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
    // Most recently touched conversation (b) comes first.
    expect(res.body[0].username).toBe(b.user.username);
    expect(res.body[0].lastMessage).toBe('second to b');
    expect(res.body[1].username).toBe(c.user.username);
  });
});

describe('GET /messages/thread/:userId', () => {
  it('requires a session', async () => {
    const res = await request(app).get('/messages/thread/1');
    expect(res.status).toBe(401);
  });

  it('rejects a non-numeric user id', async () => {
    const { agent } = await registerAndLogin(app);
    const res = await agent.get('/messages/thread/not-a-number');
    expect(res.status).toBe(400);
  });

  it('returns the merged, chronological back-and-forth between two users', async () => {
    const a = await registerAndLogin(app);
    const b = await registerAndLogin(app);
    const [[aRow]] = await testPool.query('SELECT userId FROM Users WHERE username = ?', [a.user.username]);
    const [[bRow]] = await testPool.query('SELECT userId FROM Users WHERE username = ?', [b.user.username]);

    await a.agent.post('/add-msg').send({ receiver: bRow.userId, content: 'hi b' });
    await b.agent.post('/add-msg').send({ receiver: aRow.userId, content: 'hi a' });
    await a.agent.post('/add-msg').send({ receiver: bRow.userId, content: 'how are you' });

    const res = await a.agent.get(`/messages/thread/${bRow.userId}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(3);
    expect(res.body.map((m) => m.content)).toEqual(['hi b', 'hi a', 'how are you']);
    expect(res.body.map((m) => m.direction)).toEqual(['sent', 'received', 'sent']);

    // The other party sees the same thread with sent/received flipped.
    const bRes = await b.agent.get(`/messages/thread/${aRow.userId}`);
    expect(bRes.body.map((m) => m.direction)).toEqual(['received', 'sent', 'received']);
  });

  it('does not leak a conversation between two other users', async () => {
    const a = await registerAndLogin(app);
    const b = await registerAndLogin(app);
    const eavesdropper = await registerAndLogin(app);
    const [[bRow]] = await testPool.query('SELECT userId FROM Users WHERE username = ?', [b.user.username]);

    await a.agent.post('/add-msg').send({ receiver: bRow.userId, content: 'private message' });

    const res = await eavesdropper.agent.get(`/messages/thread/${bRow.userId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
