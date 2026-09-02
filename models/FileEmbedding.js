/**
 * Where a file's embedding vector lives.
 *
 * This is a SEPARATE TABLE rather than extra columns on Files, on purpose:
 *
 *  - Adding columns means an ALTER TABLE against a database that already has
 *    the user's real data in it. Creating a new table is the safe half of
 *    that trade - `CREATE TABLE IF NOT EXISTS` can run on every boot and
 *    never touches a row anyone cares about.
 *  - A vector is a kilobyte or two of JSON. Keeping it out of Files means
 *    every ordinary `SELECT ... FROM Files` stays as cheap as it was.
 *  - The foreign key cascades, so deleting a file deletes its vector with no
 *    extra code and no orphans.
 *
 * Everything here is best-effort. If the table cannot be created (an older
 * MySQL, a user without CREATE rights) the app logs once and carries on with
 * keyword search - the site must not fail to start over a search optimisation.
 */
import db from './db.js';
import { embeddingModelName, embeddingDimensions, packVector, unpackVector } from '../services/embeddingService.js';

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS FileEmbeddings (
    fileId INT NOT NULL PRIMARY KEY,
    model VARCHAR(64) NOT NULL,
    dimensions INT NOT NULL,
    vector LONGTEXT NOT NULL,
    updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_file_embedding_file FOREIGN KEY (fileId) REFERENCES Files(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`;

// One attempt per process, shared by every caller, so a hundred concurrent
// searches do not each issue a CREATE TABLE.
let readyPromise = null;
let available = false;

/**
 * Make sure the table exists. Resolves to true when embeddings can be stored.
 * @returns {Promise<boolean>}
 */
export function ensureEmbeddingTable() {
    if (!readyPromise) {
        readyPromise = db.query(CREATE_SQL)
            .then(() => { available = true; return true; })
            .catch((error) => {
                console.warn(
                    `[search] Could not create the FileEmbeddings table (${error.message}). ` +
                    'Semantic search is off; keyword search is unaffected.'
                );
                available = false;
                return false;
            });
    }
    return readyPromise;
}

/** True once ensureEmbeddingTable has succeeded. Cheap, synchronous. */
export const embeddingStoreAvailable = () => available;

const FileEmbedding = {
    ensureTable: ensureEmbeddingTable,

    /**
     * Store (or replace) one file's vector.
     * @param {number} fileId
     * @param {number[]} vector
     * @returns {Promise<boolean>} false if it could not be stored
     */
    async put(fileId, vector) {
        if (!Array.isArray(vector) || !vector.length) return false;
        if (!(await ensureEmbeddingTable())) return false;
        try {
            await db.query(
                `INSERT INTO FileEmbeddings (fileId, model, dimensions, vector)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE model = VALUES(model), dimensions = VALUES(dimensions), vector = VALUES(vector)`,
                [fileId, embeddingModelName(), vector.length, packVector(vector)]
            );
            return true;
        } catch (error) {
            console.error(`[search] Could not save the embedding for file ${fileId}: ${error.message}`);
            return false;
        }
    },

    /**
     * Vectors for a set of file ids, as a Map(fileId -> number[]).
     * Rows written by a different embedding model are skipped: vectors from
     * two models are not comparable, and mixing them produces confident
     * nonsense rather than an obvious error.
     * @param {number[]} fileIds
     * @returns {Promise<Map<number, number[]>>}
     */
    async findByFileIds(fileIds) {
        const found = new Map();
        const ids = [...new Set((fileIds || []).map(Number).filter(Number.isInteger))];
        if (!ids.length || !(await ensureEmbeddingTable())) return found;
        try {
            const placeholders = ids.map(() => '?').join(',');
            const [rows] = await db.query(
                `SELECT fileId, vector FROM FileEmbeddings
                 WHERE model = ? AND dimensions = ? AND fileId IN (${placeholders})`,
                [embeddingModelName(), embeddingDimensions(), ...ids]
            );
            for (const row of rows) {
                const vector = unpackVector(row.vector);
                if (vector) found.set(Number(row.fileId), vector);
            }
        } catch (error) {
            console.error(`[search] Could not read embeddings: ${error.message}`);
        }
        return found;
    },

    /**
     * Every embedded file, joined to the columns search needs, newest first.
     * This is what lets a search surface a file that shares NO words with the
     * query - such a file is never in the keyword candidate set, so it has to
     * come from here.
     * @param {number} limit
     * @returns {Promise<Array<object>>} rows with a `_vector` property
     */
    async findEmbeddedFiles(limit = 400) {
        if (!(await ensureEmbeddingTable())) return [];
        const safeLimit = Math.max(1, Math.min(2000, parseInt(limit, 10) || 400));
        try {
            const [rows] = await db.query(
                `SELECT Files.id, Files.title, Files.description, Files.categoryID, Users.username,
                        Categories.name AS category, FileEmbeddings.vector
                 FROM FileEmbeddings
                 JOIN Files ON Files.id = FileEmbeddings.fileId
                 JOIN Categories ON Files.categoryID = Categories.id
                 JOIN Users ON Files.uploadedBy = Users.userId
                 WHERE FileEmbeddings.model = ? AND FileEmbeddings.dimensions = ?
                 ORDER BY Files.id DESC
                 LIMIT ${safeLimit}`,
                [embeddingModelName(), embeddingDimensions()]
            );
            return rows
                .map((row) => {
                    const { vector, ...file } = row;
                    return { ...file, _vector: unpackVector(vector) };
                })
                .filter((row) => row._vector);
        } catch (error) {
            console.error(`[search] Could not read the embedding index: ${error.message}`);
            return [];
        }
    },

    /**
     * Files with no usable vector yet - the backfill queue.
     * @param {number} limit
     * @returns {Promise<Array<{id:number, title:string, description:string, category:string}>>}
     */
    async findMissing(limit = 50) {
        if (!(await ensureEmbeddingTable())) return [];
        const safeLimit = Math.max(1, Math.min(500, parseInt(limit, 10) || 50));
        const [rows] = await db.query(
            `SELECT Files.id, Files.title, Files.description, Categories.name AS category
             FROM Files
             JOIN Categories ON Files.categoryID = Categories.id
             LEFT JOIN FileEmbeddings
                    ON FileEmbeddings.fileId = Files.id
                   AND FileEmbeddings.model = ?
                   AND FileEmbeddings.dimensions = ?
             WHERE FileEmbeddings.fileId IS NULL
             ORDER BY Files.id DESC
             LIMIT ${safeLimit}`,
            [embeddingModelName(), embeddingDimensions()]
        );
        return rows;
    },

    /** {total, embedded, missing} for `npm run search:index` and diagnostics. */
    async stats() {
        if (!(await ensureEmbeddingTable())) return { total: 0, embedded: 0, missing: 0, available: false };
        const [[{ total }]] = await db.query('SELECT COUNT(*) AS total FROM Files');
        const [[{ embedded }]] = await db.query(
            'SELECT COUNT(*) AS embedded FROM FileEmbeddings WHERE model = ? AND dimensions = ?',
            [embeddingModelName(), embeddingDimensions()]
        );
        return { total: Number(total), embedded: Number(embedded), missing: Number(total) - Number(embedded), available: true };
    }
};

export default FileEmbedding;
