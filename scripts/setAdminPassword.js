// Set (or reset) the admin password to a value you choose.
//
// WHY THIS EXISTS: scripts/seedAdmin.js creates admin/admin so there is a way
// into a fresh install. That is fine on your laptop and a serious problem the
// moment the app is on the public internet - "admin/admin" is the first thing
// anyone tries. There was no way to change it other than editing the database
// by hand, so this is it.
//
// Usage:
//   node scripts/setAdminPassword.js "your new strong password"
//
// Or omit the argument and it will generate a strong one for you:
//   node scripts/setAdminPassword.js
//
// The password is stored as a bcrypt hash, never in plain text.
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import db from '../models/db.js';

const USERNAME = process.env.ADMIN_USERNAME || 'admin';

function generatePassword() {
  // 24 random bytes -> base64url, no ambiguous characters to mistype.
  return crypto.randomBytes(24).toString('base64url');
}

function assessStrength(password) {
  const problems = [];
  if (password.length < 12) problems.push('shorter than 12 characters');
  if (!/[a-z]/.test(password)) problems.push('no lowercase letter');
  if (!/[A-Z]/.test(password)) problems.push('no uppercase letter');
  if (!/\d/.test(password)) problems.push('no digit');
  if (['admin', 'password', '123456', 'admin123'].includes(password.toLowerCase())) {
    problems.push('is a well-known default');
  }
  return problems;
}

async function main() {
  try {
    const provided = process.argv[2];
    const generated = !provided;
    const password = provided || generatePassword();

    if (provided) {
      const problems = assessStrength(password);
      if (problems.length) {
        console.error('\n[admin] Refusing to set a weak admin password:');
        problems.forEach(p => console.error(`  - ${p}`));
        console.error('\n[admin] Pick a stronger one, or run with no argument to have one generated.\n');
        // Exit immediately rather than falling through to the finally block:
        // models/db.js opens its pool on import, and closing it while that
        // handshake is still in flight prints a confusing "Pool is closed"
        // error on top of the message the user actually needs to read.
        process.exit(1);
      }
    }

    const [rows] = await db.query('SELECT adminId FROM Admin WHERE username = ?', [USERNAME]);
    const hash = await bcrypt.hash(password, 10);

    if (rows.length === 0) {
      await db.query('INSERT INTO Admin (username, password) VALUES (?, ?)', [USERNAME, hash]);
      console.log(`\n[admin] Created admin account "${USERNAME}".`);
    } else {
      await db.query('UPDATE Admin SET password = ? WHERE username = ?', [hash, USERNAME]);
      console.log(`\n[admin] Password updated for admin account "${USERNAME}".`);
    }

    if (generated) {
      console.log('\n  Generated password (save it now - it is not shown again):\n');
      console.log(`      ${password}\n`);
    } else {
      console.log('  Password set to the value you supplied.\n');
    }
    console.log('[admin] Stored as a bcrypt hash. Done.\n');
  } catch (error) {
    console.error('[admin] Failed:', error.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}

main();
