/**
 * Text embeddings - the part of search that understands MEANING.
 *
 * services/searchService.js matches words: the same word, its stem, a known
 * synonym, or a near-miss spelling. That covers a lot, but it can only ever
 * find files that share vocabulary with the query. A student searching
 * "how do plants make food" will not find a file called "Photosynthesis" -
 * there is not one word in common, and no thesaurus written by hand is going
 * to contain that pair.
 *
 * An embedding turns a piece of text into a list of numbers positioned so
 * that texts about the same thing land near each other. Compare two of them
 * (cosine similarity) and you get "how related are these", regardless of
 * which words were used or which language they were written in.
 *
 * Three rules govern everything below, because search must never become the
 * thing that breaks the site:
 *
 *   1. NOTHING HERE IS ALLOWED TO THROW at a caller. Every entry point
 *      returns null on failure. A search with no embeddings is still a
 *      perfectly good keyword search.
 *   2. NOTHING HERE IS ALLOWED TO BE SLOW. The query embedding is raced
 *      against a short timeout; if Google is having a bad day the search
 *      returns keyword results a few hundred milliseconds later instead of
 *      hanging.
 *   3. FAILURES BACK OFF. Repeated errors trip a breaker for a few minutes,
 *      so a wrong key or an exhausted quota costs one slow search, not one
 *      slow search per keystroke.
 *
 * On quota: this uses the EMBEDDING model, which on the free tier has its own
 * allowance, separate from the generate-content allowance that gemini-3.7-flash
 * spends on chat and summaries. Documents are embedded once, at upload, and
 * stored; a search costs at most one (cached) embedding of the query itself.
 */
// From geminiClient, NOT from aiService: this module wants the HTTP client,
// not the chat service, and depending on the latter made every test that
// stubs out chat also stub out search.
import { geminiClient, clientReady, isAiConfigured } from './geminiClient.js';

const MODEL = (process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001').trim();

// 768 is the sweet spot for a library this size: a quarter of the storage of
// the 3072-dimension default, with retrieval quality that is nearly identical.
const DIMENSIONS = Math.max(64, parseInt(process.env.GEMINI_EMBEDDING_DIM || '768', 10));

// 'off' disables the whole feature; anything else leaves it on when a key exists.
const SETTING = (process.env.SEARCH_EMBEDDINGS || 'auto').trim().toLowerCase();

// A search may spend this long waiting for the query vector before giving up
// and answering with keyword results alone.
const QUERY_TIMEOUT_MS = parseInt(process.env.SEARCH_EMBEDDING_TIMEOUT_MS || '4000', 10);

// Indexing a document is a background job, so it can afford to wait longer.
const DOCUMENT_TIMEOUT_MS = parseInt(process.env.SEARCH_EMBEDDING_INDEX_TIMEOUT_MS || '30000', 10);

const BREAKER_FAILURES = 3;
const BREAKER_HOLD_MS = parseInt(process.env.SEARCH_EMBEDDING_HOLD_MS || '600000', 10);

const QUERY_CACHE_MAX = 300;
const QUERY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export const embeddingModelName = () => MODEL;
export const embeddingDimensions = () => DIMENSIONS;

/** Whether embeddings should be attempted at all. */
export function isEmbeddingEnabled() {
    return SETTING !== 'off' && isAiConfigured && Boolean(geminiClient());
}

/** First meaningful line of an error, for a one-line log. */
function firstLine(text) {
    return String(text || '').split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 200) || '';
}

// --- failure breaker -----------------------------------------------------

let consecutiveFailures = 0;
let breakerUntil = 0;
let lastError = null;

function breakerOpen() {
    return Date.now() < breakerUntil;
}

function noteFailure(error) {
    consecutiveFailures += 1;
    lastError = firstLine(error?.message || String(error)) || 'unknown error';
    if (consecutiveFailures >= BREAKER_FAILURES) {
        breakerUntil = Date.now() + BREAKER_HOLD_MS;
        console.warn(
            `[search] Embeddings paused for ${Math.round(BREAKER_HOLD_MS / 60000)} minutes after ` +
            `${consecutiveFailures} failures. Last error: ${lastError}. ` +
            'Keyword search continues to work.'
        );
    }
}

function noteSuccess() {
    consecutiveFailures = 0;
    breakerUntil = 0;
}

/** For /api/ai/health and `npm run diagnose`. */
export function embeddingHealth() {
    return {
        enabled: isEmbeddingEnabled(),
        model: MODEL,
        dimensions: DIMENSIONS,
        consecutiveFailures,
        pausedForMs: breakerOpen() ? breakerUntil - Date.now() : 0,
        lastError
    };
}

// --- vector maths --------------------------------------------------------

/**
 * Scale a vector to unit length, so cosine similarity is a plain dot product.
 * The API returns normalised vectors at full dimensionality but NOT when a
 * smaller outputDimensionality is requested - a detail that silently skews
 * every comparison if it is missed.
 * @param {number[]} vector
 * @returns {number[]}
 */
export function normalizeVector(vector) {
    let sum = 0;
    for (const value of vector) sum += value * value;
    const length = Math.sqrt(sum);
    if (!length || !Number.isFinite(length)) return vector.map(() => 0);
    return vector.map((value) => value / length);
}

/**
 * Cosine similarity of two unit vectors, clamped to [-1, 1].
 * @returns {number} 1 = same direction, 0 = unrelated
 */
export function cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
    if (!Number.isFinite(dot)) return 0;
    return Math.min(1, Math.max(-1, dot));
}

/** Store a vector as compact JSON (6 decimals is well below the noise floor). */
export function packVector(vector) {
    return JSON.stringify(vector.map((value) => Number(value.toFixed(6))));
}

/** Read a stored vector back, returning null for anything unusable. */
export function unpackVector(stored) {
    if (!stored) return null;
    try {
        const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
        if (!Array.isArray(parsed) || parsed.length === 0) return null;
        return parsed.every((value) => typeof value === 'number' && Number.isFinite(value)) ? parsed : null;
    } catch {
        return null;
    }
}

// --- the API call --------------------------------------------------------

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Pull the vectors out of whatever shape the SDK hands back. The response has
 * been `{embeddings:[{values}]}` and `{embedding:{values}}` in different
 * versions; accepting both means an SDK bump cannot silently return nothing.
 */
function readVectors(response) {
    const raw = response?.embeddings
        ?? (response?.embedding ? [response.embedding] : null)
        ?? (Array.isArray(response) ? response : null);
    if (!Array.isArray(raw)) return null;
    const vectors = raw
        .map((entry) => entry?.values ?? entry?.value ?? entry)
        .filter((values) => Array.isArray(values) && values.length > 0)
        .map((values) => normalizeVector(values));
    return vectors.length ? vectors : null;
}

/**
 * Embed one or more texts. The only function here that throws - the exported
 * wrappers below catch for their callers.
 *
 * @param {string[]} texts
 * @param {'RETRIEVAL_QUERY'|'RETRIEVAL_DOCUMENT'} taskType
 *   Asymmetric retrieval: a question and the document that answers it are not
 *   the same kind of text, and telling the model which is which measurably
 *   improves the match.
 * @param {number} timeoutMs
 * @returns {Promise<number[][]>}
 */
async function embedTexts(texts, taskType, timeoutMs) {
    const client = geminiClient();
    if (!client) throw new Error('No Gemini client is configured.');
    await clientReady();

    const response = await withTimeout(
        client.models.embedContent({
            model: MODEL,
            contents: texts,
            config: { taskType, outputDimensionality: DIMENSIONS }
        }),
        timeoutMs,
        'embedContent'
    );

    const vectors = readVectors(response);
    if (!vectors || vectors.length !== texts.length) {
        throw new Error('The embedding response did not contain a vector for every input.');
    }
    return vectors;
}

// --- query embeddings (cached) -------------------------------------------

const queryCache = new Map(); // normalised query -> { vector, at }

function cacheGet(key) {
    const hit = queryCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > QUERY_CACHE_TTL_MS) { queryCache.delete(key); return null; }
    // Refresh insertion order so the map behaves as an LRU.
    queryCache.delete(key);
    queryCache.set(key, hit);
    return hit.vector;
}

function cacheSet(key, vector) {
    if (queryCache.size >= QUERY_CACHE_MAX) {
        queryCache.delete(queryCache.keys().next().value);
    }
    queryCache.set(key, { vector, at: Date.now() });
}

/** Clears the cache - used by tests. */
export function resetEmbeddingState() {
    queryCache.clear();
    consecutiveFailures = 0;
    breakerUntil = 0;
    lastError = null;
}

/**
 * The vector for a search query, or null if one cannot be had quickly.
 * Never throws; repeated searches for the same thing cost one API call.
 *
 * @param {string} query
 * @returns {Promise<number[]|null>}
 */
export async function embedQuery(query) {
    const key = String(query || '').trim().toLowerCase();
    if (!key || !isEmbeddingEnabled() || breakerOpen()) return null;

    const cached = cacheGet(key);
    if (cached) return cached;

    try {
        const [vector] = await embedTexts([key], 'RETRIEVAL_QUERY', QUERY_TIMEOUT_MS);
        noteSuccess();
        cacheSet(key, vector);
        return vector;
    } catch (error) {
        noteFailure(error);
        return null;
    }
}

/**
 * The vector for a file's text, or null. Used by the upload path and the
 * backfill script, both of which treat a null as "try again later".
 *
 * @param {string} text
 * @returns {Promise<number[]|null>}
 */
export async function embedDocument(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed || !isEmbeddingEnabled() || breakerOpen()) return null;
    try {
        // Well past the point where more text stops changing the vector, and
        // short enough to stay inside the model's input limit.
        const [vector] = await embedTexts([trimmed.slice(0, 8000)], 'RETRIEVAL_DOCUMENT', DOCUMENT_TIMEOUT_MS);
        noteSuccess();
        return vector;
    } catch (error) {
        noteFailure(error);
        return null;
    }
}

/**
 * Same as embedDocument but for a batch, so the backfill script makes one
 * request per batch instead of one per file. Returns an array with a null in
 * the position of anything that could not be embedded.
 *
 * @param {string[]} texts
 * @returns {Promise<Array<number[]|null>>}
 */
export async function embedDocuments(texts) {
    if (!texts.length || !isEmbeddingEnabled() || breakerOpen()) return texts.map(() => null);
    try {
        const vectors = await embedTexts(
            texts.map((text) => String(text || ' ').slice(0, 8000)),
            'RETRIEVAL_DOCUMENT',
            DOCUMENT_TIMEOUT_MS
        );
        noteSuccess();
        return vectors;
    } catch (error) {
        noteFailure(error);
        return texts.map(() => null);
    }
}

/**
 * The text that represents a file to the embedding model. Title first (it is
 * the strongest signal), then category, then the description with its AI
 * keyword tail - the same material the keyword search reads, so the two
 * layers are ranking the same thing by different means.
 *
 * @param {{title?:string, category?:string, description?:string}} file
 * @returns {string}
 */
export function documentTextFor(file) {
    return [
        file?.title || '',
        file?.category ? `Category: ${file.category}` : '',
        file?.description || ''
    ].filter(Boolean).join('\n');
}

export default {
    isEmbeddingEnabled, embedQuery, embedDocument, embedDocuments, documentTextFor,
    cosine, packVector, unpackVector, normalizeVector, embeddingModelName,
    embeddingDimensions, embeddingHealth, resetEmbeddingState
};
