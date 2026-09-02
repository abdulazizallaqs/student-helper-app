/**
 * Keeping the semantic index in step with the library.
 *
 * A file's embedding is computed ONCE and stored. That is what makes semantic
 * search affordable: a search costs at most one embedding of the query (and
 * usually zero, because query vectors are cached), never one per file.
 *
 * Indexing therefore has to happen at the two moments a file's text changes -
 * when it is uploaded and when it is edited - plus a backfill for everything
 * that already existed before this feature did (`npm run search:index`).
 *
 * All of it is best-effort and off the critical path. An upload must not get
 * slower, or fail, because an embedding could not be fetched; a file with no
 * vector is simply one that keyword search still finds and semantic search
 * does not, until the next backfill picks it up.
 */
import db from '../models/db.js';
import FileEmbedding from '../models/FileEmbedding.js';
import { embedDocument, embedDocuments, documentTextFor, isEmbeddingEnabled } from './embeddingService.js';

const FILE_SELECT = `
  SELECT Files.id, Files.title, Files.description, Categories.name AS category
  FROM Files
  JOIN Categories ON Files.categoryID = Categories.id
  WHERE Files.id = ?`;

/**
 * Compute and store the vector for one file.
 * @param {number} fileId
 * @returns {Promise<boolean>} true if a vector was stored
 */
export async function indexFile(fileId) {
    if (!isEmbeddingEnabled()) return false;
    try {
        const [rows] = await db.query(FILE_SELECT, [fileId]);
        if (!rows.length) return false;
        const vector = await embedDocument(documentTextFor(rows[0]));
        if (!vector) return false;
        return await FileEmbedding.put(fileId, vector);
    } catch (error) {
        console.error(`[search] Could not index file ${fileId}: ${error.message}`);
        return false;
    }
}

/**
 * Index a file without making the caller wait, and without letting a rejected
 * promise reach the process as an unhandled error. Used by upload and edit:
 * the user's request has already been answered by the time this runs.
 * @param {number} fileId
 */
export function indexFileInBackground(fileId) {
    if (!isEmbeddingEnabled()) return;
    setImmediate(() => {
        indexFile(fileId).catch((error) =>
            console.error(`[search] Background indexing failed for file ${fileId}: ${error.message}`));
    });
}

/**
 * Backfill: embed every file that has no vector yet.
 *
 * Batched, because one request for ten documents costs one unit of quota
 * rather than ten, and paced, because a free-tier key has a per-minute limit
 * as well as a per-day one.
 *
 * @param {Object} [options]
 * @param {number} [options.batchSize=10]
 * @param {number} [options.max=Infinity]     - stop after this many files
 * @param {number} [options.pauseMs=1200]     - wait between batches
 * @param {function} [options.onProgress]     - ({done, failed, remaining})
 * @returns {Promise<{indexed:number, failed:number, skipped:boolean}>}
 */
export async function indexMissing(options = {}) {
    const batchSize = Math.max(1, Math.min(50, options.batchSize ?? 10));
    const max = options.max ?? Infinity;
    const pauseMs = options.pauseMs ?? 1200;
    const onProgress = options.onProgress || (() => {});

    if (!isEmbeddingEnabled()) return { indexed: 0, failed: 0, skipped: true };

    let indexed = 0;
    let failed = 0;

    // findMissing() asks the database what still has no vector, so a file that
    // was attempted and did not get stored comes straight back in the next
    // batch - and the loop spins on it forever. (That is not hypothetical: a
    // vector stored under a different dimensionality than the one being
    // queried for looks exactly like a file that was never indexed.) Tracking
    // what has been attempted is what makes the loop finite.
    const attempted = new Set();

    for (;;) {
        if (indexed + failed >= max) break;

        const batch = (await FileEmbedding.findMissing(batchSize + attempted.size))
            .filter((file) => !attempted.has(file.id))
            .slice(0, Math.min(batchSize, max - indexed - failed));
        if (!batch.length) break;

        batch.forEach((file) => attempted.add(file.id));

        const vectors = await embedDocuments(batch.map((file) => documentTextFor(file)));

        let storedThisBatch = 0;
        for (let i = 0; i < batch.length; i += 1) {
            const vector = vectors[i];
            if (vector && await FileEmbedding.put(batch[i].id, vector)) { indexed += 1; storedThisBatch += 1; }
            else failed += 1;
        }

        onProgress({ done: indexed, failed, batch: batch.length });

        // Nothing in the batch could be stored - the key, the quota, the
        // network or the table is the problem, not this particular text.
        // Continuing would repeat the same failure once per file in the
        // library, which on a free tier means burning the whole allowance to
        // learn one thing.
        if (storedThisBatch === 0) break;

        if (pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }

    return { indexed, failed, skipped: false };
}

export default { indexFile, indexFileInBackground, indexMissing };
