// One-time setup script: creates the default admin account (username: admin,
// password: admin) if it doesn't already exist, so there's a way into
// /admin-dashboard on a fresh database. Safe to run more than once - it does
// nothing if an "admin" row is already there.
//
// Usage:  node scripts/seedAdmin.js
//    or:  npm run seed:admin
//
// IMPORTANT: change this password after logging in once (Admin table has no
// "change password" UI yet - update it directly, or open a support request
// to add one). The app auto-upgrades this plaintext row to a bcrypt hash the
// first time anyone logs in with it (see models/Admin.js#verifyPassword),
// exactly like the legacy-password migration already used for the Users
// table - so after that first login the plaintext value is gone from the DB.
import db from '../models/db.js';
import Admin from '../models/Admin.js';

const USERNAME = 'admin';
const PASSWORD = 'admin';

async function seedAdmin() {
  try {
    const existing = await Admin.findByUsername(USERNAME);
    if (existing) {
      console.log(`[seed:admin] An "${USERNAME}" account already exists - nothing to do.`);
      return;
    }

    await db.query('INSERT INTO Admin (username, password) VALUES (?, ?)', [USERNAME, PASSWORD]);
    console.log(`[seed:admin] Created admin account - username: "${USERNAME}", password: "${PASSWORD}".`);
    console.log('[seed:admin] Log in once at /login, then change this password.');
  } catch (error) {
    console.error('[seed:admin] Failed to seed admin account:', error.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}

seedAdmin();
