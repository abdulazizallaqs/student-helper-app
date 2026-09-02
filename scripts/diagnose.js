// Self-check: run this on YOUR machine to find out exactly what is failing.
//
//   node scripts/diagnose.js
//
// It checks, in order: environment variables, database connectivity, the
// tables and columns the app expects, whether the admin account exists, and
// finally boots the app in-process and makes real requests against it.
// Nothing is modified - this only reads.
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';

const pass = (m) => console.log(`  [ OK ]  ${m}`);
const fail = (m) => { console.log(`  [FAIL]  ${m}`); failures.push(m); };
const warn = (m) => console.log(`  [warn]  ${m}`);
const failures = [];

console.log('\n=============================================');
console.log(' Student Helper - system diagnostic');
console.log('=============================================\n');

// ---------------------------------------------------------------- 1. env
console.log('1. Environment (.env)');
const required = ['DB_HOST', 'DB_USER', 'DB_NAME', 'SESSION_SECRET'];
for (const key of required) {
  if (process.env[key]) pass(`${key} is set`);
  else fail(`${key} is MISSING from .env`);
}
if (process.env.DB_PASSWORD) pass('DB_PASSWORD is set');
else warn('DB_PASSWORD is empty (fine only if your MySQL user has no password)');
// Gemini: check the SHAPE of the key here (cheap, offline). `npm run ai:check`
// makes a real request and reports what Google actually says.
if (process.env.GEMINI_API_KEY) {
  const key = process.env.GEMINI_API_KEY.trim();
  const looksStandard = /^AIza[0-9A-Za-z_-]{35}$/.test(key);
  const looksAuth = /^AQ\.[0-9A-Za-z_-]{10,}$/.test(key);
  if (looksStandard || looksAuth) {
    pass(`GEMINI_API_KEY is set (${looksAuth ? 'AQ. auth key' : 'AIza standard key'}) - verify it with: npm run ai:check`);
  } else {
    fail(`GEMINI_API_KEY does not look like a Gemini key (starts "${key.slice(0, 4)}...", ${key.length} chars). Expected AIza... or AQ....`);
  }
} else {
  warn('GEMINI_API_KEY is not set - AI features will report that they are switched off');
}

// Google sign-in is optional; say clearly whether it is on, and why not.
const googleId = process.env.GOOGLE_CLIENT_ID;
const googleSecret = process.env.GOOGLE_CLIENT_SECRET;
if (googleId && googleSecret) {
  pass('Google sign-in is configured (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET set)');
  const callback = process.env.GOOGLE_CALLBACK_URL
    || `http://localhost:${process.env.PORT || 3002}/auth/google/callback`;
  console.log(`          callback URL: ${callback}`);
  console.log('          This must be registered VERBATIM under "Authorised redirect URIs"');
  console.log('          on the OAuth client in the Google Cloud console, or Google');
  console.log('          answers redirect_uri_mismatch.');
  if (!/\.apps\.googleusercontent\.com$/.test(googleId)) {
    warn('GOOGLE_CLIENT_ID does not end in .apps.googleusercontent.com - that is not an OAuth client ID');
  }
} else if (googleId || googleSecret) {
  fail(`Google sign-in is half-configured: ${googleId ? 'GOOGLE_CLIENT_SECRET' : 'GOOGLE_CLIENT_ID'} is missing. Both are required.`);
} else {
  warn('Google sign-in is OFF (no GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).');
  warn('        The button is hidden on the login page. Username + password still work.');
  warn('        See .env.example for how to turn it on.');
}

// Production-readiness (see DEPLOYMENT.md)
const isProd = process.env.NODE_ENV === 'production';
console.log(`          NODE_ENV = ${process.env.NODE_ENV || '(not set)'}`);
if (isProd) {
  pass('NODE_ENV=production - HTTPS enforcement and secure cookies are ACTIVE');
} else {
  warn('NODE_ENV is not "production" - HTTPS enforcement, the secure session');
  warn('        cookie and trust-proxy are all INACTIVE. Fine locally; set it before publishing.');
}
const PLACEHOLDER_SECRETS = ['your_super_secret_key_change_this', 'fallback_secret_key', 'changeme', 'secret'];
if (PLACEHOLDER_SECRETS.includes(process.env.SESSION_SECRET || '')) {
  fail('SESSION_SECRET is still the example placeholder - anyone who has seen this project can forge a session cookie for ANY account, admin included');
} else if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32) {
  pass('SESSION_SECRET looks strong');
} else if (process.env.SESSION_SECRET) {
  warn('SESSION_SECRET is short - generate a long random one (see DEPLOYMENT.md)');
}
const PORT = process.env.PORT || 3002;
console.log(`          PORT = ${PORT}\n`);

// ------------------------------------------------------- 2. dependencies
console.log('2. Installed dependencies');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
let missingDeps = 0;
for (const dep of Object.keys(pkg.dependencies || {})) {
  if (!fs.existsSync(path.join('node_modules', dep, 'package.json'))) {
    fail(`node_modules is missing "${dep}"  ->  run: npm install`);
    missingDeps++;
  }
}
if (missingDeps === 0) pass('every dependency in package.json is installed');
console.log('');

// ---------------------------------------------------------- 3. database
console.log('3. Database');
let conn;
try {
  conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  pass(`connected to "${process.env.DB_NAME}" on ${process.env.DB_HOST}`);
} catch (error) {
  fail(`CANNOT CONNECT: ${error.message}`);
  console.log('\n  This is almost certainly the problem. Check that MySQL is');
  console.log('  running and that DB_NAME/DB_USER/DB_PASSWORD in .env match it.\n');
}

if (conn) {
  // tables the app reads/writes
  const expected = {
    Users: ['userId', 'name', 'username', 'email', 'password'],
    Files: ['id', 'categoryID', 'title', 'description', 'uploadedBy'],
    Categories: ['id', 'name'],
    chats: ['id', 'fileID', 'content', 'userID', 'chatDate'],
    messages: ['id', 'sender_id', 'receiver_id', 'content'],
    Favorit: ['favoritId', 'userId', 'fileId'],
    Admin: ['adminId', 'username', 'password'],
  };
  // NOTE: the app no longer reads a `Comments` table. Comments are rows in
  // `chats` - adminController and User.getUserStats used to query `Comments`,
  // which the app never writes to, so every comment count was 0 (or the
  // endpoint 500'd on a database without that table). If `Comments` still
  // exists in your database it is now unused and can be dropped.

  const [tables] = await conn.query('SHOW TABLES');
  const tableNames = tables.map(r => Object.values(r)[0].toLowerCase());

  for (const [table, columns] of Object.entries(expected)) {
    if (!tableNames.includes(table.toLowerCase())) {
      fail(`table "${table}" does not exist`);
      continue;
    }
    const [cols] = await conn.query(`SHOW COLUMNS FROM \`${table}\``);
    const have = cols.map(c => c.Field.toLowerCase());
    const missing = columns.filter(c => !have.includes(c.toLowerCase()));
    if (missing.length) fail(`table "${table}" is missing column(s): ${missing.join(', ')}`);
    else pass(`table "${table}" looks correct`);
  }

  // the constraint added by scripts/migrate-favorites-unique.js
  const [idx] = await conn.query(
    `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
      WHERE table_schema = DATABASE() AND table_name = 'Favorit'
        AND index_name = 'uniq_favorit_user_file'`);
  if (idx[0].c > 0) pass('Favorit has the uniq_favorit_user_file constraint');
  else warn('Favorit is missing uniq_favorit_user_file  ->  run: node scripts/migrate-favorites-unique.js');

  const [[admins]] = await conn.query('SELECT COUNT(*) AS c FROM Admin');
  if (admins.c > 0) pass(`${admins.c} admin account(s) exist`);
  else warn('no admin account  ->  run: node scripts/seedAdmin.js  (creates admin/admin)');

  const [[users]] = await conn.query('SELECT COUNT(*) AS c FROM Users');
  console.log(`          ${users.c} user account(s) registered`);

  const [[cats]] = await conn.query('SELECT COUNT(*) AS c FROM Categories');
  if (cats.c > 0) pass(`${cats.c} categor(y/ies) defined`);
  else warn('Categories is empty - uploaders can still create one with "+ Add a new category"');

  // ------------------------------------------------------------------
  // Uploads on disk vs rows in the database.
  //
  // This is the check that answers "my PDF opens as a blank page - was it
  // even uploaded?". Every Files row should have exactly one blob in
  // public/uploads named "<id>-...". A row with no blob means the upload
  // never completed; a blob with no row is left-over rubbish from a failed
  // upload and is taking up space.
  // ------------------------------------------------------------------
  const { storageMode, usesDatabase } = await import('../services/fileStorage.js');
  console.log(`\n  file storage mode: ${storageMode()}`);

  const [rows] = await conn.query('SELECT id, title FROM Files');

  if (usesDatabase()) {
    // Bytes live in FileBlobs/FileBlobChunks. A row with no blob opens as a
    // blank viewer exactly as a missing disk file does, so the check is the
    // same question asked of a different place.
    const [blobs] = await conn.query('SELECT fileId, byteSize, chunkCount FROM FileBlobs').catch(() => [[]]);
    const stored = new Map(blobs.map((b) => [Number(b.fileId), b]));

    const orphanRows = rows.filter((r) => !stored.has(Number(r.id)));
    if (orphanRows.length === 0) {
      const total = blobs.reduce((sum, b) => sum + Number(b.byteSize), 0);
      pass(`all ${rows.length} file record(s) have their contents stored (${(total / 1048576).toFixed(1)} MB)`);
    } else {
      fail(`${orphanRows.length} file record(s) have NO stored contents - these open as a blank viewer:`);
      orphanRows.slice(0, 10).forEach((r) => console.log(`            id ${r.id}  "${r.title}"`));
      console.log('          They were uploaded before FILE_STORAGE=database was switched on,');
      console.log('          or the upload failed. Re-upload them, or delete the rows.');
    }

    // A file whose chunk count does not match what is actually stored reads
    // back as a corrupt PDF rather than an obviously missing one, which is
    // much harder to recognise from the outside.
    const [broken] = await conn.query(`
      SELECT b.fileId, b.chunkCount, COUNT(c.seq) AS present
      FROM FileBlobs b LEFT JOIN FileBlobChunks c ON c.fileId = b.fileId
      GROUP BY b.fileId, b.chunkCount HAVING present <> b.chunkCount`).catch(() => [[]]);
    if (broken.length === 0) pass('every stored file has all of its pieces');
    else {
      fail(`${broken.length} stored file(s) are missing pieces and will not open:`);
      broken.slice(0, 10).forEach((b) => console.log(`            id ${b.fileId}  ${b.present}/${b.chunkCount} pieces`));
    }
  } else {
    const uploadDir = path.join(process.cwd(), 'public', 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fail(`public/uploads does not exist  ->  create it: mkdir "${uploadDir}"`);
    } else {
      const onDisk = fs.readdirSync(uploadDir).filter(f => !f.startsWith('.'));

      const orphanRows = rows.filter(r => !onDisk.some(f => f.startsWith(`${r.id}-`)));
      if (orphanRows.length === 0) {
        pass(`all ${rows.length} file record(s) have their upload on disk`);
      } else {
        fail(`${orphanRows.length} file record(s) have NO file in public/uploads - these open as a blank viewer:`);
        orphanRows.slice(0, 10).forEach(r => console.log(`            id ${r.id}  "${r.title}"`));
        if (orphanRows.length > 10) console.log(`            ...and ${orphanRows.length - 10} more`);
        console.log('          These were never stored successfully. Re-upload them,');
        console.log('          or delete the rows from the admin dashboard.');
      }

      const ids = new Set(rows.map(r => String(r.id)));
      const strayFiles = onDisk.filter(f => {
        const prefix = f.split('-')[0];
        return !/^\d+$/.test(prefix) || !ids.has(prefix);
      });
      if (strayFiles.length === 0) {
        pass('no orphaned files in public/uploads');
      } else {
        warn(`${strayFiles.length} file(s) in public/uploads have no database record (leftovers from failed uploads):`);
        strayFiles.slice(0, 10).forEach(f => console.log(`            ${f}`));
        if (strayFiles.length > 10) console.log(`            ...and ${strayFiles.length - 10} more`);
        console.log('          They are unreachable from the app and can be deleted.');
      }
    }

    if (process.env.NODE_ENV === 'production') {
      warn('FILE_STORAGE is "disk" in production. On a host with a throwaway');
      warn('filesystem (Render free, Vercel, most free tiers) every upload is lost'); 
      warn('the next deploy. Set FILE_STORAGE=database there.');
    }
  }

  await conn.end();
}
console.log('');

// ------------------------------------------------------ 4. boot the app
console.log('4. Application boot + live requests');
let app;
try {
  process.env.NODE_ENV = 'test'; // stops app.js opening a real listening port
  app = (await import('../app.js')).default;
  pass('app.js loaded without crashing');
} catch (error) {
  fail(`app.js FAILED TO LOAD: ${error.message}`);
  console.log('\n  Full error:\n');
  console.error(error);
}

if (app) {
  let request;
  try {
    ({ default: request } = await import('supertest'));
  } catch {
    warn('supertest not installed - skipping live request checks');
  }

  if (request) {
    const probes = [
      ['GET', '/', 'landing / splash page'],
      ['GET', '/login', 'login page'],
      ['GET', '/views/user-login.html', 'login page (direct)'],
      ['GET', '/views/create-account.html', 'create-account page'],
      ['GET', '/categories', 'categories API'],
      ['GET', '/api/auth/providers', 'sign-in methods API'],
    ];
    // Endpoints that must REJECT an anonymous caller are checked separately
    // below - a 200 from any of them would be the bug, not the pass.
    for (const [, url, label] of probes) {
      try {
        const res = await request(app).get(url);
        if (res.status < 400) pass(`${label.padEnd(28)} ${url} -> ${res.status}`);
        else fail(`${label.padEnd(28)} ${url} -> ${res.status}`);
      } catch (error) {
        fail(`${label} ${url} threw: ${error.message}`);
      }
    }

    // Protected pages SHOULD bounce an anonymous visitor to /login.
    for (const url of ['/views/file-page-forme.html', '/views/admin-dashboard.html', '/views/chat.html']) {
      const res = await request(app).get(url);
      if (res.status === 302 || res.status === 401) {
        pass(`protected page correctly redirects when logged out  ${url} -> ${res.status}`);
      } else {
        fail(`protected page returned ${res.status} to a logged-out visitor  ${url}`);
      }
    }

    // Protected APIs SHOULD refuse an anonymous caller.
    for (const url of ['/msg', '/my-files', '/messages/conversations', '/admin/users', '/file-content/1']) {
      const res = await request(app).get(url);
      if (res.status === 401 || res.status === 302) {
        pass(`protected API correctly refuses when logged out     ${url} -> ${res.status}`);
      } else {
        fail(`protected API returned ${res.status} to a logged-out caller  ${url}`);
      }
    }
  }
}

// ------------------------------------------------------------- verdict
console.log('\n=============================================');
if (failures.length === 0) {
  console.log(' RESULT: no problems found.');
  console.log('');
  console.log(' The backend is healthy. If the app still looks wrong in the');
  console.log(' browser, it is a front-end / session issue - tell Claude:');
  console.log('   - the exact URL you are on');
  console.log('   - what you see vs what you expected');
  console.log('   - any red errors in the browser console (F12 -> Console)');
} else {
  console.log(` RESULT: ${failures.length} problem(s) found:\n`);
  failures.forEach((f, i) => console.log(`   ${i + 1}. ${f}`));
}
console.log('=============================================\n');

process.exit(failures.length ? 1 : 0);
