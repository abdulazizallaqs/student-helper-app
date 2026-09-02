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

async function seedFileForUser(uploaderId) {
  const [category] = await testPool.query('INSERT INTO Categories (name) VALUES (?)', ['General']);
  const [result] = await testPool.query(
    'INSERT INTO Files (categoryID, title, description, uploadedBy) VALUES (?, ?, ?, ?)',
    [category.insertId, 'Some Notes.pdf', 'seeded file', uploaderId]
  );
  return result.insertId;
}

describe('favorites', () => {
  it('requires a session to add a favorite', async () => {
    const res = await request(app).post('/add-to-favorites').send({ fileId: 1 });
    expect(res.status).toBe(401);
  });

  it('lets a logged-in user add and then see a favorite', async () => {
    const { agent, user } = await registerAndLogin(app);
    const [[row]] = await testPool.query('SELECT userId FROM Users WHERE username = ?', [user.username]);
    const fileId = await seedFileForUser(row.userId);

    const addRes = await agent.post('/add-to-favorites').send({ fileId });
    expect(addRes.status).toBe(200);

    const listRes = await agent.get('/favorite');
    expect(listRes.status).toBe(200);
    expect(listRes.body.some((f) => f.id === fileId)).toBe(true);
  });

  it('requires a session to remove a favorite', async () => {
    const res = await request(app).delete('/favorite/1');
    expect(res.status).toBe(401);
  });

  it('adding the same favorite twice does not create a duplicate row', async () => {
    const { agent, user } = await registerAndLogin(app);
    const [[row]] = await testPool.query('SELECT userId FROM Users WHERE username = ?', [user.username]);
    const fileId = await seedFileForUser(row.userId);

    const first = await agent.post('/add-to-favorites').send({ fileId });
    expect(first.status).toBe(200);
    expect(first.body.alreadyExists).toBe(false);

    const second = await agent.post('/add-to-favorites').send({ fileId });
    expect(second.status).toBe(200);
    expect(second.body.alreadyExists).toBe(true);

    const [rows] = await testPool.query('SELECT favoritId FROM Favorit WHERE userId = ? AND fileId = ?', [row.userId, fileId]);
    expect(rows.length).toBe(1);

    const listRes = await agent.get('/favorite');
    expect(listRes.body.filter((f) => f.id === fileId).length).toBe(1);
  });

  it("does not let one user delete another user's favorite", async () => {
    const owner = await registerAndLogin(app);
    const [[ownerRow]] = await testPool.query('SELECT userId FROM Users WHERE username = ?', [owner.user.username]);
    const fileId = await seedFileForUser(ownerRow.userId);
    await owner.agent.post('/add-to-favorites').send({ fileId });

    const [[fav]] = await testPool.query('SELECT favoritId FROM Favorit WHERE userId = ?', [ownerRow.userId]);

    const intruder = await registerAndLogin(app);
    const deleteRes = await intruder.agent.delete(`/favorite/${fav.favoritId}`);
    expect(deleteRes.status).toBe(404);

    const stillThere = await owner.agent.get('/favorite');
    expect(stillThere.body.some((f) => f.id === fileId)).toBe(true);
  });

  it('lets the owner delete their own favorite', async () => {
    const { agent, user } = await registerAndLogin(app);
    const [[row]] = await testPool.query('SELECT userId FROM Users WHERE username = ?', [user.username]);
    const fileId = await seedFileForUser(row.userId);
    await agent.post('/add-to-favorites').send({ fileId });

    const [[fav]] = await testPool.query('SELECT favoritId FROM Favorit WHERE userId = ?', [row.userId]);
    const deleteRes = await agent.delete(`/favorite/${fav.favoritId}`);
    expect(deleteRes.status).toBe(200);

    const listRes = await agent.get('/favorite');
    expect(listRes.body.some((f) => f.id === fileId)).toBe(false);
  });
});

describe('file chat', () => {
  it('lets a logged-in user read a file\'s chat history', async () => {
    const { agent, user } = await registerAndLogin(app);
    const [[row]] = await testPool.query('SELECT userId FROM Users WHERE username = ?', [user.username]);
    const fileId = await seedFileForUser(row.userId);

    await agent.post('/add-chat').send({ fileId, chatText: 'Great notes, thanks!' });

    const res = await agent.get(`/file-chats/${fileId}`);
    expect(res.status).toBe(200);
    expect(res.body.some((c) => c.content.includes('Great notes'))).toBe(true);
  });

  // Regression: reading comments used to require no session at all. Because
  // fileId is a sequential integer, an anonymous visitor could walk
  // /file-chats/1,2,3... and scrape every comment (and commenter username) in
  // the system, even though the files themselves are login-gated.
  it('requires a session to READ a file\'s chat history', async () => {
    const { agent, user } = await registerAndLogin(app);
    const [[row]] = await testPool.query('SELECT userId FROM Users WHERE username = ?', [user.username]);
    const fileId = await seedFileForUser(row.userId);
    await agent.post('/add-chat').send({ fileId, chatText: 'private-ish comment' });

    const res = await request(app).get(`/file-chats/${fileId}`);
    expect(res.status).toBe(401);
  });

  it('requires a session to post a chat message', async () => {
    const res = await request(app).post('/add-chat').send({ fileId: 1, chatText: 'hi' });
    expect(res.status).toBe(401);
  });

  it('rejects an empty chat message', async () => {
    const { agent, user } = await registerAndLogin(app);
    const [[row]] = await testPool.query('SELECT userId FROM Users WHERE username = ?', [user.username]);
    const fileId = await seedFileForUser(row.userId);

    const res = await agent.post('/add-chat').send({ fileId, chatText: '' });
    expect(res.status).toBe(400);
  });
});
