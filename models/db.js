import mysql from 'mysql2/promise';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

// Fail fast on a half-configured database rather than defaulting silently.
//
// The old defaults (`localhost` / `root` / `Student_Helper2_DB`) meant that a
// .env with a typo'd key name still produced a pool that "worked" - it just
// pointed at the wrong place, and every query then failed with a confusing
// ER_NO_SUCH_TABLE far away from the real cause. The defaults are kept for
// convenience, but a missing DB_NAME or DB_USER is now called out at boot.
const missing = ['DB_HOST', 'DB_USER', 'DB_NAME'].filter((k) => !process.env[k]);
if (missing.length) {
  console.warn(
    `[db] ${missing.join(', ')} not set in .env - falling back to defaults. ` +
    'Run "npm run diagnose" if the app cannot read or write data.'
  );
}

/**
 * TLS, for hosted databases.
 *
 * Every managed MySQL worth using - TiDB Cloud, PlanetScale, Aiven, Hostinger's
 * remote MySQL - requires an encrypted connection, and mysql2 does NOT enable
 * TLS on its own. Without this the connection is simply refused, usually with
 * a message about the handshake that says nothing about certificates, which is
 * a genuinely horrible thing to debug at 2am.
 *
 * DB_SSL=true            use TLS and verify the server's certificate against
 *                        the system CA store (correct for TiDB Cloud,
 *                        PlanetScale and Aiven, which all use public CAs)
 * DB_SSL_CA=/path/ca.pem use TLS and verify against a CA file the provider
 *                        gave you
 * unset / false          plain connection, for MySQL on your own machine
 *
 * DB_SSL_REJECT_UNAUTHORIZED=false turns certificate verification OFF. It is
 * here because some providers hand out self-signed certificates, but it means
 * anyone between this app and the database can read and alter every query, so
 * it is a last resort and never the right answer on the public internet.
 */
function sslOptions() {
    const ca = process.env.DB_SSL_CA;
    const enabled = ca || /^(1|true|yes|required)$/i.test(process.env.DB_SSL || '');
    if (!enabled) return {};

    const verify = !/^(0|false|no)$/i.test(process.env.DB_SSL_REJECT_UNAUTHORIZED || 'true');
    if (!verify) {
        console.warn(
            '[db] DB_SSL_REJECT_UNAUTHORIZED=false - the connection is encrypted but the ' +
            "server's identity is NOT checked. Anyone able to intercept the connection can " +
            'read and change your data. Use a CA file (DB_SSL_CA) instead.'
        );
    }

    return {
        ssl: {
            rejectUnauthorized: verify,
            ...(ca ? { ca: fs.readFileSync(ca, 'utf-8') } : {}),
            ...(process.env.DB_SSL_SERVERNAME ? { servername: process.env.DB_SSL_SERVERNAME } : {})
        }
    };
}

// Create a connection pool
const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'Student_Helper2_DB',
  waitForConnections: true,
  connectionLimit: parseInt(process.env.DB_POOL_SIZE || '10', 10),
  queueLimit: 0,
  // utf8mb4 so Arabic text, accented characters and emoji in titles,
  // descriptions and messages round-trip intact instead of being stored as
  // "?" - mysql2's default (utf8mb4 via UTF8MB4_GENERAL_CI) is set explicitly
  // here so it does not depend on the server's my.cnf.
  charset: 'utf8mb4',
  // A pooled connection that has been idle longer than MySQL's wait_timeout
  // is closed by the server but still handed out by the pool, which surfaces
  // as an intermittent "Connection lost: The server closed the connection"
  // on the first request after a quiet period. Keepalive pings avoid it.
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  // TIMESTAMP columns (chats.chatDate, messages.sent_at) come back as JS Date
  // objects; leaving this on is what the app's `new Date(...)` formatting
  // already assumes.
  dateStrings: false,
  ...sslOptions(),
});

/**
 * Verify the pool can actually reach the database.
 *
 * This used to be a fire-and-forget IIFE that printed the error and moved on,
 * so a server with no database still reported "Server is running on ..." and
 * looked healthy while every single page failed. It still does not kill the
 * process (that would make `npm run diagnose` useless), but it now says
 * plainly what to check, and exports a promise the diagnostics can await.
 */
export const dbReady = (async () => {
  try {
    const connection = await db.getConnection();
    const [[row]] = await connection.query('SELECT DATABASE() AS db, VERSION() AS version');
    connection.release();
    console.log(`[db] Connected to MySQL ${row.version}, database "${row.db}".`);
    return true;
  } catch (err) {
    console.error('\n' + '='.repeat(64));
    console.error(' DATABASE CONNECTION FAILED - the app will not be able to');
    console.error(' read or save anything until this is fixed.');
    console.error(`   ${err.code || 'ERROR'}: ${err.message}`);
    console.error('');
    console.error(' Check that MySQL is running, and that DB_HOST, DB_USER,');
    console.error(' DB_PASSWORD and DB_NAME in .env match it. Then run:');
    console.error('   npm run diagnose');
    console.error('='.repeat(64) + '\n');
    return false;
  }
})();

export default db;
