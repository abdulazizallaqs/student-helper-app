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

  // ---- the toggle ---------------------------------------------------------
  //
  // The bookmark is one button that both adds and removes. Pressing it a
  // second time used to send another "add", get "already in your favourites"
  // back, and change nothing on screen - a button that looked broken while
  // behaving exactly as written. Two things were missing and both are covered
  // here: a way to remove by FILE id (a list of cards never learns the
  // favoritId), and a way to ask which files are already favourited (so the
  // button knows which way it is pointing before it is pressed).

  it('reports which file ids are favourited', async () => {
    const { agent, user } = await registerAndLogin(app);
    const [[row]] = await testPool.query('SELECT userId FROM Users WHERE username = ?', [user.username]);
    const fileId = await seedFileForUser(row.userId);

    const before = await agent.get('/api/favorites/ids');
    expect(before.status).toBe(200);
    expect(before.body.fileIds).toEqual([]);

    await agent.post('/add-to-favorites').send({ fileId });

    const after = await agent.get('/api/favorites/ids');
    expect(after.body.fileIds).toEqual([fileId]);
  });

  it('requires a session to read the favourited ids', async () => {
    const res = await request(app).get('/api/favorites/ids');
    expect(res.status).toBe(401);
  });

  it('removes a favourite by file id - the second press on the bookmark', async () => {
    const { agent, user } = await registerAndLogin(app);
    const [[row]] = await testPool.query('SELECT userId FROM Users WHERE username = ?', [user.username]);
    const fileId = await seedFileForUser(row.userId);

    await agent.post('/add-to-favorites').send({ fileId });
    expect((await agent.get('/api/favorites/ids')).body.fileIds).toEqual([fileId]);

    const removeRes = await agent.delete(`/favorite/file/${fileId}`);
    expect(removeRes.status).toBe(200);
    expect(removeRes.body.removed).toBe(true);

    expect((await agent.get('/api/favorites/ids')).body.fileIds).toEqual([]);
    expect((await agent.get('/favorite')).body.some((f) => f.id === fileId)).toBe(false);
  });

  it('add, remove, add again all work - the toggle survives repetition', async () => {
    const { agent, user } = await registerAndLogin(app);
    const [[row]] = await testPool.query('SELECT userId FROM Users WHERE username = ?', [user.username]);
    const fileId = await seedFileForUser(row.userId);

    for (let round = 0; round < 3; round += 1) {
      await agent.post('/add-to-favorites').send({ fileId });
      expect((await agent.get('/api/favorites/ids')).body.fileIds).toEqual([fileId]);

      await agent.delete(`/favorite/file/${fileId}`);
      expect((await agent.get('/api/favorites/ids')).body.fileIds).toEqual([]);
    }

    // And exactly one row was ever created and destroyed, not three orphans.
    const [rows] = await testPool.query('SELECT favoritId FROM Favorit WHERE userId = ?', [row.userId]);
    expect(rows.length).toBe(0);
  });

  it('removing something that was never a favourite is not an error', async () => {
    // The caller is a toggle: its goal is the "not favourited" state, and it
    // is already there. A 404 would show the student a failure for an action
    // that did what they asked.
    const { agent, user } = await registerAndLogin(app);
    const [[row]] = await testPool.query('SELECT userId FROM Users WHERE username = ?', [user.username]);
    const fileId = await seedFileForUser(row.userId);

    const res = await agent.delete(`/favorite/file/${fileId}`);
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(false);
  });

  it("does not let one user un-favourite another user's file by file id", async () => {
    const owner = await registerAndLogin(app);
    const [[ownerRow]] = await testPool.query('SELECT userId FROM Users WHERE username = ?', [owner.user.username]);
    const fileId = await seedFileForUser(ownerRow.userId);
    await owner.agent.post('/add-to-favorites').send({ fileId });

    const intruder = await registerAndLogin(app);
    const res = await intruder.agent.delete(`/favorite/file/${fileId}`);
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(false);      // nothing of theirs to remove

    expect((await owner.agent.get('/api/favorites/ids')).body.fileIds).toEqual([fileId]);
  });

  it('requires a session to un-favourite by file id', async () => {
    const res = await request(app).delete('/favorite/file/1');
    expect(res.status).toBe(401);
  });

  it('rejects a file id that is not a number, as JSON rather than a redirect', async () => {
    // A DELETE can only come from fetch(), so a validation failure must answer
    // in JSON. It used to 302 to an HTML page, which the caller then tried to
    // parse as JSON - turning "that is not a number" into a generic failure.
    const { agent } = await registerAndLogin(app);
    const res = await agent.delete('/favorite/file/abc');
    expect(res.status).toBe(400);
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
