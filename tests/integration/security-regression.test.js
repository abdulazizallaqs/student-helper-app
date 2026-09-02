// Regression suite for bugs found during a whitebox + blackbox audit.
//
// Every test here failed against the code as it stood before the audit. They
// exist so these specific defects cannot silently come back: each one is a
// real exploit or a real broken user journey, reproduced end-to-end over HTTP
// exactly the way it was originally confirmed.
import '../setup/relaxAuthLimiter.js';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
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

async function userIdOf(username) {
  const [[row]] = await testPool.query('SELECT userId FROM Users WHERE username = ?', [username]);
  return row.userId;
}

async function seedCategory(name = 'General') {
  const [category] = await testPool.query('INSERT INTO Categories (name) VALUES (?)', [name]);
  return category.insertId;
}

async function seedFileForUser(uploaderId, title = 'Some Notes.pdf') {
  const categoryId = await seedCategory();
  const [result] = await testPool.query(
    'INSERT INTO Files (categoryID, title, description, uploadedBy) VALUES (?, ?, ?, ?)',
    [categoryId, title, 'seeded file', uploaderId]
  );
  return result.insertId;
}

// ---------------------------------------------------------------------------
describe('access control regressions', () => {
  // Was: GET /msg returned the entire Users table (name, username, email) to
  // anyone, with no cookie. messageRoutes mounts ahead of app.js's catch-all
  // session gate, so nothing else was stopping it.
  it('does not expose the user directory to anonymous callers', async () => {
    await registerAndLogin(app);

    const res = await request(app).get('/msg');

    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toMatch(/@example\.com/);
  });

  it('still returns the user directory to a logged-in user', async () => {
    const { agent } = await registerAndLogin(app);
    const res = await agent.get('/msg');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  // Was: express.static served /public before any guard ran, so every view was
  // reachable at its direct URL - including the admin dashboard.
  it('does not serve the admin dashboard HTML to an anonymous visitor', async () => {
    const res = await request(app).get('/views/admin-dashboard.html');
    expect(res.status).not.toBe(200);
  });

  it('does not serve a logged-in-only page to an anonymous visitor', async () => {
    const res = await request(app).get('/views/ai-buddy.html');
    expect(res.status).not.toBe(200);
  });

  it('still serves genuinely public pages to anonymous visitors', async () => {
    for (const page of ['user-login.html', 'create-account.html', 'splash.html']) {
      const res = await request(app).get(`/views/${page}`);
      expect(res.status, `${page} should stay public`).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
describe('file ownership (IDOR) regressions', () => {
  // Was: File.update had no owner scoping at all, so any logged-in user could
  // rewrite the title/description/category of ANY file by id and got a 200.
  it("does not let a user overwrite another user's file", async () => {
    const alice = await registerAndLogin(app);
    const bob = await registerAndLogin(app);
    const aliceId = await userIdOf(alice.user.username);
    const fileId = await seedFileForUser(aliceId, 'alice-notes.pdf');

    const res = await bob.agent
      .put(`/update-file/${fileId}`)
      .send({ title2: 'HACKED by bob', description2: 'pwned' });

    expect(res.status).toBe(404);

    const [[row]] = await testPool.query('SELECT title, description FROM Files WHERE id = ?', [fileId]);
    expect(row.title).toBe('alice-notes.pdf');
    expect(row.description).toBe('seeded file');
  });

  it('still lets the owner update their own file', async () => {
    const alice = await registerAndLogin(app);
    const aliceId = await userIdOf(alice.user.username);
    const fileId = await seedFileForUser(aliceId);

    const res = await alice.agent
      .put(`/update-file/${fileId}`)
      .send({ title2: 'My Renamed Notes.pdf' });

    expect(res.status).toBe(200);
    const [[row]] = await testPool.query('SELECT title FROM Files WHERE id = ?', [fileId]);
    expect(row.title).toBe('My Renamed Notes.pdf');
  });

  // Was: File.delete threw for "not found or unauthorized", which the
  // controller turned into a 500 carrying that internal sentence.
  it("returns 404 (not 500) when deleting a file that isn't yours", async () => {
    const alice = await registerAndLogin(app);
    const bob = await registerAndLogin(app);
    const aliceId = await userIdOf(alice.user.username);
    const fileId = await seedFileForUser(aliceId);

    const res = await bob.agent.delete(`/file-page-myfile/${fileId}`);

    expect(res.status).toBe(404);
    const [[row]] = await testPool.query('SELECT COUNT(*) AS c FROM Files WHERE id = ?', [fileId]);
    expect(row.c).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('error-disclosure regressions', () => {
  // Was: models interpolate the raw driver error into their message, and
  // controllers pass that straight to AppError(…, 500) with isOperational
  // defaulting to true - so a bad FK returned the database name, table name
  // and constraint name to the client.
  it('does not leak database internals in a 500 response', async () => {
    const { agent } = await registerAndLogin(app);

    const res = await agent.post('/add-chat').send({ fileId: 999999999, chatText: 'hi' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/foreign key/i);
    expect(body).not.toMatch(/constraint/i);
    expect(body).not.toMatch(/chats_ibfk/i);
    expect(body).not.toMatch(/Student_Helper/i);
  });
});

// ---------------------------------------------------------------------------
describe('data-integrity regressions', () => {
  // Was: express-validator's .escape() mutates req.body, so the ESCAPED text
  // was what got written to the database. "Ann's & Bob's notes" was stored as
  // "Ann&#x27;s &amp; Bob&#x27;s notes" and shown that way forever.
  it('stores user text verbatim rather than HTML-escaped', async () => {
    const { agent, user } = await registerAndLogin(app);
    const uid = await userIdOf(user.username);
    const fileId = await seedFileForUser(uid);

    const raw = "Ann's & Bob's notes";
    const res = await agent.post('/add-chat').send({ fileId, chatText: raw });
    expect(res.status).toBe(200);

    const [[row]] = await testPool.query(
      'SELECT content FROM chats WHERE fileID = ? ORDER BY id DESC LIMIT 1', [fileId]
    );
    expect(row.content).toBe(raw);
    expect(row.content).not.toMatch(/&#x27;|&amp;/);
  });

  // Was: SELECT-then-INSERT with no UNIQUE constraint behind it, so concurrent
  // requests both inserted and the file appeared twice in the favorites list.
  it('does not create duplicate favorites under concurrent requests', async () => {
    const { agent, user } = await registerAndLogin(app);
    const uid = await userIdOf(user.username);
    const fileId = await seedFileForUser(uid);

    const responses = await Promise.all([
      agent.post('/add-to-favorites').send({ fileId }),
      agent.post('/add-to-favorites').send({ fileId }),
      agent.post('/add-to-favorites').send({ fileId }),
    ]);

    // None of them should fail - the duplicates are absorbed, not errors.
    responses.forEach(r => expect(r.status).toBeLessThan(400));

    const [[row]] = await testPool.query(
      'SELECT COUNT(*) AS c FROM Favorit WHERE userId = ? AND fileId = ?', [uid, fileId]
    );
    expect(row.c).toBe(1);
  });

  // Was: validateSearch was imported in fileRoutes.js but never applied, so
  // the search term was entirely unbounded.
  it('rejects an unbounded search term', async () => {
    const res = await request(app).get('/search-files').query({ query: 'x'.repeat(5000) });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

// ---------------------------------------------------------------------------
describe('broken user-journey regressions', () => {
  // Was: profile.html fetched /profile, which serves the HTML page itself, so
  // response.json() threw and no field was ever filled in. The JSON endpoint
  // also returned only { files }, never the identity fields the page wanted.
  it('serves the profile page its identity fields as JSON, without the password', async () => {
    const { agent, user } = await registerAndLogin(app);

    const res = await agent.get('/profile-data');

    expect(res.status).toBe(200);
    expect(res.body.username).toBe(user.username);
    expect(res.body.email).toBe(user.email);
    expect(res.body.name).toBeDefined();
    expect(res.body.password).toBeUndefined();
  });

  it('does not reference the nonexistent /get-file/ route from the edit modal', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'public', 'js', 'displayChat.js'), 'utf8'
    );
    // A real fetch() call to the dead route - not the comment explaining it.
    expect(/fetch\(\s*[`'"]\/get-file\//.test(src)).toBe(false);
  });

  // Was: the updateForm submit listener was registered INSIDE modify(), so
  // every click of an edit button stacked another listener, each closing over
  // the id it was opened with. One submit then fired all of them - opening the
  // editor for file A, then for file B, and saving sent a PUT for A *and* for
  // B, both carrying B's values, silently overwriting A. Reproduced in a real
  // browser: one save renamed two different files.
  it('binds the file-update submit handler exactly once, outside modify()', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'public', 'js', 'displayChat.js'), 'utf8'
    );

    // The listener must not be registered from inside modify().
    const modifyStart = src.indexOf('function modify(');
    expect(modifyStart).toBeGreaterThan(-1);
    const afterModify = src.indexOf('\nfunction ', modifyStart + 1);
    const modifyBody = src.slice(modifyStart, afterModify === -1 ? undefined : afterModify);
    expect(modifyBody).not.toMatch(/getElementById\(['"]updateForm['"]\)\s*\.addEventListener/);

    // And it must guard against being bound twice.
    expect(src).toMatch(/submitBound/);

    // The id must come from the form's hidden input, not a captured closure
    // variable, so it always matches the file currently on screen.
    expect(src).toMatch(/const fileId = document\.getElementById\(['"]fileId['"]\)\.value/);
  });

  it('returns the fields the edit modal needs from /file/:id', async () => {
    const { agent, user } = await registerAndLogin(app);
    const uid = await userIdOf(user.username);
    const fileId = await seedFileForUser(uid);

    const res = await agent.get(`/file/${fileId}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBeDefined();
    expect(res.body.title).toBeDefined();
    expect(res.body.description).toBeDefined();
    expect(res.body.categoryID).toBeDefined();
  });

  // Was: admin delete built the on-disk name as `${id}-${title}.pdf` while
  // uploads are stored as `${id}-${title}` (title already carries the
  // extension). It never found the file, returned 404, and the DELETE - which
  // sat inside the unlink callback - never ran. Admin deletion never worked,
  // and a row whose blob was missing could never be removed at all.
  it('lets an admin actually delete a file, even with no blob on disk', async () => {
    await testPool.query("INSERT INTO Admin (username, password) VALUES ('admin', 'admin')");
    const adminAgent = request.agent(app);
    const login = await adminAgent.post('/').type('form').send({ username: 'admin', password: 'admin' });
    expect(login.headers.location).toBe('/admin-dashboard');

    const owner = await registerAndLogin(app);
    const uid = await userIdOf(owner.user.username);
    const fileId = await seedFileForUser(uid, 'admin-target.pdf');

    const res = await adminAgent.delete(`/admin/delete-file/${fileId}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const [[row]] = await testPool.query('SELECT COUNT(*) AS c FROM Files WHERE id = ?', [fileId]);
    expect(row.c).toBe(0);
  });

  it('removes the blob from disk when an admin deletes a file', async () => {
    await testPool.query("INSERT INTO Admin (username, password) VALUES ('admin', 'admin')");
    const adminAgent = request.agent(app);
    await adminAgent.post('/').type('form').send({ username: 'admin', password: 'admin' });

    const owner = await registerAndLogin(app);
    const uid = await userIdOf(owner.user.username);
    const fileId = await seedFileForUser(uid, 'blob-target.pdf');

    // Mirror exactly how uploadFile names files on disk: `<id>-<title>`,
    // where the title already includes its extension.
    const uploadDir = path.join(process.cwd(), 'public', 'uploads');
    fs.mkdirSync(uploadDir, { recursive: true });
    const diskPath = path.join(uploadDir, `${fileId}-blob-target.pdf`);
    fs.writeFileSync(diskPath, '%PDF-1.4 test');

    const res = await adminAgent.delete(`/admin/delete-file/${fileId}`);

    expect(res.status).toBe(200);
    expect(fs.existsSync(diskPath)).toBe(false);
  });
});
