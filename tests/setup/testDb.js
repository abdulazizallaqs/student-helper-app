// Runtime DB helper for integration tests: a pool connected to the isolated
// test database (see env.setup.js for how DB_NAME gets pointed at it), plus a
// resetDatabase() used between tests so each test starts from a clean slate.
import mysql from 'mysql2/promise';

export const testPool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
});

// Order doesn't matter here - FK checks are disabled around the truncation.
//
// Two of these are conditional. `messages` is the direct-message table as it
// exists in the real database; schema.sql creates `messages_chat`, which is
// the shape models/Message.js falls back to. Whichever one a given database
// has, the other is simply absent - so a table that does not exist is skipped
// rather than failing the whole reset. Before this, a fresh test database
// (which has messages_chat but no messages) failed EVERY integration test in
// beforeEach with "Table 'messages' doesn't exist"; it only passed on
// databases where an earlier run had left the other table behind.
const TABLES = [
  'chats', 'messages', 'messages_chat', 'FileEmbeddings',
  // The blob tables cascade from Files in normal use, but TRUNCATE runs with
  // foreign-key checks off - so without listing them here, one test's stored
  // bytes survive into the next test under the same recycled file id, and a
  // test asserting "this file has no contents" quietly gets the previous
  // test's PDF instead.
  'FileBlobChunks', 'FileBlobs',
  'Favorit', 'Comments', 'Files', 'Categories', 'Users', 'Admin'
];

const MISSING_TABLE = new Set(['ER_NO_SUCH_TABLE', 'ER_BAD_TABLE_ERROR']);

export async function resetDatabase() {
  const conn = await testPool.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of TABLES) {
      try {
        await conn.query(`TRUNCATE TABLE \`${table}\``);
      } catch (error) {
        if (!MISSING_TABLE.has(error.code)) throw error;
      }
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    conn.release();
  }
}

export async function closeTestDb() {
  await testPool.end();
}
