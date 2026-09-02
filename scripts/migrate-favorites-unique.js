// One-time migration: add the UNIQUE constraint that backs the duplicate
// check in models/Favorite.js#add.
//
// WHY: Favorite.add does a SELECT ("is it already favorited?") followed by an
// INSERT. With no constraint behind it, two requests that interleave between
// those two statements BOTH insert, and the file then shows up twice in the
// favorites list (reproduced here with 3 concurrent requests). The SELECT is
// still useful as a fast path; this makes it actually correct.
//
// The migration removes any duplicates already in the table first, otherwise
// MySQL refuses to add the constraint.
//
// Usage:  node scripts/migrate-favorites-unique.js
//
// Safe to run more than once - it checks for the index first and exits
// cleanly if it is already there.
import db from '../models/db.js';

const INDEX_NAME = 'uniq_favorit_user_file';

async function migrate() {
  try {
    const [existing] = await db.query(
      `SELECT COUNT(*) AS c
         FROM information_schema.STATISTICS
        WHERE table_schema = DATABASE()
          AND table_name = 'Favorit'
          AND index_name = ?`,
      [INDEX_NAME]
    );

    if (existing[0].c > 0) {
      console.log(`[migrate] ${INDEX_NAME} already exists - nothing to do.`);
      return;
    }

    const [dupes] = await db.query(
      `SELECT userId, fileId, COUNT(*) AS c
         FROM Favorit
        GROUP BY userId, fileId
       HAVING c > 1`
    );

    if (dupes.length > 0) {
      console.log(`[migrate] Found ${dupes.length} duplicated (userId, fileId) pair(s); keeping the oldest row of each.`);
      const [result] = await db.query(
        `DELETE f1 FROM Favorit f1
           INNER JOIN Favorit f2
           WHERE f1.favoritId > f2.favoritId
             AND f1.userId = f2.userId
             AND f1.fileId = f2.fileId`
      );
      console.log(`[migrate] Removed ${result.affectedRows} duplicate row(s).`);
    } else {
      console.log('[migrate] No duplicate favorites found.');
    }

    await db.query(`ALTER TABLE Favorit ADD UNIQUE KEY ${INDEX_NAME} (userId, fileId)`);
    console.log(`[migrate] Added ${INDEX_NAME} on Favorit (userId, fileId). Done.`);
  } catch (error) {
    console.error('[migrate] Failed:', error.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}

migrate();
