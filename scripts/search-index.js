/**
 * npm run search:index
 *
 * Builds the semantic-search index for files that do not have one yet.
 *
 * Run it once after pulling this change (every file that already existed
 * predates the feature), and any time you want to be sure nothing was missed -
 * it only ever touches files with no vector, so running it twice is harmless.
 *
 *   npm run search:index               index everything missing
 *   npm run search:index -- --max 50   stop after 50 files
 *   npm run search:index -- --status   report what is indexed, change nothing
 */
import dotenv from 'dotenv';
dotenv.config();

import db from '../models/db.js';
import FileEmbedding from '../models/FileEmbedding.js';
import { indexMissing } from '../services/searchIndexer.js';
import { isEmbeddingEnabled, embeddingModelName, embeddingDimensions, embeddingHealth } from '../services/embeddingService.js';

function argValue(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    if (index === -1) return fallback;
    const value = Number(process.argv[index + 1]);
    return Number.isFinite(value) ? value : fallback;
}

async function main() {
    const statusOnly = process.argv.includes('--status');

    console.log('Semantic search index');
    console.log('---------------------');
    console.log(`Model:      ${embeddingModelName()} (${embeddingDimensions()} dimensions)`);
    console.log(`Enabled:    ${isEmbeddingEnabled() ? 'yes' : 'no'}`);

    if (!isEmbeddingEnabled()) {
        console.log('\nEmbeddings are off. Either GEMINI_API_KEY is not set, or');
        console.log('SEARCH_EMBEDDINGS=off is in .env. Keyword search works regardless -');
        console.log('this only adds match-by-meaning on top of it.');
        return;
    }

    const stats = await FileEmbedding.stats();
    if (!stats.available) {
        console.log('\nThe FileEmbeddings table could not be created. See the warning above.');
        return;
    }
    console.log(`Files:      ${stats.total}`);
    console.log(`Indexed:    ${stats.embedded}`);
    console.log(`Missing:    ${stats.missing}`);

    // Vectors from another model, or another dimensionality, are not
    // comparable with the current ones and are ignored at search time. That is
    // correct but invisible, and "I indexed everything and semantic search
    // still finds nothing" is a miserable thing to debug, so say it out loud.
    const [stale] = await db.query(
        `SELECT model, dimensions, COUNT(*) AS count FROM FileEmbeddings
         WHERE model <> ? OR dimensions <> ?
         GROUP BY model, dimensions`,
        [embeddingModelName(), embeddingDimensions()]
    );
    if (stale.length) {
        console.log('\nVectors stored under different settings (ignored by search):');
        for (const row of stale) console.log(`  ${row.count} x ${row.model} @ ${row.dimensions}d`);
        console.log('These were built with a different GEMINI_EMBEDDING_MODEL or');
        console.log('GEMINI_EMBEDDING_DIM. Change the setting back, or re-index to replace them.');
    }

    if (statusOnly) return;
    if (stats.missing === 0) {
        console.log('\nNothing to do - every file is indexed.');
        return;
    }

    const max = argValue('max', Infinity);
    const batchSize = argValue('batch', 10);

    console.log(`\nIndexing${Number.isFinite(max) ? ` up to ${max}` : ''}...\n`);

    const result = await indexMissing({
        batchSize,
        max,
        onProgress: ({ done, failed, batch }) =>
            console.log(`  +${batch} processed  (indexed ${done}, failed ${failed})`)
    });

    console.log(`\nDone. Indexed ${result.indexed}, failed ${result.failed}.`);

    if (result.failed) {
        const health = embeddingHealth();
        console.log(`\nLast error: ${health.lastError || 'unknown'}`);
        console.log('Common causes: the daily embedding quota is used up (try again tomorrow,');
        console.log('or in smaller runs with --max), or the key cannot reach Google.');
        console.log('Re-run this command later; it resumes where it stopped.');
    }
}

main()
    .catch((error) => {
        console.error(`\nFailed: ${error.message}`);
        process.exitCode = 1;
    })
    .finally(async () => {
        try { await db.end(); } catch { /* pool already closed */ }
    });
